import { Injectable, Logger } from '@nestjs/common';
import { chatJson, resolveLlmConfig, LlmConfig } from '../../knowledge-graph/llm-client';
import { redactPii } from '../../knowledge-graph/redact';
import { LibredeskClient } from './libredesk.client';
import { supportTriageConfig } from './support-config';
import { redactSecrets } from './support-redact';

export const TRIAGE_CATEGORIES = [
  'connector-setup',
  'connector-error',
  'new-connector-request',
  'billing',
  'account',
  'bug',
  'feature-request',
  'enterprise-sales',
  'other',
] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

const PRIORITIES = ['Low', 'Medium', 'High'] as const;
type Priority = (typeof PRIORITIES)[number];

export interface TriageResult {
  category: TriageCategory;
  priority: Priority;
  language: string;
  summary: string;
  suggestedReply: string;
}

/** The subset of a Libredesk conversation the triage reads. */
export interface DeskConversation {
  uuid: string;
  subject?: string | null;
  last_message?: string | null;
  inbox_channel?: string;
  tags?: string[] | null;
  contact?: {
    first_name?: string;
    email?: string | null;
    external_user_id?: string | null;
    custom_attributes?: Record<string, unknown> | null;
  };
}

const MAX_CUSTOMER_TEXT = 4_000;
const SEEN_MAX = 2_000;

const SYSTEM_PROMPT = `You triage support conversations for AnythingMCP, a product that turns any API, database or business app into an MCP server so that Claude, ChatGPT, Cursor and other AI assistants can use it. Customers install "connectors" (from a catalog of several hundred apps, or their own REST/GraphQL/SOAP/database), then connect their AI assistant to their MCP server URL. It is sold as AnythingMCP Cloud (cloud.anythingmcp.com, 7-day trial, then a paid plan) and as dedicated instances for enterprise customers.

Typical problems: OAuth apps whose redirect URI is not set to <instance URL>/api/mcp-oauth/callback; API keys pasted in the wrong field or with spaces; expired or revoked tokens ("needs_reauth"); the AI client not connected to the MCP URL; trial ended; plan or invoice questions; requests for a connector we do not have yet.

You receive the customer's messages and a snapshot of their workspace (plan, trial end, connectors, connector issues of the last 24 hours). Return ONLY a JSON object:
{
  "category": one of ${TRIAGE_CATEGORIES.map((c) => `"${c}"`).join(', ')},
  "priority": "Low" | "Medium" | "High",
  "language": ISO 639-1 code of the customer's language,
  "summary": one or two sentences in English for the support agent, naming the likely cause when the workspace snapshot shows it,
  "suggested_reply": a reply draft for a human agent to review, in the customer's language
}

Priority: High when the customer cannot use the product at all, for billing problems, and for enterprise customers; Low for feature and connector requests; otherwise Medium.

Rules for suggested_reply: short, friendly, concrete next steps; use the workspace snapshot when it explains the problem; never promise refunds, cancellations, discounts, deadlines or features; never offer a call or meeting; for billing write that a person will check and reply; do not invent settings or URLs you are not sure of; no em dashes.`;

/**
 * Tags, prioritises and annotates every new support conversation. Runs only
 * on the instance that holds the Libredesk API key (Cloud). The suggested
 * reply goes into a private note: nothing is sent to the customer.
 */
@Injectable()
export class SupportTriageService {
  private readonly logger = new Logger(SupportTriageService.name);
  private readonly seen = new Set<string>();
  private teamIds: Map<string, number> | null = null;

  /** Test seam. */
  protected client(): LibredeskClient | null {
    const cfg = supportTriageConfig();
    return cfg ? new LibredeskClient(cfg) : null;
  }

  protected llm(): LlmConfig | null {
    return resolveLlmConfig();
  }

  async triage(conv: DeskConversation): Promise<TriageResult | null> {
    if (!conv?.uuid || this.seen.has(conv.uuid)) return null;
    if ((conv.tags ?? []).includes('ai-triaged')) return null;
    this.remember(conv.uuid);

    const desk = this.client();
    if (!desk) return null;

    const attrs = normaliseAttrs(conv.contact?.custom_attributes);
    let customerText = '';
    try {
      const messages = await desk.incomingMessages(conv.uuid);
      customerText = messages
        .filter((m) => !m.private && m.sender_type === 'contact')
        .map((m) => (m.text_content || '').trim())
        .filter(Boolean)
        .join('\n---\n');
    } catch (err) {
      this.logger.warn(`Could not read messages of ${conv.uuid}: ${(err as Error).message}`);
    }
    if (!customerText) customerText = (conv.last_message || conv.subject || '').trim();

    const result = (await this.classify(customerText, attrs, conv.inbox_channel)) ?? fallbackTriage(attrs);
    await this.apply(desk, conv.uuid, result, attrs);
    return result;
  }

  private async classify(
    customerText: string,
    attrs: Record<string, string>,
    channel?: string,
  ): Promise<TriageResult | null> {
    const cfg = this.llm();
    if (!cfg || !customerText) return null;
    const snapshot = { ...attrs };
    delete snapshot.organization_id;
    const user = [
      `Channel: ${channel || 'unknown'}`,
      `Workspace snapshot: ${JSON.stringify(snapshot)}`,
      'Customer messages:',
      redactPii(redactSecrets(customerText)).slice(0, MAX_CUSTOMER_TEXT),
    ].join('\n');
    try {
      const { json, skipped } = await chatJson(cfg, SYSTEM_PROMPT, user, 1200);
      if (skipped || !json) return null;
      return parseTriage(json, attrs);
    } catch (err) {
      this.logger.warn(`Support triage LLM call failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async apply(desk: LibredeskClient, uuid: string, r: TriageResult, attrs: Record<string, string>) {
    const enterprise = isEnterprise(attrs);
    const tags = [r.category, ...segmentTags(attrs), 'ai-triaged'];
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['tags', () => desk.addTags(uuid, tags)],
      ['priority', () => desk.setPriority(uuid, r.priority)],
      ['team', async () => {
        const id = await this.teamId(desk, enterprise ? 'Enterprise' : 'Support');
        if (id) await desk.assignTeam(uuid, id);
      }],
      ['note', () => desk.addPrivateNote(uuid, triageNote(r, attrs))],
    ];
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        this.logger.warn(`Support triage step "${name}" failed for ${uuid}: ${(err as Error).message}`);
      }
    }
  }

  private async teamId(desk: LibredeskClient, name: string): Promise<number | undefined> {
    if (!this.teamIds) {
      const teams = await desk.teams();
      this.teamIds = new Map(teams.map((t) => [t.name, t.id]));
    }
    return this.teamIds.get(name);
  }

  private remember(uuid: string) {
    if (this.seen.size >= SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(uuid);
  }
}

/** The contact attributes SupportIdentityService sets; anything else is ignored. */
const KNOWN_ATTRS = [
  'organization_id',
  'organization_name',
  'instance',
  'deployment',
  'plan',
  'license_status',
  'trial_ends_at',
  'role',
  'connectors',
  'connector_issues',
  'signed_up_at',
  'email_verified',
] as const;

export function normaliseAttrs(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of KNOWN_ATTRS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (v === null || v === undefined) continue;
    out[key] = (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 1000);
  }
  return out;
}

export function isEnterprise(attrs: Record<string, string>): boolean {
  return attrs.deployment === 'dedicated' || /enterprise/i.test(attrs.plan || '');
}

export function segmentTags(attrs: Record<string, string>): string[] {
  const tags: string[] = [];
  if (attrs.deployment === 'cloud') tags.push('cloud');
  if (attrs.deployment === 'dedicated') tags.push('self-hosted');
  if (isEnterprise(attrs)) tags.push('enterprise');
  const plan = (attrs.plan || '').toLowerCase();
  if (plan === 'trial') tags.push('trial');
  else if (plan && plan !== 'none' && plan !== 'community') tags.push('paid');
  return tags;
}

export function parseTriage(json: any, attrs: Record<string, string>): TriageResult | null {
  if (!json || typeof json !== 'object') return null;
  const category = (TRIAGE_CATEGORIES as readonly string[]).includes(json.category)
    ? (json.category as TriageCategory)
    : 'other';
  let priority: Priority = (PRIORITIES as readonly string[]).includes(json.priority)
    ? (json.priority as Priority)
    : 'Medium';
  if (category === 'billing' || isEnterprise(attrs)) priority = 'High';
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    category,
    priority,
    language: str(json.language, 8) || 'en',
    summary: str(json.summary, 600),
    suggestedReply: str(json.suggested_reply, 3000),
  };
}

/** Used when no LLM is configured or the call failed: segment + priority only. */
export function fallbackTriage(attrs: Record<string, string>): TriageResult {
  return {
    category: 'other',
    priority: isEnterprise(attrs) ? 'High' : 'Medium',
    language: '',
    summary: '',
    suggestedReply: '',
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function triageNote(r: TriageResult, attrs: Record<string, string>): string {
  const ctx = [
    ['Instance', attrs.instance],
    ['Organization', attrs.organization_name],
    ['Plan', [attrs.plan, attrs.license_status].filter(Boolean).join(', ')],
    ['Trial ends', attrs.trial_ends_at],
    ['Connectors', attrs.connectors],
    ['Connector issues', attrs.connector_issues],
    ['Email verified', attrs.email_verified],
  ].filter(([, v]) => v);
  const parts = [
    `<p><strong>AI triage</strong>: ${esc(r.category)}, priority ${esc(r.priority)}${r.language ? `, language ${esc(r.language)}` : ''}</p>`,
  ];
  if (r.summary) parts.push(`<p>${esc(r.summary)}</p>`);
  if (ctx.length) {
    parts.push(`<ul>${ctx.map(([k, v]) => `<li><strong>${esc(k)}</strong>: ${esc(String(v))}</li>`).join('')}</ul>`);
  }
  if (r.suggestedReply) {
    parts.push('<p><strong>Suggested reply</strong> (review before sending):</p>');
    parts.push(`<blockquote>${esc(r.suggestedReply).replace(/\n/g, '<br>')}</blockquote>`);
  }
  return parts.join('');
}
