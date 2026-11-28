import { Injectable, Logger } from '@nestjs/common';
import { chatJson, resolveLlmConfig, LlmConfig } from '../../knowledge-graph/llm-client';
import { redactPii } from '../../knowledge-graph/redact';
import { catalogMentions, catalogMentionsLine } from './support-catalog';
import { LibredeskClient } from './libredesk.client';
import { supportTriageConfig } from './support-config';
import { redactSecrets } from './support-redact';

export const TRIAGE_CATEGORIES = [
  'connector-setup',
  'connector-error',
  'new-connector-request',
  'billing-question',
  'billing',
  'account',
  'bug',
  'feature-request',
  'enterprise-sales',
  'other',
] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/**
 * Categories the AI assistant may answer on its own, enterprise customers
 * included. Billing problems, bugs, feature requests and sales always go to
 * a person.
 */
export const AI_HANDLED_CATEGORIES: readonly TriageCategory[] = [
  'connector-setup',
  'connector-error',
  'new-connector-request',
  'account',
  'other',
];

/**
 * Billing how-to questions answered from the dashboard (where the invoices
 * are, invoices by email, card, plan change, cancelling). The assistant
 * answers them for Cloud self-service customers only: enterprise customers
 * are billed by contract, not through the Stripe portal.
 */
export const AI_HANDLED_SELF_SERVICE_CATEGORIES: readonly TriageCategory[] = ['billing-question'];

/**
 * The one public message a live chat gets when the triage sends it straight
 * to a person (billing problems, bugs, sales, enterprise billing questions):
 * without it the customer saw nothing until someone answered, sometimes for
 * hours. No promise about refunds, amounts or deadlines. Support hours from
 * the enterprise and partner support model: Monday to Friday, 9:00 to 17:00 CET.
 */
export const HUMAN_ROUTING_ACKS: Record<string, string> = {
  en: 'Thanks for your message. A person from our team will check it and reply here in this chat. Our support hours are Monday to Friday, 9:00 to 17:00 CET.',
  de: 'Danke für Ihre Nachricht. Eine Person aus unserem Team prüft sie und antwortet Ihnen hier im Chat. Unsere Supportzeiten sind Montag bis Freitag, 9 bis 17 Uhr MEZ.',
  it: 'Grazie per il messaggio. Una persona del nostro team lo controlla e ti risponde qui in chat. Il supporto è attivo dal lunedì al venerdì, dalle 9 alle 17 CET.',
  es: 'Gracias por tu mensaje. Una persona de nuestro equipo lo revisará y te responderá aquí en el chat. Nuestro horario de soporte es de lunes a viernes, de 9:00 a 17:00 CET.',
  fr: "Merci pour votre message. Une personne de notre équipe va l'examiner et vous répondra ici dans le chat. Notre support est disponible du lundi au vendredi, de 9 h à 17 h CET.",
  pt: 'Obrigado pela sua mensagem. Uma pessoa da nossa equipe vai analisá-la e responder aqui no chat. Nosso horário de suporte é de segunda a sexta, das 9h às 17h CET.',
  ru: 'Спасибо за сообщение. Сотрудник нашей команды проверит его и ответит вам здесь, в чате. Часы работы поддержки: с понедельника по пятницу, с 9:00 до 17:00 CET.',
  tr: 'Mesajınız için teşekkürler. Ekibimizden bir kişi inceleyip size burada, sohbette yanıt verecek. Destek saatlerimiz pazartesiden cumaya, 9:00-17:00 CET.',
};

/** The acknowledgement in the triage's language ("pt-BR" reads as "pt"), English otherwise. */
export function humanRoutingAck(language: string | null | undefined): string {
  const lang = (language || '').trim().toLowerCase().slice(0, 2);
  return HUMAN_ROUTING_ACKS[lang] ?? HUMAN_ROUTING_ACKS.en;
}

/** A reply the customer saw from an agent, a person or this API user. */
export function isPublicAgentReply(m: { private?: boolean; sender_type?: string; type?: string }): boolean {
  return !m.private && m.sender_type === 'agent' && m.type !== 'activity';
}

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

You receive the customer's messages, a snapshot of their workspace (plan, trial end, connectors and their names, connector issues of the last 24 hours, last_tool_call: the day of the latest successful tool call, "more than N days ago" or "not in the call history" when the workspace made successful calls that are no longer kept, or "never") and the catalog connectors the messages name. Return ONLY a JSON object:
{
  "category": one of ${TRIAGE_CATEGORIES.map((c) => `"${c}"`).join(', ')}; "billing-question" is a how-to question the dashboard answers (where to find or download an invoice, getting invoices by email, changing the card, upgrading, downgrading or cancelling the plan), "billing" is a problem a person must handle (refund, double or unexpected charge, failed or disputed payment, discount or price, correcting an invoice),
  "priority": "Low" | "Medium" | "High",
  "language": ISO 639-1 code of the customer's language,
  "summary": one or two sentences in English for the support agent, naming the likely cause when the workspace snapshot shows it,
  "suggested_reply": a reply draft for a human agent to review, in the customer's language
}

Priority: High when the customer cannot use the product at all, for billing problems, and for enterprise customers; Low for feature and connector requests; otherwise Medium.

Rules for suggested_reply: short, friendly, concrete next steps; use the workspace snapshot when it explains the problem; never promise refunds, cancellations, discounts, deadlines or features; never offer a call or meeting; for "billing" write that a person will check and reply; for "billing-question" give the dashboard path: invoices are under Settings → License → Manage subscription & billing → Invoice history, and the same License page has the "Invoices by email" switch; do not invent settings or URLs you are not sure of; no em dashes.

Facts to get right:
- When the catalog line names a connector, we have it: never write that we do not; point to its setup page. Only when it names none and the workspace has none may you say a person will check whether we support the app.
- Connectors installed but last_tool_call "never" means no AI assistant is connected yet: the next step is adding the MCP server URL to the assistant, e.g. in Claude Plugins (still called Customize on some plans) → Connectors → + Add → Add custom connector. Use the URL from mcp_server_urls when present (else the MCP Servers page); a connectors/setup link is never an MCP server URL.
- The redirect URI <instance URL>/api/mcp-oauth/callback is only for connectors that sign in with OAuth, entered in the provider's developer console. It is never used to connect an AI assistant, for API-key or bot-token connectors (Telegram, for example), or for webhooks.
- If the customer pasted a password, token or key, say once that it is now visible in the chat and should be revoked or regenerated, and that new ones go only into the connector page. Exception: a Telegram bot token (digits, a colon, then about 35 letters, digits, _ or -) is connected automatically from the chat and a confirmation is posted there; do not ask to revoke it.`;

/**
 * Tags, prioritises and annotates every new support conversation. Runs only
 * on the instance that holds the Libredesk API key (Cloud). The suggested
 * reply goes into a private note. The customer only gets a short
 * acknowledgement when a live chat goes straight to a person.
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

  protected aiAssistantUserId(): number | null {
    return supportTriageConfig()?.aiAssistantUserId ?? null;
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
    await this.apply(desk, conv.uuid, result, attrs, conv.inbox_channel);
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
      catalogMentionsLine(catalogMentions(customerText)),
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

  private async apply(
    desk: LibredeskClient,
    uuid: string,
    r: TriageResult,
    attrs: Record<string, string>,
    channel?: string,
  ) {
    const enterprise = isEnterprise(attrs);
    const assistant = this.aiAssistantUserId();
    const toAssistant = routeToAssistant(r, channel, assistant, attrs);
    const tags = [r.category, ...segmentTags(attrs), 'ai-triaged'];
    if (toAssistant) tags.push('ai-assistant');
    let teamId: number | undefined;
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['tags', () => desk.addTags(uuid, tags)],
      ['priority', () => desk.setPriority(uuid, r.priority)],
      // Team first: Libredesk clears the user assignee when the team changes.
      ['team', async () => {
        teamId = await this.teamId(desk, enterprise ? 'Enterprise' : 'Support');
        if (teamId) await desk.assignTeam(uuid, teamId);
      }],
      // Mentioning the Enterprise team notifies its members at once, even
      // when the assistant answers first.
      ['note', () => desk.addPrivateNote(uuid, triageNote(r, attrs), enterprise && teamId ? [{ type: 'team', id: teamId }] : [])],
    ];
    if (toAssistant && assistant) {
      // Assigning the assistant starts its reply; it hands back to the
      // Support team when it cannot help.
      steps.push(['assistant', () => desk.assignUser(uuid, assistant)]);
    } else if (channel === 'livechat') {
      // Nobody answers until a person does: tell the customer so, once.
      steps.push(['acknowledgement', () => this.acknowledge(desk, uuid, r.language)]);
    }
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        this.logger.warn(`Support triage step "${name}" failed for ${uuid}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Posts the human-routing acknowledgement unless the chat already shows a
   * public agent reply: a person was faster, or an earlier run posted it
   * (triage() itself runs once per conversation: in-memory set plus the
   * ai-triaged tag). When the messages cannot be read, nothing is posted
   * rather than risk a second copy.
   */
  private async acknowledge(desk: LibredeskClient, uuid: string, language: string): Promise<boolean> {
    const messages = await desk.messages(uuid);
    if (messages.some(isPublicAgentReply)) return false;
    await desk.reply(uuid, `<p>${humanRoutingAck(language)}</p>`);
    return true;
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
  'connector_names',
  'connector_links',
  'mcp_server_urls',
  'connector_issues',
  'last_tool_call',
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

/** Live chat in a category the assistant handles. */
export function routeToAssistant(
  r: TriageResult,
  channel: string | undefined,
  assistantUserId: number | null,
  attrs: Record<string, string> = {},
): boolean {
  if (!assistantUserId || channel !== 'livechat') return false;
  if (AI_HANDLED_CATEGORIES.includes(r.category)) return true;
  return AI_HANDLED_SELF_SERVICE_CATEGORIES.includes(r.category) && !isEnterprise(attrs);
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
    ['Connectors', [attrs.connectors, attrs.connector_names].filter(Boolean).join(': ')],
    ['Connector issues', attrs.connector_issues],
    ['Connector links', attrs.connector_links],
    ['MCP server URL', attrs.mcp_server_urls],
    ['Last AI tool call', attrs.last_tool_call],
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
