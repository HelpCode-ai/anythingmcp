import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma.service';
import { AdaptersService } from '../../adapters/adapters.service';
import { listAdapters } from '../../adapters/catalog';
import { ConnectorSetupService } from '../../adapters/connector-setup.service';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../../adapters/env-var-meta';
import { normalizeAdapterEnvValue } from '../../adapters/env-var-checks';
import { fileSearchSetupPath } from '../../adapters/file-search-setup';
import { isExcludedAdapterSlug } from '../../mcp-server/shared-toolset';
import { LicenseGuardService } from '../../license/license-guard.service';
import { McpServersService } from '../../mcp-servers/mcp-servers.service';
import { ConnectorsController } from '../../connectors/connectors.controller';
import { EmailService } from '../../settings/email.service';
import { SecurityEventService, SecurityEvents } from '../../audit/security-event.service';
import { ProductEventService, ProductEvents } from '../../audit/product-event.service';
import { LibredeskClient, LibredeskMessage } from './libredesk.client';
import { instanceHost, supportTriageConfig } from './support-config';
import { compactError } from './support-redact';
import { TELEGRAM_SLUG } from './support-telegram-setup.service';

/** Installs from the support chat per workspace in a day (per instance, in memory). */
const INSTALLS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60_000;
/** A pasted secret shorter than this is not looked up in the chat: too easy to match by chance. */
const MIN_SECRET_LENGTH = 8;

/** The headers Libredesk sets on every custom-tool request (internal/ai/tools.go), never the model. */
export interface DeskToolIdentity {
  externalUserId?: string;
  contactType?: string;
  conversationUuid?: string;
}

export interface DeskToolArgs {
  /** Catalog slug (from the knowledge base entry "Connector setup: <app>") or the app's name. */
  app?: unknown;
  /** Values the customer posted in this chat, by variable name. */
  values?: unknown;
}

/** What the desk's AI assistant gets back: it writes the reply to the customer from it. */
export type DeskToolAnswer = Record<string, unknown>;

/**
 * Sets up a catalog connector for the customer of a support chat, when the
 * desk's AI assistant calls our custom tool (Libredesk `ai_tools`, POST to
 * /api/support/desk-tools/connector). Cloud only, like the Telegram setup.
 *
 * Who: the contact Libredesk resolved from the widget JWT our backend signed
 * (`external_user_id = <host>:<userId>`). Libredesk sends it in its own
 * headers, outside what the model can write; it is checked again against the
 * conversation, and then in our database: email verified, exactly one
 * workspace, role ADMIN or EDITOR.
 *
 * Values: the customer may paste keys in the chat (Matteo, 2026-11-10: use
 * them as with Telegram). The model names them by variable; each secret is
 * taken only if the customer's own messages in this conversation contain it
 * word for word, so the model cannot invent one or bring one in from
 * elsewhere. They are tried with the setup page's check before anything is
 * stored, and never echoed back.
 *
 * Never: a second connector of an app the workspace has set up (it gets the
 * link to the one it has), new values over a working connector, an adapter
 * outside the catalog. Every install is a security event; one made with
 * pasted values is emailed to the user and the workspace admins.
 */
@Injectable()
export class SupportConnectorSetupService {
  private readonly logger = new Logger(SupportConnectorSetupService.name);
  private readonly installs = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly setup: ConnectorSetupService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly mcpServers: McpServersService,
    private readonly email: EmailService,
    private readonly securityEvents: SecurityEventService,
    private readonly productEvents: ProductEventService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Test seams. */
  protected client(): LibredeskClient | null {
    const cfg = supportTriageConfig();
    return cfg ? new LibredeskClient(cfg) : null;
  }

  protected host(): string {
    return instanceHost();
  }

  protected dashboardBase(): string {
    return (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  }

  /**
   * Store values on an existing connector exactly as the connector page does
   * (PUT /api/connectors/:id/env-vars: masked-secret merge, address checks,
   * rebuilt credentials, tool reload).
   */
  protected async saveValues(
    connectorId: string,
    user: { id: string; organizationId: string; role: string },
    values: Record<string, string>,
  ): Promise<void> {
    const controller = this.moduleRef.get(ConnectorsController, { strict: false });
    await controller.updateEnvVars(
      { user: { sub: user.id, organizationId: user.organizationId, role: user.role } },
      connectorId,
      { envVars: values } as any,
    );
  }

  async handle(identity: DeskToolIdentity, args: DeskToolArgs): Promise<DeskToolAnswer> {
    const desk = this.client();
    if (!desk) return { error: 'Setting up connectors from this chat is not available.' };

    // ── Who: the verified contact of this live-chat conversation ──────────
    const conversationUuid = (identity.conversationUuid || '').trim();
    const external = (identity.externalUserId || '').trim();
    const prefix = `${this.host()}:`;
    if (!conversationUuid || identity.contactType !== 'contact' || !external.startsWith(prefix)) {
      return { error: 'This customer is not signed in to AnythingMCP Cloud, so nothing can be set up from here.' };
    }
    const conv = await desk.conversation(conversationUuid);
    const contact = conv?.contact;
    if (!conv || conv.inbox_channel !== 'livechat' || !contact || contact.type !== 'contact') {
      return { error: 'This conversation cannot set up connectors.' };
    }
    if ((contact.external_user_id || '') !== external) {
      return { error: 'This conversation cannot set up connectors.' };
    }
    const userId = external.slice(prefix.length);

    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            emailVerified: true,
            memberships: {
              where: { deactivatedAt: null },
              select: { organizationId: true, role: true, organization: { select: { name: true } } },
            },
          },
        })
      : null;
    if (!user) return { error: 'This customer has no AnythingMCP account.' };
    if (!user.emailVerified) {
      return { error: 'The customer has not confirmed their email address yet. They need to do that first (link in the email we sent), then ask again.' };
    }
    if (user.memberships.length !== 1) {
      return {
        error:
          user.memberships.length === 0
            ? 'The customer has no workspace.'
            : 'The customer belongs to several workspaces, so it is unclear which one should get the connector. Give them the setup page; they open it in the workspace they want.',
      };
    }
    const membership = user.memberships[0];
    const organizationId = membership.organizationId;
    const workspaceName = membership.organization?.name || 'your workspace';
    if (membership.role !== 'ADMIN' && membership.role !== 'EDITOR') {
      return { error: `The customer's role in ${workspaceName} cannot add connectors. An admin or editor of the workspace can.` };
    }

    // ── What: a catalog adapter ────────────────────────────────────────────
    const slug = this.resolveSlug(args.app);
    if (!slug) {
      return { error: `No catalog connector '${String(args.app ?? '').slice(0, 80)}'. Use the slug from the knowledge base entry "Connector setup: <app>".` };
    }
    const definition = this.adapters.describe(slug);
    const setupUrl = `${this.dashboardBase()}/connectors/setup/${encodeURIComponent(slug)}`;
    const wizardPath = fileSearchSetupPath(definition, 'chat');
    if (wizardPath) {
      return {
        error: `${definition.name} is set up in the File Search wizard, not from the chat.`,
        setupUrl: `${this.dashboardBase()}${wizardPath}`,
      };
    }

    // ── Values: only what this customer posted here ────────────────────────
    const descriptors = new Map(describeAdapterEnvVars(definition).map((d) => [d.name, d]));
    const posted = await this.postedTexts(desk, conversationUuid, contact.id);
    // Collected in a Map and turned into an object once: the keys are the
    // adapter's own variable names, never a name the model wrote.
    const accepted = new Map<string, string>();
    const rawValues = args.values && typeof args.values === 'object' ? (args.values as Record<string, unknown>) : {};
    // The model may name a value by its label ("API key") rather than its variable.
    const byLabel = new Map<string, string>();
    for (const d of descriptors.values()) {
      byLabel.set(compact(d.name), d.name);
      if (d.label) byLabel.set(compact(d.label), d.name);
    }
    for (const [given, raw] of Object.entries(rawValues)) {
      const name = descriptors.has(given) ? given : (byLabel.get(compact(given)) ?? given);
      const d = descriptors.get(name);
      if (!d) {
        return {
          error: `'${given}' is not a setting of ${definition.name}.`,
          settings: [...descriptors.values()].map((x) => ({ name: x.name, label: x.label, required: x.required, secret: x.secret })),
        };
      }
      const typed = typeof raw === 'string' ? raw.trim() : '';
      if (!typed) continue;
      if (d.secret || d.kind === 'credential') {
        if (typed.length < MIN_SECRET_LENGTH || !posted.some((t) => t.includes(typed))) {
          return {
            error: `The value for '${d.label}' is not in the customer's messages in this chat. Only values the customer pasted here, copied exactly, can be used.`,
          };
        }
      }
      accepted.set(d.name, normalizeAdapterEnvValue(d, typed));
    }
    const values: Record<string, string> = Object.fromEntries(accepted);
    const hasSecrets = Object.keys(values).some((n) => {
      const d = descriptors.get(n);
      return d?.secret || d?.kind === 'credential';
    });

    // A Telegram token is connected by the message webhook, with its own reply.
    if (slug === TELEGRAM_SLUG && hasSecrets) {
      return { handledAutomatically: true, tellTheUser: 'The bot is being connected; the confirmation follows in this chat within seconds.' };
    }

    // ── The workspace's connectors of this app ─────────────────────────────
    const existing = await this.prisma.connector.findMany({
      where: { organizationId, config: { path: ['adapterSlug'], equals: slug } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const ctx = { userId: user.id, organizationId, dashboardBase: this.dashboardBase(), assistant: null };
    const actor = { id: user.id, organizationId, role: membership.role };

    if (existing.length > 0) {
      const states = await Promise.all(existing.map(async (c) => ({ id: c.id, ...(await this.setup.connectorStatus(c.id)) })));
      const ready = states.find((s) => s.status === 'ready');
      // Only when none works yet: the oldest gets the values (like Telegram's empty connectors).
      const target = ready ?? states[0];
      if (!hasSecrets || ready) {
        const link = await this.setup.createLink(ctx, target.id);
        return {
          alreadyInstalled: definition.name,
          status: target.status,
          ...(ready && hasSecrets ? { valuesNotUsed: 'The workspace already has a working connector of this app; it was left as it is.' } : {}),
          finishSetupUrl: link,
          linkValidFor: '30 minutes, for this customer only',
          whatTheUserDoes: this.nextStep(definition, descriptors, target),
        };
      }
      const check = await this.adapters.verifyCredentials(slug, organizationId, values, target.id);
      if (check.ok === false) return this.refused(definition.name, check, values, setupUrl);
      if (!this.takeInstallSlot(organizationId)) return this.rateLimited(setupUrl);
      try {
        await this.saveValues(target.id, actor, values);
      } catch (err) {
        return { error: compactError(scrub((err as Error).message, values), 300), setupUrl };
      }
      return this.finish({
        desk,
        conversationUuid,
        user,
        organizationId,
        workspaceName,
        slug,
        definition,
        descriptors,
        connectorId: target.id,
        filled: true,
        withValues: true,
        ctx,
      });
    }

    // ── A new connector ────────────────────────────────────────────────────
    if (hasSecrets) {
      const check = await this.adapters.verifyCredentials(slug, organizationId, values);
      // A value still missing (the sign-in, a token the provider issues) is fine:
      // the setup link asks for it. A refused key is not stored.
      if (check.ok === false && check.kind !== 'invalid_input') return this.refused(definition.name, check, values, setupUrl);
    }
    try {
      await this.licenseGuard.checkCanCreateConnector(user.id, organizationId);
    } catch (err) {
      return { error: `The connector could not be added: ${compactError((err as Error).message, 300)}` };
    }
    if (!this.takeInstallSlot(organizationId)) return this.rateLimited(setupUrl);

    let connectorId: string;
    try {
      const imported = await this.adapters.importAdapter(slug, user.id, organizationId, values, { addressMayWait: true });
      connectorId = imported.connectorId;
    } catch (err) {
      return { error: compactError(scrub((err as Error).message, values), 300), setupUrl };
    }
    await this.mcpServers.attachToDefaultServer(user.id, organizationId, connectorId);
    return this.finish({
      desk,
      conversationUuid,
      user,
      organizationId,
      workspaceName,
      slug,
      definition,
      descriptors,
      connectorId,
      filled: false,
      withValues: hasSecrets,
      ctx,
    });
  }

  private async finish(p: {
    desk: LibredeskClient;
    conversationUuid: string;
    user: { id: string; email: string; name: string | null };
    organizationId: string;
    workspaceName: string;
    slug: string;
    definition: ReturnType<AdaptersService['describe']>;
    descriptors: Map<string, ReturnType<typeof describeAdapterEnvVars>[number]>;
    connectorId: string;
    filled: boolean;
    withValues: boolean;
    ctx: { userId: string; organizationId: string; dashboardBase: string; assistant: null };
  }): Promise<DeskToolAnswer> {
    const state = await this.setup.connectorStatus(p.connectorId);
    await this.securityEvents.log({
      event: SecurityEvents.CONNECTOR_INSTALLED_VIA_SUPPORT_CHAT,
      actorType: 'USER',
      actorUserId: p.user.id,
      organizationId: p.organizationId,
      metadata: {
        adapter: p.slug,
        connectorId: p.connectorId,
        conversation: p.conversationUuid,
        via: 'desk_assistant',
        withPastedValues: p.withValues,
        ...(p.filled ? { filledEmptyConnector: true } : {}),
      },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: p.user.id,
      organizationId: p.organizationId,
      metadata: {
        adapterSlug: p.slug,
        via: 'support_chat',
        verified: state.status === 'ready',
        ...(p.filled ? { filledEmptyConnector: true } : {}),
      },
    });
    this.logger.log(
      `${p.filled ? 'Filled' : 'Installed'} ${p.slug} (${p.connectorId}) for org ${p.organizationId} from support chat ${p.conversationUuid}`,
    );

    const connectorPath = `/connectors/${encodeURIComponent(p.connectorId)}`;
    if (p.withValues) {
      await this.notify(p.user, p.organizationId, p.workspaceName, p.definition.name, connectorPath);
    }
    if (state.status === 'ready') {
      return {
        done: true,
        connector: p.definition.name,
        workspace: p.workspaceName,
        connectorUrl: `${this.dashboardBase()}${connectorPath}`,
        tellTheUser: `${p.definition.name} is connected to ${p.workspaceName}. Open a new chat in your AI assistant and its tools are there.` +
          (p.withValues ? ' Since the key was posted in this chat, you can create a new one at the provider at any time and paste it on the connector page.' : ''),
      };
    }
    const link = await this.setup.createLink(p.ctx, p.connectorId);
    return {
      installed: p.definition.name,
      workspace: p.workspaceName,
      status: state.status,
      finishSetupUrl: link,
      linkValidFor: '30 minutes, for this customer only',
      whatTheUserDoes: this.nextStep(p.definition, p.descriptors, state),
    };
  }

  private nextStep(
    definition: ReturnType<AdaptersService['describe']>,
    descriptors: Map<string, ReturnType<typeof describeAdapterEnvVars>[number]>,
    state: { status: string; missing?: string[] },
  ): string {
    if (state.status === 'ready') return 'Nothing: it works. Open a new chat in the AI assistant to use it.';
    if (state.status === 'needs_authorization') {
      return `Open the link, then click "Authorize with Provider", sign in to ${definition.name} and approve.`;
    }
    const missing = (state.missing ?? []).map((m) => descriptors.get(m)?.label ?? m);
    return (
      `Open the link and enter ${missing.length ? missing.join(', ') : 'the missing values'}, then click "Check and save"` +
      (needsBrowserAuthorization(definition) ? `, then "Authorize with Provider" and sign in to ${definition.name}` : '') +
      '.'
    );
  }

  private refused(
    name: string,
    check: { kind?: string; message?: string },
    values: Record<string, string>,
    setupUrl: string,
  ): DeskToolAnswer {
    return {
      error: `${name} refused these values, so nothing was saved.`,
      reason: compactError(scrub(check.message || check.kind || 'refused', values), 300),
      whatTheUserDoes: 'Check the key (copied whole, from the right account) and paste it again here, or enter it on the setup page.',
      setupUrl,
    };
  }

  private rateLimited(setupUrl: string): DeskToolAnswer {
    return { error: `At most ${INSTALLS_PER_DAY} connectors a day can be set up from the support chat. The customer can add this one on the setup page.`, setupUrl };
  }

  /** A slug, or the name of a catalog app compared without spaces and case. */
  private resolveSlug(app: unknown): string | null {
    const raw = typeof app === 'string' ? app.trim() : '';
    if (!raw) return null;
    const usable = (slug: string) => !isExcludedAdapterSlug(slug, 'default');
    try {
      const slug = raw.toLowerCase();
      this.adapters.describe(slug);
      return usable(slug) ? slug : null;
    } catch {
      const want = compact(raw);
      const hit = listAdapters().find((a) => compact(a.name) === want || compact(a.slug) === want);
      return hit && usable(hit.slug) ? hit.slug : null;
    }
  }

  /** Plain texts of the messages this contact sent in the conversation. */
  private async postedTexts(desk: LibredeskClient, conversationUuid: string, contactId: number): Promise<string[]> {
    const messages: LibredeskMessage[] = await desk.incomingMessages(conversationUuid).catch(() => []);
    return messages
      .filter((m) => !m.private && m.sender_type === 'contact' && (m.sender_id === undefined || m.sender_id === contactId))
      .flatMap((m) => [m.text_content ?? '', decodeEntities(m.content ?? '')])
      .filter(Boolean);
  }

  private async notify(
    user: { id: string; email: string; name: string | null },
    organizationId: string,
    workspaceName: string,
    connectorName: string,
    connectorPath: string,
  ): Promise<void> {
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: { user: { select: { email: true, name: true } } },
    });
    const recipients = new Map<string, string | null>([[user.email.toLowerCase(), user.name]]);
    for (const a of admins) {
      if (a.user?.email && !recipients.has(a.user.email.toLowerCase())) recipients.set(a.user.email.toLowerCase(), a.user.name);
    }
    for (const [to, name] of recipients) {
      await this.email
        .sendConnectorAddedFromSupportEmail(
          to,
          { name, connectorName, account: connectorName, workspaceName, addedBy: user.email, connectorPath },
          organizationId,
        )
        .catch(() => false);
    }
  }

  private takeInstallSlot(organizationId: string, now = Date.now()): boolean {
    const recent = (this.installs.get(organizationId) ?? []).filter((t) => now - t < DAY_MS);
    if (recent.length >= INSTALLS_PER_DAY) {
      this.installs.set(organizationId, recent);
      return false;
    }
    recent.push(now);
    this.installs.set(organizationId, recent);
    return true;
  }
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The few entities Libredesk's HTML content uses around pasted text. */
function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A provider's message may quote what it was sent: never pass a posted value back. */
function scrub(text: string, values: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(values)) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}
