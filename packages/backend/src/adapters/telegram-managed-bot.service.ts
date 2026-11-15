import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { getRequiredSecret } from '../common/secrets.util';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { writeConnectorEnvVars } from '../connectors/connector-env-write.util';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { AdaptersService } from './adapters.service';
import {
  BOT_TOKEN_PATTERN,
  MANAGED_BOT_CONFIG_KEY,
  MANAGED_BOT_TTL_MS,
  TELEGRAM_SLUG,
  TELEGRAM_TOKEN_VAR,
  WELCOME_TEXT,
  WELCOME_WINDOW_MS,
  codeFromUsername,
  creationLink,
  hashSetupCode,
  hashTelegramUserId,
  isEmptyTelegramConnector,
  isOrganizationAllowed,
  managerWebhookUrl,
  newSetupCode,
  readManagedBotSettings,
  readManagedBotState,
  suggestedUsername,
  type ManagedBotSettings,
  type ManagedBotState,
  type TelegramOneTap,
  type TelegramOneTapStatus,
  type TelegramTokenAnswer,
} from './telegram-managed-bot';

const TELEGRAM_TIMEOUT_MS = 10_000;
/** The manager bot's identity is asked again at most this often after a failure. */
const REGISTER_RETRY_MS = 60_000;
/** The new bot's updates are looked at, for its first /start, at most this often per connector. */
const PEEK_EVERY_MS = 2_500;
const REMEMBERED_MAX = 2_000;

/** What handling one update of the manager bot came to. */
export type ManagedBotUpdateOutcome =
  | 'ignored'
  | 'connected'
  | 'already_connected'
  | 'unmatched'
  | 'expired'
  | 'connector_has_token'
  | 'token_refused'
  /** Telegram could not be reached: the caller asks for the update again. */
  | 'retry';

type TelegramAnswer<T> =
  | { ok: true; result: T }
  /** `status` 0: no answer at all (network, timeout). */
  | { ok: false; status: number; description: string };

interface TelegramUser {
  id?: unknown;
  is_bot?: unknown;
  username?: unknown;
  can_manage_bots?: unknown;
}

type ConnectorRow = { id: string; organizationId: string; baseUrl: string; envVars: unknown; config: unknown };

/**
 * The one-tap Telegram bot (see telegram-managed-bot.ts for the why and how).
 *
 * Off unless TELEGRAM_MANAGER_BOT_TOKEN and TELEGRAM_MANAGER_WEBHOOK_SECRET
 * are set, the manager bot has Bot Management Mode on, and the server has a
 * public https address Telegram can post to. Nothing here depends on the
 * deployment mode.
 *
 * Rules:
 * - a token is only ever written to a Telegram connector that has none, the
 *   same way the setup page writes a pasted one (writeConnectorEnvVars);
 * - the pending setup is found by the HMAC of the code in the new bot's
 *   username, then every read and write is bound to that connector's
 *   workspace;
 * - no webhook is set on the user's bot: the connector's own
 *   telegram_bot_get_updates would stop working. To greet the user, its
 *   updates are read without an offset, which confirms none of them;
 * - tokens are never logged, and no Telegram id or name is stored or logged.
 */
@Injectable()
export class TelegramManagedBotService implements TelegramOneTap, OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramManagedBotService.name);
  /** The manager bot's username, once it answered getMe with can_manage_bots and took the webhook. */
  private managerUsername: string | null = null;
  private lastRegisterAt = 0;
  private registering: Promise<unknown> | null = null;
  /** New bots being handled right now: both updates of one creation arrive in the same second. */
  private readonly busy = new Set<number>();
  /** Bots already reported as unmatched (each creation is announced twice). */
  private readonly unmatched = new Set<number>();
  private readonly lastPeek = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly connectors: ConnectorsService,
    private readonly mcpServer: McpServerService,
    private readonly productEvents: ProductEventService,
    private readonly config: ConfigService,
  ) {}

  /** Test seams. */
  protected fetchImpl(): typeof fetch {
    return fetch;
  }

  protected env(): Record<string, string | undefined> {
    return process.env;
  }

  protected now(): number {
    return Date.now();
  }

  private settings(): ManagedBotSettings | null {
    return readManagedBotSettings(this.env()).settings;
  }

  // ── Start-up ──────────────────────────────────────────────────────────

  /** Never awaited and never throws: Telegram being slow or down must not delay or stop the boot. */
  onApplicationBootstrap(): void {
    void this.register();
  }

  /**
   * Ask Telegram who the manager bot is and point its webhook at this server.
   * Safe to repeat: setWebhook with the same values changes nothing.
   */
  async register(): Promise<'off' | 'not_a_manager' | 'no_public_url' | 'failed' | 'registered'> {
    this.lastRegisterAt = this.now();
    const read = readManagedBotSettings(this.env());
    if (!read.settings) {
      this.managerUsername = null;
      if (read.problem === 'bad_token') {
        this.logger.warn('TELEGRAM_MANAGER_BOT_TOKEN does not look like a bot token: the one-tap Telegram bot is off');
      } else if (read.problem) {
        this.logger.warn(
          'TELEGRAM_MANAGER_WEBHOOK_SECRET must be 16 to 256 characters of A-Z, a-z, 0-9, _ and -: the one-tap Telegram bot is off',
        );
      }
      return 'off';
    }
    const settings = read.settings;
    try {
      const me = await this.call<TelegramUser>(settings.token, 'getMe');
      if (!me.ok) {
        this.managerUsername = null;
        this.logger.warn(`The Telegram manager bot did not answer getMe (${describe(me)}): the one-tap Telegram bot is off`);
        return 'failed';
      }
      if (me.result.can_manage_bots !== true || typeof me.result.username !== 'string' || !me.result.username) {
        this.managerUsername = null;
        this.logger.warn(
          'The Telegram manager bot cannot manage bots: turn on Bot Management Mode for it in @BotFather. The one-tap Telegram bot is off',
        );
        return 'not_a_manager';
      }
      const url = managerWebhookUrl(this.config.get<string>('SERVER_URL'));
      if (!url) {
        this.managerUsername = null;
        this.logger.warn('SERVER_URL is not a public https address, so Telegram cannot reach this server: the one-tap Telegram bot is off');
        return 'no_public_url';
      }
      const hook = await this.call<boolean>(settings.token, 'setWebhook', {
        url,
        secret_token: settings.webhookSecret,
        allowed_updates: ['managed_bot', 'message'],
      });
      if (!hook.ok) {
        this.managerUsername = null;
        this.logger.warn(`Telegram refused the manager bot's webhook (${describe(hook)}): the one-tap Telegram bot is off`);
        return 'failed';
      }
      this.managerUsername = me.result.username;
      this.logger.log(`One-tap Telegram bot is on: manager @${me.result.username}, webhook ${url}`);
      return 'registered';
    } catch (err) {
      this.managerUsername = null;
      this.logger.warn(`The Telegram manager bot could not be registered (${(err as Error)?.name || 'error'})`);
      return 'failed';
    }
  }

  // ── The page ──────────────────────────────────────────────────────────

  isEnabledFor(organizationId: string): boolean {
    const settings = this.settings();
    if (!settings) return false;
    if (!this.managerUsername) {
      // Telegram was not reachable at start-up: try again in the background,
      // at most once a minute, and offer nothing until it worked.
      if (!this.registering && this.now() - this.lastRegisterAt >= REGISTER_RETRY_MS) {
        this.registering = this.register().finally(() => {
          this.registering = null;
        });
      }
      return false;
    }
    return !!organizationId && isOrganizationAllowed(settings, organizationId);
  }

  /**
   * Start a setup for a Telegram connector that was just added without a
   * token: a new code, kept as its HMAC with an expiry on the connector, and
   * the link that carries it. Null when the feature is off for the workspace
   * or the connector is not an empty Telegram connector of it.
   */
  async begin(input: {
    connectorId: string;
    organizationId: string;
    userId: string;
  }): Promise<{ link: string; username: string } | null> {
    const settings = this.settings();
    const manager = this.managerUsername;
    if (!settings || !manager || !this.isEnabledFor(input.organizationId)) return null;
    const row = await this.prisma.connector.findFirst({
      where: { id: input.connectorId, organizationId: input.organizationId },
      select: { id: true, organizationId: true, baseUrl: true, envVars: true, config: true },
    });
    if (!row || !isTelegram(row) || !isEmptyTelegramConnector(row)) return null;

    const code = newSetupCode();
    const now = this.now();
    const state: ManagedBotState = {
      codeHash: hashSetupCode(code, settings.webhookSecret),
      expiresAt: new Date(now + MANAGED_BOT_TTL_MS).toISOString(),
      startedAt: new Date(now).toISOString(),
      userId: input.userId,
    };
    if ((await this.replaceState(row.id, row.organizationId, state)) !== 1) return null;
    return { link: creationLink(manager, code), username: suggestedUsername(code) };
  }

  /**
   * Where the user's setup stands, for the page that polls it. Also records
   * the first click on the link, and, once the bot is connected, looks for
   * its first /start to send the welcome message.
   */
  async status(input: {
    organizationId: string;
    userId: string;
    opened?: boolean;
    device?: 'mobile' | 'desktop';
  }): Promise<TelegramOneTapStatus> {
    const found = await this.setupOf(input.organizationId, input.userId);
    if (!found) return { state: 'none' };
    const { row } = found;
    let { state } = found;

    if (input.opened && !state.openedAt) {
      const openedAt = new Date(this.now()).toISOString();
      if ((await this.patchState(row, { openedAt }, 'openedAt')) === 1) {
        await this.productEvents.log({
          event: ProductEvents.TELEGRAM_BOT_LINK_OPENED,
          userId: input.userId,
          organizationId: row.organizationId,
          metadata: { adapterSlug: TELEGRAM_SLUG, ...(input.device ? { device: input.device } : {}) },
        });
      }
      state = { ...state, openedAt };
    }

    if (!isEmptyTelegramConnector(row)) {
      const bot = state.botUsername ? `@${state.botUsername}` : undefined;
      let welcomed = !!state.welcomedAt;
      if (!welcomed && this.awaitsWelcome(state)) welcomed = await this.welcomeAfterStart(row, state);
      return {
        state: 'connected',
        ...(bot ? { bot } : {}),
        ...(!welcomed && state.via === 'managed_bot' && state.botUsername
          ? { startUrl: `https://t.me/${state.botUsername}` }
          : {}),
      };
    }
    if (!state.expiresAt || Date.parse(state.expiresAt) < this.now()) return { state: 'expired' };
    return { state: 'waiting' };
  }

  /**
   * "Already have a bot? Paste its token": checked with Telegram and stored
   * exactly as the setup page does it. Only into the connector this user's
   * pick added, and only while it has no token.
   */
  async saveToken(input: { organizationId: string; userId: string; token: unknown }): Promise<TelegramTokenAnswer> {
    if (!this.isEnabledFor(input.organizationId)) {
      return { ok: false, error: 'This is not available right now. Continue, and finish Telegram in the chat.' };
    }
    const found = await this.setupOf(input.organizationId, input.userId);
    if (!found) return { ok: false, error: 'This page has expired. Continue, and finish Telegram in the chat.' };
    const { row } = found;
    if (!isEmptyTelegramConnector(row)) return { ok: false, error: 'Telegram is already connected.' };

    const token = typeof input.token === 'string' ? input.token.trim() : '';
    const refused = async (kind: string, error: string): Promise<TelegramTokenAnswer> => {
      await this.productEvents.log({
        event: ProductEvents.TELEGRAM_BOT_TOKEN_PASTED,
        userId: input.userId,
        organizationId: row.organizationId,
        metadata: { adapterSlug: TELEGRAM_SLUG, connectorId: row.id, status: 'refused', kind },
      });
      return { ok: false, error };
    };
    if (!BOT_TOKEN_PATTERN.test(token)) {
      return refused(
        'invalid_input',
        'This does not look like a bot token. Paste the whole value from @BotFather, like 123456789:AAH..., with nothing before or after it.',
      );
    }
    // The same check as the setup page: the adapter's own test call.
    let check: Awaited<ReturnType<AdaptersService['verifyCredentials']>>;
    try {
      check = await this.adapters.verifyCredentials(TELEGRAM_SLUG, row.organizationId, { [TELEGRAM_TOKEN_VAR]: token }, row.id);
    } catch {
      return refused('error', 'The token could not be checked right now. Try again, or continue and finish Telegram in the chat.');
    }
    if (check.ok === false) return refused(check.kind, check.message);

    const stored = await this.storeToken(row, token);
    if (stored !== 'stored') {
      return { ok: false, error: stored === 'has_token' ? 'Telegram is already connected.' : 'The token could not be saved. Try again.' };
    }
    // Which bot it is, for the page. The token was just accepted; a failure
    // here only leaves the name out.
    const me = await this.call<TelegramUser>(token, 'getMe').catch(() => null);
    const botUsername = me?.ok && typeof me.result.username === 'string' ? me.result.username : undefined;
    const claimed = await this.patchState(
      row,
      { connectedAt: new Date(this.now()).toISOString(), via: 'pasted', ...(botUsername ? { botUsername } : {}) },
      'connectedAt',
    );
    if (claimed === 1) {
      await this.productEvents.log({
        event: ProductEvents.TELEGRAM_BOT_TOKEN_PASTED,
        userId: input.userId,
        organizationId: row.organizationId,
        metadata: { adapterSlug: TELEGRAM_SLUG, connectorId: row.id, status: 'saved' },
      });
      await this.productEvents.log({
        event: ProductEvents.SETUP_COMPLETED,
        userId: input.userId,
        organizationId: row.organizationId,
        metadata: { adapterSlug: TELEGRAM_SLUG, via: 'post_approve_token', verified: true },
      });
    }
    this.logger.log(`Stored a pasted Telegram bot token on connector ${row.id} (org ${row.organizationId})`);
    return { ok: true, ...(botUsername ? { bot: `@${botUsername}` } : {}) };
  }

  // ── Telegram's updates ────────────────────────────────────────────────

  /** Whether a webhook call carries this instance's secret. Constant time. */
  verifyWebhookSecret(header: unknown): boolean {
    const settings = this.settings();
    if (!settings || typeof header !== 'string') return false;
    const a = Buffer.from(header);
    const b = Buffer.from(settings.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Whether the webhook exists on this instance at all. */
  isConfigured(): boolean {
    return !!this.settings();
  }

  /**
   * One update of the manager bot. A new managed bot is announced twice, as
   * `managed_bot` and as a service message with `managed_bot_created`; both
   * are taken, and the second one finds the work done.
   */
  async handleUpdate(update: unknown): Promise<ManagedBotUpdateOutcome> {
    const settings = this.settings();
    if (!settings) return 'ignored';
    const u = (update ?? {}) as {
      managed_bot?: { user?: TelegramUser; bot?: TelegramUser };
      message?: { from?: TelegramUser; managed_bot_created?: { bot?: TelegramUser } };
    };
    const bot = u.managed_bot?.bot ?? u.message?.managed_bot_created?.bot;
    const creator = u.managed_bot ? u.managed_bot.user : u.message?.managed_bot_created ? u.message.from : undefined;
    if (!bot || typeof bot.id !== 'number' || !Number.isSafeInteger(bot.id)) return 'ignored';
    const botId = bot.id;
    if (this.busy.has(botId)) return 'ignored';
    this.busy.add(botId);
    try {
      return await this.connect(settings, { id: botId, username: bot.username }, creator);
    } finally {
      this.busy.delete(botId);
    }
  }

  private async connect(
    settings: ManagedBotSettings,
    bot: { id: number; username: unknown },
    creator: TelegramUser | undefined,
  ): Promise<ManagedBotUpdateOutcome> {
    const code = codeFromUsername(bot.username);
    if (!code) return this.reportUnmatched(bot.id, 'no_code');
    const row = await this.prisma.connector.findFirst({
      // The one lookup that cannot name a workspace: Telegram only tells us
      // the bot. The key is the HMAC of a random code this server issued.
      where: { config: { path: [MANAGED_BOT_CONFIG_KEY, 'codeHash'], equals: hashSetupCode(code, settings.webhookSecret) } },
      select: { id: true, organizationId: true, baseUrl: true, envVars: true, config: true },
    });
    const state = row ? readManagedBotState(row.config) : null;
    if (!row || !state || !isTelegram(row)) return this.reportUnmatched(bot.id, 'unknown_code');
    // A token change or a new owner of a bot that is connected already.
    if (state.connectedAt) return 'already_connected';
    if (!state.expiresAt || Date.parse(state.expiresAt) < this.now()) {
      await this.reportUnmatched(bot.id, 'expired', row.organizationId, state.userId);
      return 'expired';
    }
    // The user pasted a token in the meantime: that one stays.
    if (!isEmptyTelegramConnector(row)) return 'connector_has_token';

    const answer = await this.call<string>(settings.token, 'getManagedBotToken', { user_id: bot.id });
    if (!answer.ok) {
      // No answer, a server error or a rate limit: Telegram sends the update again.
      if (answer.status === 0 || answer.status === 429 || answer.status >= 500) return 'retry';
      this.logger.warn(`Telegram did not hand out the token of a managed bot (${describe(answer)})`);
      await this.reportUnmatched(bot.id, 'token_refused', row.organizationId, state.userId);
      return 'token_refused';
    }
    const token = typeof answer.result === 'string' ? answer.result.trim() : '';
    // The token of a bot starts with that bot's id.
    if (!BOT_TOKEN_PATTERN.test(token) || !token.startsWith(`${bot.id}:`)) {
      await this.reportUnmatched(bot.id, 'token_refused', row.organizationId, state.userId);
      return 'token_refused';
    }

    const stored = await this.storeToken(row, token);
    if (stored === 'has_token') return 'connector_has_token';
    if (stored !== 'stored') return 'retry';

    const botUsername = typeof bot.username === 'string' ? bot.username : undefined;
    const creatorId = typeof creator?.id === 'number' && Number.isSafeInteger(creator.id) ? creator.id : null;
    const claimed = await this.patchState(
      row,
      {
        connectedAt: new Date(this.now()).toISOString(),
        via: 'managed_bot',
        ...(botUsername ? { botUsername } : {}),
        ...(creatorId !== null ? { creatorHash: hashTelegramUserId(creatorId, settings.webhookSecret) } : {}),
      },
      'connectedAt',
    );
    if (claimed !== 1) return 'already_connected';

    await this.productEvents.log({
      event: ProductEvents.TELEGRAM_BOT_CONNECTED,
      userId: state.userId ?? null,
      organizationId: row.organizationId,
      metadata: { adapterSlug: TELEGRAM_SLUG, connectorId: row.id },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: state.userId ?? null,
      organizationId: row.organizationId,
      metadata: { adapterSlug: TELEGRAM_SLUG, via: 'telegram_one_tap', verified: true },
    });
    this.logger.log(`Connected a one-tap Telegram bot to connector ${row.id} (org ${row.organizationId})`);

    // A bot cannot write to a user who has not started it, so this often
    // answers "chat not found": the page's status check tries again after the
    // first /start. Never fails the setup.
    if (creatorId !== null) await this.welcome(row, token, creatorId, { claimFirst: false });
    return 'connected';
  }

  /** One `telegram_bot_unmatched` per bot: both updates of a creation come through here. */
  private async reportUnmatched(
    botId: number,
    kind: 'no_code' | 'unknown_code' | 'expired' | 'token_refused',
    organizationId?: string,
    userId?: string,
  ): Promise<'unmatched'> {
    if (this.unmatched.has(botId)) return 'unmatched';
    remember(this.unmatched, botId);
    // No username and no id: a bot is its owner's.
    await this.productEvents.log({
      event: ProductEvents.TELEGRAM_BOT_UNMATCHED,
      userId: userId ?? null,
      organizationId: organizationId ?? null,
      metadata: { adapterSlug: TELEGRAM_SLUG, kind },
    });
    this.logger.log(`A new managed Telegram bot was not connected (${kind})`);
    return 'unmatched';
  }

  // ── Storing a token ───────────────────────────────────────────────────

  /**
   * The setup page's own writer (field checks, the address rebuilt from the
   * variable, variables encrypted at rest, tools reloaded), on a connector
   * read again in its workspace and still without a token.
   */
  private async storeToken(row: ConnectorRow, token: string): Promise<'stored' | 'has_token' | 'failed'> {
    try {
      const connector = await this.prisma.connector.findFirst({
        where: { id: row.id, organizationId: row.organizationId },
      });
      if (!connector || !isTelegram(connector)) return 'failed';
      if (!isEmptyTelegramConnector(connector)) return 'has_token';
      const stored = (connector.envVars as Record<string, string> | null) ?? {};
      await writeConnectorEnvVars(
        {
          connectorsService: this.connectors,
          mcpServer: this.mcpServer,
          encryptionKey: getRequiredSecret('ENCRYPTION_KEY', this.config.get<string>('ENCRYPTION_KEY')),
        },
        connector,
        { ...stored, [TELEGRAM_TOKEN_VAR]: token },
      );
      return 'stored';
    } catch (err) {
      // A name only: an error's message could quote the value.
      this.logger.warn(`A Telegram bot token could not be stored on connector ${row.id} (${(err as Error)?.name || 'error'})`);
      return 'failed';
    }
  }

  // ── The welcome message ───────────────────────────────────────────────

  private awaitsWelcome(state: ManagedBotState): boolean {
    return (
      state.via === 'managed_bot' &&
      !!state.creatorHash &&
      !!state.connectedAt &&
      this.now() - Date.parse(state.connectedAt) < WELCOME_WINDOW_MS
    );
  }

  /**
   * Look at the new bot's updates for its creator's /start and greet them
   * there. No offset is sent, so nothing is confirmed and the connector's
   * own telegram_bot_get_updates still returns everything. Returns whether
   * the welcome is done.
   */
  private async welcomeAfterStart(row: ConnectorRow, state: ManagedBotState): Promise<boolean> {
    const settings = this.settings();
    const token = (row.envVars as Record<string, unknown> | null)?.[TELEGRAM_TOKEN_VAR];
    if (!settings || typeof token !== 'string' || !token) return false;
    const last = this.lastPeek.get(row.id) ?? 0;
    if (this.now() - last < PEEK_EVERY_MS) return false;
    if (this.lastPeek.size >= REMEMBERED_MAX) this.lastPeek.clear();
    this.lastPeek.set(row.id, this.now());
    try {
      const updates = await this.call<Array<{ message?: { text?: unknown; from?: TelegramUser; chat?: { id?: unknown; type?: unknown } } }>>(
        token,
        'getUpdates',
        { timeout: 0 },
      );
      if (!updates.ok || !Array.isArray(updates.result)) return false;
      for (const update of updates.result) {
        const message = update?.message;
        const from = message?.from?.id;
        const chat = message?.chat?.id;
        if (typeof from !== 'number' || typeof chat !== 'number' || message?.chat?.type !== 'private') continue;
        if (typeof message.text !== 'string' || !message.text.startsWith('/start')) continue;
        if (hashTelegramUserId(from, settings.webhookSecret) !== state.creatorHash) continue;
        await this.welcome(row, token, chat, { claimFirst: true });
        return true;
      }
    } catch {
      // Best effort.
    }
    return false;
  }

  /**
   * Send the welcome once. With `claimFirst` (the user is known to have
   * started the bot) the claim comes before the send, so two checks at the
   * same moment send one message; without it (the first try, which Telegram
   * often refuses) the claim follows a send that worked.
   */
  private async welcome(row: ConnectorRow, token: string, chatId: number, opts: { claimFirst: boolean }): Promise<void> {
    try {
      const welcomedAt = new Date(this.now()).toISOString();
      if (opts.claimFirst && (await this.patchState(row, { welcomedAt }, 'welcomedAt')) !== 1) return;
      const sent = await this.call<unknown>(token, 'sendMessage', { chat_id: chatId, text: WELCOME_TEXT });
      if (sent.ok && !opts.claimFirst) await this.patchState(row, { welcomedAt }, 'welcomedAt');
    } catch {
      // Best effort.
    }
  }

  // ── State in connectors.config ────────────────────────────────────────

  /** This user's setup in the workspace: the newest Telegram connector that carries one. */
  private async setupOf(
    organizationId: string,
    userId: string,
  ): Promise<{ row: ConnectorRow; state: ManagedBotState } | null> {
    if (!organizationId || !userId) return null;
    const rows = await this.prisma.connector.findMany({
      where: { organizationId, config: { path: ['adapterSlug'], equals: TELEGRAM_SLUG } },
      select: { id: true, organizationId: true, baseUrl: true, envVars: true, config: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    for (const row of rows) {
      const state = readManagedBotState(row.config);
      if (state?.codeHash && state.userId === userId) return { row, state };
    }
    return null;
  }

  /** Start over: the whole state object is replaced, every other config key is left alone. */
  private replaceState(id: string, organizationId: string, state: ManagedBotState): Promise<number> {
    const json = JSON.stringify(state);
    return this.prisma.$executeRaw`
      UPDATE connectors
      SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
        || jsonb_build_object('telegramManagedBot', ${json}::jsonb)
      WHERE id = ${id} AND organization_id = ${organizationId}`;
  }

  /**
   * Merge `patch` into the state in one statement, leaving a concurrent edit
   * of the config alone, and only while `unlessSet` is still empty: returns 1
   * for the caller that wins, 0 for any other.
   */
  private patchState(
    row: Pick<ConnectorRow, 'id' | 'organizationId'>,
    patch: ManagedBotState,
    unlessSet: 'openedAt' | 'connectedAt' | 'welcomedAt',
  ): Promise<number> {
    const json = JSON.stringify(patch);
    return this.prisma.$executeRaw`
      UPDATE connectors
      SET config = config
        || jsonb_build_object('telegramManagedBot', (config->'telegramManagedBot') || ${json}::jsonb)
      WHERE id = ${row.id} AND organization_id = ${row.organizationId}
        AND jsonb_typeof(config->'telegramManagedBot') = 'object'
        AND (config->'telegramManagedBot'->>${unlessSet}::text) IS NULL`;
  }

  // ── Telegram ──────────────────────────────────────────────────────────

  /**
   * One Bot API call. The token is part of the URL, so neither the URL nor a
   * thrown error ever reaches a log: failures come back as a status and
   * Telegram's own description.
   */
  private async call<T>(token: string, method: string, params?: Record<string, unknown>): Promise<TelegramAnswer<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl()(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, description: 'no answer' };
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: unknown } | null;
    if (res.ok && body?.ok === true) return { ok: true, result: body.result as T };
    return {
      ok: false,
      status: res.status,
      description: typeof body?.description === 'string' ? body.description.slice(0, 160) : 'no description',
    };
  }
}

function isTelegram(row: { config: unknown }): boolean {
  return (row.config as { adapterSlug?: unknown } | null)?.adapterSlug === TELEGRAM_SLUG;
}

function describe(answer: { status: number; description: string }): string {
  return `${answer.status || 'no answer'}: ${answer.description}`;
}

function remember(set: Set<number>, value: number): void {
  if (set.size >= REMEMBERED_MAX) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}
