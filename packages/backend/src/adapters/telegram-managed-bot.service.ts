import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { getRequiredSecret } from '../common/secrets.util';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { writeConnectorEnvVars } from '../connectors/connector-env-write.util';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { McpClientSeenRegistry, type McpClientSeen } from '../mcp-server/mcp-client-seen';
import { AdaptersService } from './adapters.service';
import { TelegramClaimStore } from './telegram-claim.store';
import {
  BOT_TOKEN_PATTERN,
  CLAIM_ALREADY_TEXT,
  CLAIM_FAILED_TEXT,
  CLAIM_INVALID_TEXT,
  CLAIM_LINKED_TEXT,
  CLAIM_WAITING_TEXT,
  CLIENT_NOTICE_WINDOW_MS,
  MANAGER_GREETING_TEXT,
  MANAGED_BOT_CONFIG_KEY,
  MANAGED_BOT_TTL_MS,
  TELEGRAM_DEFAULT_CHAT_VAR,
  TELEGRAM_SLUG,
  TELEGRAM_TOKEN_VAR,
  WELCOME_WINDOW_MS,
  claimLink,
  cleanClientName,
  clientConnectedMessage,
  codeFromClaimParameter,
  codeFromUsername,
  creationLink,
  hashSetupCode,
  hashTelegramUserId,
  isEmptyTelegramConnector,
  isOrganizationAllowed,
  managerWebhookUrl,
  newSetupCode,
  parseStartCommand,
  readManagedBotSettings,
  readManagedBotState,
  suggestedUsername,
  welcomeText,
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
/**
 * A workspace's connectors are looked at, for a one-tap bot that waits to
 * announce its AI client, at most this often: the one database read a
 * tools/list of the shared endpoint can cost here.
 */
export const CLIENT_SEEN_EVERY_MS = 5_000;
/**
 * `/start` messages the manager bot acts on per minute: from one Telegram
 * account, and from everybody together (per backend process). Each one costs
 * a database lookup and an answer, and anyone can write to the bot; a real
 * setup sends one or two. Over the limit a message gets no lookup and no
 * answer.
 */
export const START_MAX_PER_SENDER = 5;
export const START_MAX_PER_MINUTE = 120;
const START_WINDOW_MS = 60_000;

/** What handling one update of the manager bot came to. */
export type ManagedBotUpdateOutcome =
  | 'ignored'
  | 'connected'
  | 'already_connected'
  | 'unmatched'
  | 'expired'
  | 'connector_has_token'
  | 'token_refused'
  /** `/start <code>`: the account is linked to the setup, and its bot does not exist yet. */
  | 'claimed'
  /** `/start <code>` with a code that cannot be used (unknown, expired, somebody else's). */
  | 'refused'
  /** A plain `/start`: answered with one line. */
  | 'greeted'
  /** Too many `/start` messages: not looked at. */
  | 'limited'
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

interface TelegramMessage {
  text?: unknown;
  from?: TelegramUser;
  chat?: { id?: unknown; type?: unknown };
  managed_bot_created?: { bot?: TelegramUser };
}

type ConnectorRow = { id: string; organizationId: string; baseUrl: string; envVars: unknown; config: unknown };
const ROW_SELECT = { id: true, organizationId: true, baseUrl: true, envVars: true, config: true } as const;

/** Why a `/start <code>` was not taken. */
type ClaimRefusal = 'unknown_code' | 'expired' | 'already_connected' | 'connector_has_token' | 'other_user' | 'token_refused';

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
 * - the pending setup is found by the HMAC of the code, which arrives in the
 *   new bot's username or in a `/start <code>` sent to the manager bot
 *   (findSetupByCode, the one query that names no workspace), then every
 *   read and write is bound to that connector's workspace;
 * - a bot whose username names no setup is connected only to a setup its own
 *   creator asked for with `/start <code>`: Telegram says who created a bot
 *   and who sent a message, and the two must be the same account. The first
 *   account to send a setup's code keeps it;
 * - the user's bot writes to its creator twice at most: the welcome when it
 *   is connected (one step is left: Continue on the page), and "your
 *   assistant is connected" when the AI client's first request arrives
 *   (noteClientSeen). Neither ever delays or fails what triggered it;
 * - no webhook is set on the user's bot: the connector's own
 *   telegram_bot_get_updates would stop working. To greet the user, its
 *   updates are read without an offset, which confirms none of them;
 * - the creator's chat id is stored once, as the connector's default chat
 *   (encrypted with its other variables, shown and editable in its
 *   settings): without it "send me a message" has nobody to go to. Tokens
 *   and Telegram ids are never logged, and no name is stored.
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
  /** `/start` updates already answered: Telegram sends an update again when it got no 2xx. */
  private readonly answeredStarts = new Set<number>();
  /** The current minute's `/start` messages, by sender (keyed hash) and in all. */
  private startWindow = { at: 0, count: 0, warned: false };
  private readonly startsBySender = new Map<string, number>();
  /** When each workspace's connectors were last looked at for the "assistant is connected" message. */
  private readonly lastClientCheck = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly connectors: ConnectorsService,
    private readonly mcpServer: McpServerService,
    private readonly productEvents: ProductEventService,
    private readonly config: ConfigService,
    private readonly claims: TelegramClaimStore,
    @Optional() clientSeen?: McpClientSeenRegistry,
  ) {
    // The MCP endpoint cannot import this module (it would be a circle): it
    // tells the registry, and the registry tells whoever asked to hear.
    clientSeen?.register((seen) => this.noteClientSeen(seen));
  }

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
    client?: { name: string; claude: boolean };
  }): Promise<{ link: string; username: string; claimLink: string } | null> {
    const settings = this.settings();
    const manager = this.managerUsername;
    if (!settings || !manager || !this.isEnabledFor(input.organizationId)) return null;
    const row = await this.prisma.connector.findFirst({
      where: { id: input.connectorId, organizationId: input.organizationId },
      select: ROW_SELECT,
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
    // For the bot's two messages: "tap Continue to <client>", and the link
    // to a new chat, which only Claude has.
    const client = cleanClientName(input.client?.name);
    if (client) state.client = client;
    if (input.client?.claude === true) state.claude = true;
    if ((await this.replaceState(row.id, row.organizationId, state)) !== 1) return null;
    return {
      link: creationLink(manager, code),
      username: suggestedUsername(code),
      claimLink: claimLink(manager, code, settings.webhookSecret),
    };
  }

  /**
   * Where the user's setup stands, for the page that polls it. Also records
   * the first click on the link and the first time "Link your bot" is shown,
   * and, once the bot is connected, looks for its first /start to send the
   * welcome message.
   */
  async status(input: {
    organizationId: string;
    userId: string;
    opened?: boolean;
    claimOffered?: boolean;
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
    // Start was pressed in the manager's chat: any bot this account creates now is connected.
    if (state.claimHash) return { state: 'waiting', claimed: true };

    const unmatched = await this.unmatchedBotSince(state);
    if (input.claimOffered && !state.claimOfferedAt) {
      const claimOfferedAt = new Date(this.now()).toISOString();
      if ((await this.patchState(row, { claimOfferedAt }, 'claimOfferedAt')) === 1) {
        await this.productEvents.log({
          event: ProductEvents.TELEGRAM_BOT_CLAIM_OFFERED,
          userId: input.userId,
          organizationId: row.organizationId,
          metadata: {
            adapterSlug: TELEGRAM_SLUG,
            // Why the page showed it: a bot with another username was just created, or time passed.
            kind: unmatched ? 'unmatched_bot' : 'timeout',
            ...(input.device ? { device: input.device } : {}),
          },
        });
      }
    }
    return { state: 'waiting', ...(unmatched ? { unmatched: true as const } : {}) };
  }

  /**
   * Whether a bot with another username was created through this manager
   * since this setup's link was offered (or opened). Telegram does not say
   * whose setup a bot is for, so this is a hint for the page, nothing more:
   * it makes "Link your bot" appear at once.
   */
  private async unmatchedBotSince(state: ManagedBotState): Promise<boolean> {
    const since = Date.parse(state.openedAt ?? state.startedAt ?? '');
    if (!Number.isFinite(since)) return false;
    const at = await this.claims.lastUnmatchedAt();
    return at !== null && at >= since && this.now() - at < MANAGED_BOT_TTL_MS;
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
   * One update of the manager bot: a new managed bot, or a `/start` in its
   * chat. A new bot is announced twice, as `managed_bot` and as a service
   * message with `managed_bot_created`; both are taken, and the second one
   * finds the work done.
   */
  async handleUpdate(update: unknown): Promise<ManagedBotUpdateOutcome> {
    const settings = this.settings();
    if (!settings) return 'ignored';
    const u = (update ?? {}) as {
      update_id?: unknown;
      managed_bot?: { user?: TelegramUser; bot?: TelegramUser };
      message?: TelegramMessage;
    };
    const updateId = typeof u.update_id === 'number' && Number.isSafeInteger(u.update_id) ? u.update_id : null;
    if (!u.managed_bot && u.message && !u.message.managed_bot_created) return this.handleStart(settings, u.message, updateId);

    const bot = u.managed_bot?.bot ?? u.message?.managed_bot_created?.bot;
    const creator = u.managed_bot ? u.managed_bot.user : u.message?.managed_bot_created ? u.message.from : undefined;
    if (!bot || typeof bot.id !== 'number' || !Number.isSafeInteger(bot.id)) return 'ignored';
    const botId = bot.id;
    if (this.busy.has(botId)) return 'ignored';
    this.busy.add(botId);
    try {
      return await this.connect(settings, { id: botId, username: bot.username }, creator, updateId);
    } finally {
      this.busy.delete(botId);
    }
  }

  private async connect(
    settings: ManagedBotSettings,
    bot: { id: number; username: unknown },
    creator: TelegramUser | undefined,
    updateId: number | null,
  ): Promise<ManagedBotUpdateOutcome> {
    const code = codeFromUsername(bot.username);
    if (!code) return this.unmatchedBot(settings, bot, creator, updateId, 'no_code');
    const row = await this.findSetupByCode(code, settings);
    const state = row ? readManagedBotState(row.config) : null;
    if (!row || !state || !isTelegram(row)) return this.unmatchedBot(settings, bot, creator, updateId, 'unknown_code');
    // A token change or a new owner of a bot that is connected already.
    if (state.connectedAt) return 'already_connected';
    if (!state.expiresAt || Date.parse(state.expiresAt) < this.now()) {
      const outcome = await this.unmatchedBot(settings, bot, creator, updateId, 'expired', row.organizationId, state.userId);
      return outcome === 'unmatched' ? 'expired' : outcome;
    }
    // The user pasted a token in the meantime: that one stays.
    if (!isEmptyTelegramConnector(row)) return 'connector_has_token';
    return this.attach(settings, row, state, bot, personId(creator), 'username');
  }

  /**
   * The pending setup a code belongs to. The one lookup that cannot name a
   * workspace: Telegram only tells us the bot, or the sender of a /start. The
   * key is the HMAC of a random code this server issued.
   */
  private findSetupByCode(code: string, settings: ManagedBotSettings): Promise<ConnectorRow | null> {
    return this.prisma.connector.findFirst({
      where: { config: { path: [MANAGED_BOT_CONFIG_KEY, 'codeHash'], equals: hashSetupCode(code, settings.webhookSecret) } },
      select: ROW_SELECT,
    });
  }

  /**
   * Fetch the bot's token from Telegram and store it on the connector, with
   * the bot's creator as the default chat. `how`: the setup was found by the
   * bot's username, or by its creator's `/start <code>` ('claim'). The caller
   * has checked that the setup is pending and the connector empty; the writer
   * checks the connector again.
   */
  private async attach(
    settings: ManagedBotSettings,
    row: ConnectorRow,
    state: ManagedBotState,
    bot: { id: number; username: unknown },
    creatorId: number | null,
    how: 'username' | 'claim',
  ): Promise<ManagedBotUpdateOutcome> {
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

    // A person's chat with a bot has that person's id: the creator becomes
    // the connector's default chat, so "send me a message" works at once.
    const stored = await this.storeToken(row, token, creatorId);
    if (stored === 'has_token') return 'connector_has_token';
    if (stored !== 'stored') return 'retry';

    let botUsername = typeof bot.username === 'string' ? bot.username : undefined;
    if (!botUsername) {
      // Linked after the fact: only the bot's id was kept. Its name is for
      // the page; a failure here only leaves it out.
      const me = await this.call<TelegramUser>(token, 'getMe').catch(() => null);
      if (me?.ok && typeof me.result.username === 'string') botUsername = me.result.username;
    }
    const claimed = await this.patchState(
      row,
      {
        connectedAt: new Date(this.now()).toISOString(),
        via: 'managed_bot',
        ...(how === 'claim' ? { matched: 'claim' as const } : {}),
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
      // `kind: 'claim'`: found through its creator's /start, not by its username.
      metadata: { adapterSlug: TELEGRAM_SLUG, connectorId: row.id, ...(how === 'claim' ? { kind: 'claim' } : {}) },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: state.userId ?? null,
      organizationId: row.organizationId,
      metadata: { adapterSlug: TELEGRAM_SLUG, via: 'telegram_one_tap', verified: true },
    });
    this.logger.log(
      `Connected a one-tap Telegram bot to connector ${row.id} (org ${row.organizationId})${how === 'claim' ? ', linked by its creator' : ''}`,
    );

    // A bot cannot write to a user who has not started it, so this often
    // answers "chat not found": the page's status check tries again after the
    // first /start. Never fails the setup.
    if (creatorId !== null) await this.welcome(row, token, creatorId, { claimFirst: false, client: state.client });
    return 'connected';
  }

  // ── A bot whose username the user changed ─────────────────────────────

  /**
   * A new bot that names no pending setup. It is remembered for its creator
   * (see TelegramClaimStore); if that account already asked for a setup with
   * `/start <code>`, the bot is connected to it now. Otherwise it is reported
   * as unmatched, and connected when the /start arrives.
   */
  private async unmatchedBot(
    settings: ManagedBotSettings,
    bot: { id: number; username: unknown },
    creator: TelegramUser | undefined,
    updateId: number | null,
    kind: 'no_code' | 'unknown_code' | 'expired',
    organizationId?: string,
    userId?: string,
  ): Promise<ManagedBotUpdateOutcome> {
    const creatorId = personId(creator);
    let remembered = false;
    if (creatorId !== null) {
      const creatorHash = hashTelegramUserId(creatorId, settings.webhookSecret);
      const kept = await this.claims.rememberBot(creatorHash, { botId: bot.id, updateId }, this.now());
      // The second announcement of a bot that was linked a moment ago.
      if (kept === 'used') return 'already_connected';
      remembered = kept === 'stored';
      if (remembered) {
        const linked = await this.linkToClaim(settings, creatorHash, creatorId, bot);
        if (linked) return linked;
      }
    }
    const first = !this.unmatched.has(bot.id);
    await this.reportUnmatched(bot.id, kind, organizationId, userId);
    // For the pages that are waiting: one of them may be this bot's.
    if (first && remembered) await this.claims.noteUnmatched(this.now());
    return 'unmatched';
  }

  /**
   * "Start first": the bot's creator sent `/start <code>` before the bot
   * existed. Null when that account asked for nothing that can still be
   * finished.
   */
  private async linkToClaim(
    settings: ManagedBotSettings,
    creatorHash: string,
    creatorId: number,
    bot: { id: number; username: unknown },
  ): Promise<ManagedBotUpdateOutcome | null> {
    const claim = await this.claims.claimOf(creatorHash, this.now());
    if (!claim) return null;
    const row = await this.prisma.connector.findFirst({
      where: { id: claim.connectorId, organizationId: claim.organizationId },
      select: ROW_SELECT,
    });
    const state = row ? readManagedBotState(row.config) : null;
    // The connector decides, not the store: the setup must still be pending
    // and name this very account.
    if (
      !row ||
      !state ||
      !isTelegram(row) ||
      state.claimHash !== creatorHash ||
      state.connectedAt ||
      !state.expiresAt ||
      Date.parse(state.expiresAt) < this.now() ||
      !isEmptyTelegramConnector(row)
    ) {
      await this.claims.forgetClaim(creatorHash);
      return null;
    }
    const outcome = await this.attach(settings, row, state, bot, creatorId, 'claim');
    if (outcome === 'retry') return outcome;
    // A token the user pasted in the meantime leaves the bot unlinked; every
    // other outcome settles it.
    if (outcome !== 'connector_has_token') await this.claims.markBotUsed(creatorHash, bot.id, this.now());
    await this.claims.forgetClaim(creatorHash);
    // The account pressed Start in the manager's chat, so it can be told there.
    if (outcome === 'connected') await this.say(settings, creatorId, CLAIM_LINKED_TEXT);
    else if (outcome === 'token_refused') await this.say(settings, creatorId, CLAIM_FAILED_TEXT);
    return outcome;
  }

  /**
   * A message in the manager bot's chat. Only `/start` from a person in
   * their own chat is looked at; everything else is ignored without an
   * answer.
   */
  private async handleStart(
    settings: ManagedBotSettings,
    message: TelegramMessage,
    updateId: number | null,
  ): Promise<ManagedBotUpdateOutcome> {
    const start = parseStartCommand(message.text);
    const senderId = personId(message.from);
    if (!start || senderId === null || message.from?.is_bot === true) return 'ignored';
    if (message.chat?.type !== 'private' || message.chat.id !== senderId) return 'ignored';
    // Telegram sent an update again that was answered already.
    if (updateId !== null && this.answeredStarts.has(updateId)) return 'ignored';
    const senderHash = hashTelegramUserId(senderId, settings.webhookSecret);
    if (!this.allowStart(senderHash)) return 'limited';

    // A parameter this server did not issue fails its keyed check: refused
    // like an unknown code, and nothing is looked up for it.
    const code = start.parameter ? codeFromClaimParameter(start.parameter, settings.webhookSecret) : null;
    const outcome = code
      ? await this.claim(settings, code, senderId, senderHash)
      : start.parameter
        ? await this.refuseClaim(settings, senderId, 'unknown_code')
        : await this.greet(settings, senderId);
    // 'retry' is asked for again by Telegram, and must then be handled.
    if (outcome !== 'retry' && updateId !== null) remember(this.answeredStarts, updateId);
    return outcome;
  }

  /** A plain /start: one neutral line, and nothing is looked up or stored. */
  private async greet(settings: ManagedBotSettings, senderId: number): Promise<ManagedBotUpdateOutcome> {
    await this.say(settings, senderId, MANAGER_GREETING_TEXT);
    return 'greeted';
  }

  /**
   * `/start <code>` from a Telegram account: that account says the setup is
   * its own. If it created a bot through this manager that is still to be
   * linked, the two are connected now; otherwise the setup waits for a bot
   * from that account.
   */
  private async claim(
    settings: ManagedBotSettings,
    code: string,
    senderId: number,
    senderHash: string,
  ): Promise<ManagedBotUpdateOutcome> {
    const row = await this.findSetupByCode(code, settings);
    const state = row ? readManagedBotState(row.config) : null;
    if (!row || !state || !isTelegram(row)) return this.refuseClaim(settings, senderId, 'unknown_code');
    const setup = { row, state };
    if (state.connectedAt || !isEmptyTelegramConnector(row)) {
      // Only the account that connected it is told so; anyone else learns nothing.
      const own = state.claimHash === senderHash || state.creatorHash === senderHash;
      return this.refuseClaim(
        settings,
        senderId,
        state.connectedAt ? 'already_connected' : 'connector_has_token',
        setup,
        own ? CLAIM_ALREADY_TEXT : CLAIM_INVALID_TEXT,
      );
    }
    if (!state.expiresAt || Date.parse(state.expiresAt) < this.now()) return this.refuseClaim(settings, senderId, 'expired', setup);
    // The first account to send a setup's code keeps it.
    if (state.claimHash && state.claimHash !== senderHash) return this.refuseClaim(settings, senderId, 'other_user', setup);
    if (!state.claimHash) {
      const won = await this.patchState(row, { claimHash: senderHash, claimedAt: new Date(this.now()).toISOString() }, 'claimedAt');
      if (won !== 1) {
        // Another /start for this setup was written at the same moment: whose?
        const again = await this.prisma.connector.findFirst({
          where: { id: row.id, organizationId: row.organizationId },
          select: { config: true },
        });
        if (readManagedBotState(again?.config)?.claimHash !== senderHash) {
          return this.refuseClaim(settings, senderId, 'other_user', setup);
        }
      }
    }
    // Written before the bot is looked for, as the bot's update is written
    // before the request is looked for: when the two arrive at the same
    // moment at two processes, at least one of them sees the other.
    await this.claims.rememberClaim(
      senderHash,
      { connectorId: row.id, organizationId: row.organizationId, expiresAt: Date.parse(state.expiresAt) },
      this.now(),
    );
    // Only ever a bot this very account created.
    const bot = await this.claims.botOf(senderHash, this.now());
    if (!bot) {
      await this.claimEvent('waiting', setup);
      await this.say(settings, senderId, CLAIM_WAITING_TEXT);
      return 'claimed';
    }

    const outcome = await this.attach(settings, row, state, { id: bot.botId, username: undefined }, senderId, 'claim');
    if (outcome === 'retry') return outcome;
    // Linked, or a bot Telegram hands out no token for: not offered again. A
    // token the user pasted in the meantime leaves the bot unlinked.
    if (outcome !== 'connector_has_token') await this.claims.markBotUsed(senderHash, bot.botId, this.now());
    if (outcome === 'connected') {
      await this.claims.forgetClaim(senderHash);
      await this.claimEvent('linked', setup);
      await this.say(settings, senderId, CLAIM_LINKED_TEXT);
      return outcome;
    }
    if (outcome === 'already_connected' || outcome === 'connector_has_token') {
      await this.refuseClaim(settings, senderId, outcome, setup, CLAIM_ALREADY_TEXT);
      return outcome;
    }
    await this.refuseClaim(settings, senderId, 'token_refused', setup, CLAIM_FAILED_TEXT);
    return 'token_refused';
  }

  private async refuseClaim(
    settings: ManagedBotSettings,
    senderId: number,
    kind: ClaimRefusal,
    setup?: { row: ConnectorRow; state: ManagedBotState },
    text: string = CLAIM_INVALID_TEXT,
  ): Promise<'refused'> {
    await this.claimEvent('refused', setup, kind);
    await this.say(settings, senderId, text);
    return 'refused';
  }

  /** One `telegram_bot_claim` per /start with a parameter. Never the sender, never the code. */
  private async claimEvent(
    status: 'linked' | 'waiting' | 'refused',
    setup?: { row: ConnectorRow; state: ManagedBotState },
    kind?: ClaimRefusal,
  ): Promise<void> {
    await this.productEvents.log({
      event: ProductEvents.TELEGRAM_BOT_CLAIM,
      userId: setup?.state.userId ?? null,
      organizationId: setup?.row.organizationId ?? null,
      metadata: {
        adapterSlug: TELEGRAM_SLUG,
        status,
        ...(kind ? { kind } : {}),
        ...(setup ? { connectorId: setup.row.id } : {}),
      },
    });
  }

  /** Whether one more /start is looked at this minute. */
  private allowStart(senderHash: string): boolean {
    const now = this.now();
    if (now - this.startWindow.at >= START_WINDOW_MS || now < this.startWindow.at) {
      this.startWindow = { at: now, count: 0, warned: false };
      this.startsBySender.clear();
    }
    if (this.startWindow.count >= START_MAX_PER_MINUTE) {
      if (!this.startWindow.warned) {
        this.startWindow.warned = true;
        this.logger.warn('Too many /start messages to the Telegram manager bot: the rest of this minute is not answered');
      }
      return false;
    }
    const mine = this.startsBySender.get(senderHash) ?? 0;
    if (mine >= START_MAX_PER_SENDER) return false;
    this.startWindow.count += 1;
    this.startsBySender.set(senderHash, mine + 1);
    return true;
  }

  /** One line in the manager bot's chat with a person who wrote to it. Best effort. */
  private async say(settings: ManagedBotSettings, chatId: number, text: string): Promise<void> {
    try {
      await this.call<unknown>(settings.token, 'sendMessage', { chat_id: chatId, text });
    } catch {
      // The setup does not depend on it.
    }
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
  private async storeToken(
    row: ConnectorRow,
    token: string,
    defaultChatId: number | null = null,
  ): Promise<'stored' | 'has_token' | 'failed'> {
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
        {
          ...stored,
          [TELEGRAM_TOKEN_VAR]: token,
          // Never over a default chat the workspace chose itself.
          ...(defaultChatId !== null && !stored[TELEGRAM_DEFAULT_CHAT_VAR]
            ? { [TELEGRAM_DEFAULT_CHAT_VAR]: String(defaultChatId) }
            : {}),
        },
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
        await this.welcome(row, token, chat, { claimFirst: true, client: state.client });
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
  private async welcome(
    row: ConnectorRow,
    token: string,
    chatId: number,
    opts: { claimFirst: boolean; client?: string },
  ): Promise<void> {
    try {
      const welcomedAt = new Date(this.now()).toISOString();
      if (opts.claimFirst && (await this.patchState(row, { welcomedAt }, 'welcomedAt')) !== 1) return;
      const sent = await this.call<unknown>(token, 'sendMessage', { chat_id: chatId, text: welcomeText(opts.client) });
      if (sent.ok && !opts.claimFirst) await this.patchState(row, { welcomedAt }, 'welcomedAt');
    } catch {
      // Best effort.
    }
  }

  // ── "Your assistant is connected" ─────────────────────────────────────

  /**
   * A request of an AI client reached the shared MCP endpoint for this
   * workspace (McpClientSeenRegistry: every tools/list, the first thing a
   * client does with a connection). Returns at once and never throws: the
   * request that triggered it must not wait for the database or for Telegram,
   * nor fail with them. At most one database read per workspace every few
   * seconds, and none while the feature is off.
   */
  noteClientSeen(seen: McpClientSeen): void {
    try {
      const { organizationId, userId } = seen ?? ({} as McpClientSeen);
      if (!organizationId || !userId || !this.settings()) return;
      const now = this.now();
      const last = this.lastClientCheck.get(organizationId);
      if (last !== undefined && now - last < CLIENT_SEEN_EVERY_MS && now >= last) return;
      if (this.lastClientCheck.size >= REMEMBERED_MAX) this.lastClientCheck.clear();
      this.lastClientCheck.set(organizationId, now);
      void this.announceClient(organizationId, userId).catch(() => undefined);
    } catch {
      // Best effort.
    }
  }

  /**
   * The second and last message of a one-tap bot to its creator: the AI
   * client is connected, and for Claude a button that opens a new chat with
   * the request typed in. Once per connector (`clientNoticeAt` is claimed
   * before the send, so two requests at the same moment send one message),
   * and only:
   * - for a bot created in one tap (not a pasted token) in the last 30 minutes;
   * - when the request is from the user who set it up;
   * - when the welcome could be delivered: before that, the creator has not
   *   pressed Start in the bot's chat and the bot cannot write to them.
   * Resolves to what it did, for the tests.
   */
  async announceClient(organizationId: string, userId: string): Promise<'none' | 'sent' | 'failed'> {
    const rows = await this.prisma.connector.findMany({
      where: { organizationId, config: { path: ['adapterSlug'], equals: TELEGRAM_SLUG } },
      select: ROW_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    for (const row of rows) {
      const state = readManagedBotState(row.config);
      if (!state || state.via !== 'managed_bot' || state.userId !== userId) continue;
      if (!state.connectedAt || !state.welcomedAt || state.clientNoticeAt) continue;
      const age = this.now() - Date.parse(state.connectedAt);
      if (age < 0 || age > CLIENT_NOTICE_WINDOW_MS) continue;
      const vars = row.envVars as Record<string, unknown> | null;
      const token = vars?.[TELEGRAM_TOKEN_VAR];
      const chat = vars?.[TELEGRAM_DEFAULT_CHAT_VAR];
      // The creator's chat, as stored when the bot was connected (a person's
      // chat id is a positive number).
      if (typeof token !== 'string' || !BOT_TOKEN_PATTERN.test(token) || typeof chat !== 'string' || !/^[0-9]{1,20}$/.test(chat)) {
        continue;
      }
      const clientNoticeAt = new Date(this.now()).toISOString();
      if ((await this.patchState(row, { clientNoticeAt }, 'clientNoticeAt')) !== 1) return 'none';

      const message = clientConnectedMessage(state.client, state.claude === true);
      const sent = await this.call<unknown>(token, 'sendMessage', {
        chat_id: Number(chat),
        text: message.text,
        ...(message.link
          ? { reply_markup: { inline_keyboard: [[{ text: message.link.label, url: message.link.url }]] } }
          : {}),
      });
      await this.productEvents.log({
        event: ProductEvents.TELEGRAM_BOT_CLIENT_NOTICE,
        userId,
        organizationId: row.organizationId,
        metadata: {
          adapterSlug: TELEGRAM_SLUG,
          connectorId: row.id,
          status: sent.ok ? 'sent' : 'failed',
          ...(state.client ? { client: state.client } : {}),
          // The message carried the link to a new chat (Claude only).
          ...(message.link ? { kind: 'chat_link' } : {}),
        },
      });
      if (!sent.ok) this.logger.warn(`A one-tap Telegram bot could not announce its AI client (${describe(sent)})`);
      return sent.ok ? 'sent' : 'failed';
    }
    return 'none';
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
      select: ROW_SELECT,
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
    unlessSet: 'openedAt' | 'connectedAt' | 'welcomedAt' | 'claimedAt' | 'claimOfferedAt' | 'clientNoticeAt',
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

/** The Telegram id of a person, or null. */
function personId(user: TelegramUser | undefined): number | null {
  return typeof user?.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
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
