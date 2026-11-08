import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AdaptersService } from '../../adapters/adapters.service';
import { LicenseGuardService } from '../../license/license-guard.service';
import { McpServersService } from '../../mcp-servers/mcp-servers.service';
import { EmailService } from '../../settings/email.service';
import { SecurityEventService, SecurityEvents } from '../../audit/security-event.service';
import { ProductEventService, ProductEvents } from '../../audit/product-event.service';
import { LibredeskClient } from './libredesk.client';
import { instanceHost, supportTriageConfig } from './support-config';
import { compactError } from './support-redact';

export const TELEGRAM_SLUG = 'telegram-bot';
/** Set on a conversation once a connector was installed from it: one per conversation. */
export const AUTO_SETUP_TAG = 'telegram-auto-setup';
/** Installs from the support chat per workspace in a day (per instance, in memory). */
const INSTALLS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
const TELEGRAM_TIMEOUT_MS = 10_000;
const SEEN_MAX = 2_000;

/** A `message.created` payload from Libredesk (internal/conversation/models Message). */
export interface DeskMessage {
  uuid: string;
  type?: string;
  private?: boolean;
  sender_id?: number;
  sender_type?: string;
  conversation_uuid?: string;
  text_content?: string | null;
  content?: string | null;
}

/**
 * Telegram bot token: the bot's numeric id, a colon, and a secret part of
 * 35 characters (the catalog's pattern accepts 30 and more).
 */
const TOKEN_RE = /(?<![A-Za-z0-9_:-])(\d{5,15}):([A-Za-z0-9_-]{30,64})(?![A-Za-z0-9_-])/g;

/** The distinct Telegram bot tokens in a text. */
export function findTelegramTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) found.add(`${m[1]}:${m[2]}`);
  return [...found];
}

type Outcome =
  | 'ignored'
  | 'installed'
  | 'already_has_telegram'
  | 'several_workspaces'
  | 'no_workspace'
  | 'viewer'
  | 'email_unverified'
  | 'invalid_token'
  | 'telegram_unreachable'
  | 'plan_limit'
  | 'rate_limited'
  | 'failed';

/**
 * Installs the Telegram Bot connector for a customer who pasted a bot token
 * in the support chat (Cloud only: it runs where the Libredesk webhook is
 * configured). The person is the verified widget identity, never what the
 * message says: Libredesk resolves the contact from the JWT our backend
 * signed (`external_user_id = <host>:<userId>`), and the message must come
 * from that contact. Then, re-checked in our database at the time of the
 * install: the user's email is verified, they belong to exactly one
 * workspace, and their role there may create connectors.
 *
 * What it never does: replace the token of an existing connector, install a
 * second Telegram connector, or act on a visitor, an agent or a private note.
 * Every install is a security event and is emailed to the user and to the
 * workspace admins, so one nobody asked for is noticed.
 */
@Injectable()
export class SupportTelegramSetupService {
  private readonly logger = new Logger(SupportTelegramSetupService.name);
  private readonly seen = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly installs = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly mcpServers: McpServersService,
    private readonly email: EmailService,
    private readonly securityEvents: SecurityEventService,
    private readonly productEvents: ProductEventService,
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

  protected fetchImpl(): typeof fetch {
    return fetch;
  }

  async handleMessage(msg: DeskMessage): Promise<Outcome> {
    if (!msg?.uuid || !msg.conversation_uuid) return 'ignored';
    if (msg.private || msg.sender_type !== 'contact' || msg.type !== 'incoming') return 'ignored';
    const tokens = findTelegramTokens(msg.text_content || stripTags(msg.content));
    // None, or several bots at once: nothing to decide for the customer.
    if (tokens.length !== 1) return 'ignored';
    if (this.seen.has(msg.uuid) || this.busy.has(msg.conversation_uuid)) return 'ignored';
    this.remember(msg.uuid);

    const desk = this.client();
    if (!desk) return 'ignored';

    this.busy.add(msg.conversation_uuid);
    try {
      return await this.setUp(desk, msg, tokens[0]);
    } catch (err) {
      this.logger.warn(`Telegram setup from support chat ${msg.conversation_uuid} failed: ${compactError((err as Error).message)}`);
      return 'failed';
    } finally {
      this.busy.delete(msg.conversation_uuid);
    }
  }

  private async setUp(desk: LibredeskClient, msg: DeskMessage, token: string): Promise<Outcome> {
    const conversationUuid = msg.conversation_uuid!;

    // ── Who: the verified contact of this live-chat conversation ──────────
    const conv = await desk.conversation(conversationUuid);
    const contact = conv?.contact;
    if (!conv || conv.inbox_channel !== 'livechat' || !contact) return 'ignored';
    if (contact.type !== 'contact' || contact.id !== msg.sender_id) return 'ignored';
    const prefix = `${this.host()}:`;
    const external = contact.external_user_id || '';
    if (!external.startsWith(prefix)) return 'ignored';
    const userId = external.slice(prefix.length);
    if (!userId) return 'ignored';
    if ((conv.tags ?? []).includes(AUTO_SETUP_TAG)) return 'ignored';

    const user = await this.prisma.user.findUnique({
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
    });
    if (!user) return 'ignored';

    const setupUrl = `${this.dashboardBase()}/connectors/setup/${TELEGRAM_SLUG}`;
    const say = (html: string) => desk.reply(conversationUuid, html);

    if (!user.emailVerified) {
      await say(
        `<p>Before I can add a connector for you, please confirm your email address with the link we sent to ${esc(user.email)}. Then send the bot token again.</p>`,
      );
      return 'email_unverified';
    }
    if (user.memberships.length === 0) return 'no_workspace';
    if (user.memberships.length > 1) {
      await say(
        `<p>You belong to several workspaces, so I cannot tell which one should get this bot. Open <a href="${esc(setupUrl)}">${esc(setupUrl)}</a> in the workspace you want and paste the token there.</p>`,
      );
      return 'several_workspaces';
    }
    const membership = user.memberships[0];
    const organizationId = membership.organizationId;
    const workspaceName = membership.organization?.name || 'your workspace';
    if (membership.role !== 'ADMIN' && membership.role !== 'EDITOR') {
      await say(
        `<p>Your role in ${esc(workspaceName)} can't add connectors. An admin or editor of the workspace can add it at <a href="${esc(setupUrl)}">${esc(setupUrl)}</a>.</p>`,
      );
      return 'viewer';
    }

    // ── Never replace or duplicate: one Telegram connector, added by hand after ──
    const existing = await this.prisma.connector.findFirst({
      where: { organizationId, config: { path: ['adapterSlug'], equals: TELEGRAM_SLUG } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      const link = `${setupUrl}?connector=${encodeURIComponent(existing.id)}`;
      await say(
        `<p>${esc(workspaceName)} already has a Telegram connector, so I did not add another one. To use this bot there, open <a href="${esc(link)}">${esc(link)}</a> and replace the token.</p>`,
      );
      return 'already_has_telegram';
    }

    // ── The token works: ask Telegram which bot it is ─────────────────────
    const bot = await this.getMe(token);
    if (bot.kind === 'invalid') {
      const hints = this.adapters.getBySlug(TELEGRAM_SLUG).verifyHints ?? {};
      const raw = hints[String(bot.status)] ?? hints['401'];
      const hint = (typeof raw === 'string' ? raw : raw?.hint) || 'Telegram did not accept this token.';
      await say(`<p>${esc(hint)}</p>`);
      return 'invalid_token';
    }
    if (bot.kind === 'unreachable') {
      await say(
        `<p>I could not reach Telegram to check the token just now. Please paste it at <a href="${esc(setupUrl)}">${esc(setupUrl)}</a>.</p>`,
      );
      return 'telegram_unreachable';
    }

    try {
      await this.licenseGuard.checkCanCreateConnector(user.id, organizationId);
    } catch (err) {
      await say(`<p>I could not add the connector: ${esc(compactError((err as Error).message, 300))}</p>`);
      return 'plan_limit';
    }

    if (!this.takeInstallSlot(organizationId)) {
      await say(`<p>Please add this one yourself at <a href="${esc(setupUrl)}">${esc(setupUrl)}</a>: it takes a minute.</p>`);
      return 'rate_limited';
    }

    // ── Install, as the dashboard does ────────────────────────────────────
    const imported = await this.adapters.importAdapter(TELEGRAM_SLUG, user.id, organizationId, {
      TELEGRAM_BOT_TOKEN: token,
    });
    const server = await this.mcpServers.attachToDefaultServer(user.id, organizationId, imported.connectorId);
    const connectorName = this.adapters.getBySlug(TELEGRAM_SLUG).name;
    const account = bot.username ? `@${bot.username}` : `bot ${bot.id}`;

    await this.securityEvents.log({
      event: SecurityEvents.CONNECTOR_INSTALLED_VIA_SUPPORT_CHAT,
      actorType: 'USER',
      actorUserId: user.id,
      organizationId,
      metadata: {
        adapter: TELEGRAM_SLUG,
        connectorId: imported.connectorId,
        bot: account,
        conversation: conversationUuid,
      },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: user.id,
      organizationId,
      metadata: { adapterSlug: TELEGRAM_SLUG, via: 'support_chat', verified: true },
    });
    this.logger.log(
      `Installed ${TELEGRAM_SLUG} (${imported.connectorId}) for org ${organizationId} from support chat ${conversationUuid}`,
    );

    await desk.addTags(conversationUuid, [AUTO_SETUP_TAG]).catch(() => undefined);
    const connectorPath = `/connectors/${encodeURIComponent(imported.connectorId)}`;
    const connectorUrl = `${this.dashboardBase()}${connectorPath}`;
    await say(
      `<p>Done: I connected ${esc(account)} to ${esc(workspaceName)} as the connector "${esc(connectorName)}"` +
        (server ? ` on your MCP server "${esc(server.name)}"` : '') +
        `. Open a new chat in your AI assistant and its Telegram tools are there.</p>` +
        `<p>Connector: <a href="${esc(connectorUrl)}">${esc(connectorUrl)}</a>. Since the token was posted in this chat, you can make a new one in @BotFather at any time (/revoke) and paste it on that page.</p>`,
    );

    await this.notify(user, organizationId, workspaceName, connectorName, account, connectorPath);
    return 'installed';
  }

  private async getMe(
    token: string,
  ): Promise<
    | { kind: 'ok'; id: number; username: string | null }
    | { kind: 'invalid'; status: number }
    | { kind: 'unreachable' }
  > {
    try {
      const res = await this.fetchImpl()(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 404) return { kind: 'invalid', status: res.status };
      if (!res.ok) return { kind: 'unreachable' };
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: { id?: number; is_bot?: boolean; username?: string } }
        | null;
      if (!body?.ok || !body.result?.is_bot || typeof body.result.id !== 'number') {
        return { kind: 'invalid', status: 401 };
      }
      return { kind: 'ok', id: body.result.id, username: body.result.username ?? null };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  /** The user who posted the token and every admin of the workspace. */
  private async notify(
    user: { id: string; email: string; name: string | null },
    organizationId: string,
    workspaceName: string,
    connectorName: string,
    account: string,
    connectorPath: string,
  ): Promise<void> {
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: { user: { select: { email: true, name: true } } },
    });
    const recipients = new Map<string, string | null>([[user.email.toLowerCase(), user.name]]);
    for (const a of admins) {
      if (a.user?.email && !recipients.has(a.user.email.toLowerCase())) {
        recipients.set(a.user.email.toLowerCase(), a.user.name);
      }
    }
    for (const [to, name] of recipients) {
      await this.email
        .sendConnectorAddedFromSupportEmail(
          to,
          { name, connectorName, account, workspaceName, addedBy: user.email, connectorPath },
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

  private remember(uuid: string) {
    if (this.seen.size >= SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(uuid);
  }
}

function stripTags(html: string | null | undefined): string {
  return (html || '').replace(/<[^>]*>/g, ' ');
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
