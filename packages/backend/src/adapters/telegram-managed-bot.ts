import { createHmac, randomBytes } from 'crypto';

/**
 * A Telegram bot created with one tap, instead of a chat with @BotFather.
 *
 * WHY. Picking Telegram on the page after approving an AI client adds an
 * empty connector: the user still has to create a bot with @BotFather, copy
 * its token and paste it on a setup page. Of 931 such picks in a week, 42%
 * ever worked and 405 never reached the setup page.
 *
 * HOW. Bot API 9.6 "managed bots": this instance owns one manager bot (Bot
 * Management Mode on in @BotFather). A link
 * `t.me/newbot/<manager>/<suggested username>?name=<suggested name>` opens
 * Telegram with both filled in; the user confirms with one tap. Telegram then
 * sends the manager bot a `managed_bot` update, and `getManagedBotToken`
 * returns the new bot's token, which is stored on the connector.
 *
 * The suggested username carries a random code, and the connector keeps that
 * code's HMAC with an expiry in its `config` (no schema change): that is how
 * the update finds its connector. A user who changes the username in Telegram
 * cannot be matched; they paste the bot's token instead.
 *
 * Pure functions only (settings, code, link, state); the work is in
 * TelegramManagedBotService.
 */

export const TELEGRAM_SLUG = 'telegram-bot';
export const TELEGRAM_TOKEN_VAR = 'TELEGRAM_BOT_TOKEN';
/** The chat the send tools write to when a call names none (the adapter's `envDefaults`). */
export const TELEGRAM_DEFAULT_CHAT_VAR = 'TELEGRAM_DEFAULT_CHAT_ID';

/** Injection token of the service, for modules that cannot import the adapters' module. */
export const TELEGRAM_ONE_TAP = 'TELEGRAM_ONE_TAP';

/** Key in `connectors.config` that holds a setup's state; no schema change. */
export const MANAGED_BOT_CONFIG_KEY = 'telegramManagedBot';

/** A setup can be finished this long after Telegram was picked (the page's own pause is 30 minutes at most). */
export const MANAGED_BOT_TTL_MS = 30 * 60 * 1000;

/** After the bot is connected, its first /start is looked for this long, to greet the user. */
export const WELCOME_WINDOW_MS = 15 * 60 * 1000;

/** The name Telegram suggests for the new bot; the user can change it. */
export const SUGGESTED_BOT_NAME = 'My AnythingMCP bot';

/** What the page suggests asking once the bot is connected. */
export const TELEGRAM_CONNECTED_REQUEST = 'Send me a test message on Telegram.';

/** The one message the new bot sends its creator. */
export const WELCOME_TEXT =
  'Your bot is connected to AnythingMCP. Go back to your AI assistant and ask: "Send me a test message on Telegram."';

/** Telegram's rule for a bot token, as in the catalog adapter. */
export const BOT_TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]{30,}$/;

/** Telegram accepts these characters in a webhook secret; under 16 is refused here as too easy to guess. */
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export interface ManagedBotSettings {
  /** The manager bot's token. Never logged. */
  token: string;
  /** Sent back by Telegram in `X-Telegram-Bot-Api-Secret-Token`. Never logged. */
  webhookSecret: string;
  /** When set, only these workspaces are offered the one-tap setup. */
  organizationIds: ReadonlySet<string> | null;
}

export type ManagedBotSettingsProblem = 'no_webhook_secret' | 'bad_webhook_secret' | 'bad_token';

/**
 * The feature's settings, or why it is off. No manager token means off, and
 * is not a problem: it is the default.
 */
export function readManagedBotSettings(
  env: Record<string, string | undefined> = process.env,
): { settings: ManagedBotSettings } | { settings: null; problem?: ManagedBotSettingsProblem } {
  const token = (env.TELEGRAM_MANAGER_BOT_TOKEN ?? '').trim();
  if (!token) return { settings: null };
  if (!BOT_TOKEN_PATTERN.test(token)) return { settings: null, problem: 'bad_token' };
  const webhookSecret = (env.TELEGRAM_MANAGER_WEBHOOK_SECRET ?? '').trim();
  if (!webhookSecret) return { settings: null, problem: 'no_webhook_secret' };
  if (!WEBHOOK_SECRET_PATTERN.test(webhookSecret)) return { settings: null, problem: 'bad_webhook_secret' };
  const ids = (env.TELEGRAM_MANAGED_BOT_ORG_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return { settings: { token, webhookSecret, organizationIds: ids.length ? new Set(ids) : null } };
}

/** Whether a workspace is offered the one-tap setup: everyone, or the allowlist when one is set. */
export function isOrganizationAllowed(settings: ManagedBotSettings, organizationId: string): boolean {
  return !settings.organizationIds || settings.organizationIds.has(organizationId);
}

/** A new setup code: 8 hex characters, carried by the suggested username. */
export function newSetupCode(): string {
  return randomBytes(4).toString('hex');
}

/** `amcp_<code>_bot`: 17 characters, within Telegram's 5 to 32, ending in `bot`. */
export function suggestedUsername(code: string): string {
  return `amcp_${code}_bot`;
}

/** The setup code a bot's username carries, or null (a username the user changed, or any other bot). */
export function codeFromUsername(username: unknown): string | null {
  if (typeof username !== 'string') return null;
  const match = /^amcp_([0-9a-f]{8})_bot$/i.exec(username.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * What is stored instead of the code: keyed with the webhook secret, so the
 * value in a connector's config cannot be turned back into a username.
 */
export function hashSetupCode(code: string, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(`code:${code.toLowerCase()}`).digest('hex');
}

/** The creator's Telegram id, keyed the same way: enough to recognise their /start, without keeping the id. */
export function hashTelegramUserId(userId: number, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(`user:${userId}`).digest('hex');
}

/** The link that opens Telegram on "create this bot", managed by `managerUsername`. */
export function creationLink(managerUsername: string, code: string, name = SUGGESTED_BOT_NAME): string {
  return `https://t.me/newbot/${encodeURIComponent(managerUsername)}/${suggestedUsername(code)}?name=${encodeURIComponent(name)}`;
}

/**
 * Where Telegram posts the manager bot's updates, or null when the server has
 * no public https address (Telegram only delivers to https).
 */
export function managerWebhookUrl(serverUrl: string | undefined | null): string | null {
  let url: URL;
  try {
    url = new URL((serverUrl ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':')
  ) {
    return null;
  }
  return `${url.origin}${MANAGER_WEBHOOK_PATH}`;
}

export const MANAGER_WEBHOOK_PATH = '/api/telegram/manager-webhook';

/**
 * A setup, as kept in the connector's config (ISO dates).
 *
 * - codeHash: hashSetupCode of the code in the suggested username
 * - expiresAt: the code is refused after this
 * - startedAt, userId: when Telegram was picked, and by whom (for the events)
 * - openedAt: the page reported a click on the link (once)
 * - connectedAt: the connector got its token, from Telegram or pasted
 * - via: how: 'managed_bot' (one tap) or 'pasted'
 * - botUsername: the bot's username, shown on the page
 * - creatorHash: hashTelegramUserId of the user who created the bot
 * - welcomedAt: the welcome message was claimed (sent, or tried once)
 */
export interface ManagedBotState {
  codeHash?: string;
  expiresAt?: string;
  startedAt?: string;
  userId?: string;
  openedAt?: string;
  connectedAt?: string;
  via?: 'managed_bot' | 'pasted';
  botUsername?: string;
  creatorHash?: string;
  welcomedAt?: string;
}

const DATE_KEYS = ['expiresAt', 'startedAt', 'openedAt', 'connectedAt', 'welcomedAt'] as const;

export function readManagedBotState(config: unknown): ManagedBotState | null {
  const raw = (config as Record<string, unknown> | null | undefined)?.[MANAGED_BOT_CONFIG_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: ManagedBotState = {};
  for (const key of DATE_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) out[key] = v;
  }
  if (typeof source.codeHash === 'string' && /^[0-9a-f]{64}$/.test(source.codeHash)) out.codeHash = source.codeHash;
  if (typeof source.creatorHash === 'string' && /^[0-9a-f]{64}$/.test(source.creatorHash)) {
    out.creatorHash = source.creatorHash;
  }
  if (typeof source.userId === 'string' && source.userId) out.userId = source.userId;
  if (source.via === 'managed_bot' || source.via === 'pasted') out.via = source.via;
  if (typeof source.botUsername === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(source.botUsername)) {
    out.botUsername = source.botUsername;
  }
  return out;
}

/**
 * A Telegram connector still without a token: its address keeps the catalog
 * placeholder and the variable is empty. One whose address was edited, or
 * that holds any value, counts as set up and is never written to.
 */
export function isEmptyTelegramConnector(c: { baseUrl: string | null; envVars: unknown }): boolean {
  const value = (c.envVars as Record<string, unknown> | null)?.[TELEGRAM_TOKEN_VAR];
  const hasValue = typeof value === 'string' ? value.trim() !== '' : value != null;
  return !hasValue && (c.baseUrl ?? '').includes(`{{${TELEGRAM_TOKEN_VAR}}}`);
}

/** What the page after approving an AI client needs from the service. */
export interface TelegramOneTap {
  isEnabledFor(organizationId: string): boolean;
  begin(input: { connectorId: string; organizationId: string; userId: string }): Promise<{ link: string; username: string } | null>;
  status(input: {
    organizationId: string;
    userId: string;
    opened?: boolean;
    device?: 'mobile' | 'desktop';
  }): Promise<TelegramOneTapStatus>;
  saveToken(input: { organizationId: string; userId: string; token: unknown }): Promise<TelegramTokenAnswer>;
}

export type TelegramOneTapStatus =
  | { state: 'none' | 'waiting' | 'expired' }
  | {
      state: 'connected';
      /** `@username`, when known. */
      bot?: string;
      /** The bot's chat, while the user has not pressed Start there yet. */
      startUrl?: string;
    };

export type TelegramTokenAnswer = { ok: true; bot?: string } | { ok: false; error: string };
