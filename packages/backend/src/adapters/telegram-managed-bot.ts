import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

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
 * the update finds its connector.
 *
 * A USERNAME THE USER CHANGED carries no code. Telegram still says who created
 * the bot, so the page offers a second link, `t.me/<manager>?start=<code>`:
 * pressing Start there sends the manager bot `/start <code>` from the user's
 * own Telegram account. The setup is then connected to the bot that same
 * account created through this manager, whichever of the two comes first (see
 * telegram-claim.store.ts for what is remembered in between). Pasting the
 * bot's token stays the last resort.
 *
 * AFTER THE BOT IS CONNECTED one step is left: the AI client's authorization
 * is only finished by "Continue" on the page. The bot's welcome message says
 * so, and when the client's first request arrives the bot writes once more:
 * the assistant is connected (see TelegramManagedBotService.noteClientSeen).
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

/** After a one-tap bot is connected, its AI client's first request is announced this long. */
export const CLIENT_NOTICE_WINDOW_MS = 30 * 60 * 1000;

/**
 * The AI client's name as the messages quote it, or null for one that does
 * not read like a name. It comes from the client's own registration, so only
 * a short run of letters, digits, spaces and a few signs is kept.
 */
export function cleanClientName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} .&+'()_-]{0,39}$/u.test(clean) ? clean : null;
}

/**
 * The message the new bot sends its creator when it is connected. The AI
 * client is not connected yet at that moment: its authorization is finished
 * by "Continue" on the page, so the message sends the user back there and not
 * to the chat.
 */
export function welcomeText(client?: string | null): string {
  const button = client ? `"Continue to ${client}"` : 'Continue';
  return `Your bot is connected to AnythingMCP. One step left: go back to the page you came from and tap ${button}.`;
}

/** Claude opens a new chat with a request typed in from this address. */
export const CLAUDE_NEW_CHAT_URL = 'https://claude.ai/new';

/**
 * The second message, sent when the AI client's first request arrives: the
 * assistant is connected, and what to ask it. `link`: for Claude, a new chat
 * with that request typed in, sent as a button under the message.
 */
export function clientConnectedMessage(
  client: string | null | undefined,
  claude: boolean,
): { text: string; link?: { label: string; url: string } } {
  const text = `${client || 'Your AI assistant'} is now connected to AnythingMCP. Ask it: "${TELEGRAM_CONNECTED_REQUEST}"`;
  if (!claude) return { text };
  return {
    text,
    link: {
      label: 'Open a new chat in Claude',
      url: `${CLAUDE_NEW_CHAT_URL}?q=${encodeURIComponent(TELEGRAM_CONNECTED_REQUEST)}`,
    },
  };
}

/**
 * What the manager bot answers in its own chat. One short line each, so
 * nobody is left in an empty chat; a code that cannot be used gets the same
 * line whatever the reason, so the answers say nothing about other setups.
 */
export const CLAIM_LINKED_TEXT = 'Your bot is connected to AnythingMCP. Go back to the page you came from and tap Continue there.';
export const CLAIM_WAITING_TEXT =
  'No new bot found for your Telegram account yet. Create it with the button on the AnythingMCP page: it is connected as soon as it exists.';
export const CLAIM_INVALID_TEXT = 'This link is no longer valid. Go back to AnythingMCP to finish setting up Telegram.';
export const CLAIM_ALREADY_TEXT = 'Telegram is already connected. Go back to the page you came from and tap Continue there.';
export const CLAIM_FAILED_TEXT = 'Your bot could not be linked. Go back to the page and paste the bot’s token there.';
export const MANAGER_GREETING_TEXT =
  'This bot creates Telegram bots for AnythingMCP. Start from the AnythingMCP page that sent you here.';

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
 * A `tg://` link opened in Telegram's web client. On a computer the t.me page
 * of a creation link only offers the Telegram app; someone who uses Telegram
 * in the browser needs this address instead. Web A (`/a/`) is the web client
 * that handles creation links; `tgaddr` is how Telegram's own pages hand a
 * link to it.
 */
export function telegramWebLink(tgUrl: string): string {
  return `https://web.telegram.org/a/#?tgaddr=${encodeURIComponent(tgUrl)}`;
}

/** The creation link, for Telegram in the browser. */
export function creationWebLink(managerUsername: string, code: string, name = SUGGESTED_BOT_NAME): string {
  return telegramWebLink(
    `tg://newbot?manager=${encodeURIComponent(managerUsername)}&username=${suggestedUsername(code)}&name=${encodeURIComponent(name)}`,
  );
}

/** A setup code as issued by newSetupCode. */
export const SETUP_CODE_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Where the QR code of the creation link points: an address of this server
 * that sends the phone on to Telegram, so a scan can be counted (a QR code
 * that held the t.me link itself told the server nothing).
 */
export function qrPath(code: string): string {
  return `/auth/first-app/telegram/qr/${code}`;
}

/** Hex characters of the keyed check that follows the code in a `/start` parameter. */
const CLAIM_CHECK_LENGTH = 16;

/**
 * What `/start` carries for a setup: the code, then a check keyed with the
 * webhook secret. Anyone can write to the manager bot, and a setup code alone
 * is eight hex characters (it has to fit a bot username): with the check a
 * parameter cannot be guessed, and one that was not issued by this server is
 * refused before anything is looked up.
 */
export function claimParameter(code: string, webhookSecret: string): string {
  const check = createHmac('sha256', webhookSecret).update(`claim:${code.toLowerCase()}`).digest('hex');
  return `${code.toLowerCase()}${check.slice(0, CLAIM_CHECK_LENGTH)}`;
}

/** The setup code of a `/start` parameter this server issued, or null. Constant time. */
export function codeFromClaimParameter(parameter: unknown, webhookSecret: string): string | null {
  if (typeof parameter !== 'string' || !/^[0-9a-f]{24}$/i.test(parameter)) return null;
  const code = parameter.slice(0, 8).toLowerCase();
  const given = Buffer.from(parameter.toLowerCase());
  const expected = Buffer.from(claimParameter(code, webhookSecret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? code : null;
}

/**
 * The link that opens the manager bot's chat with the setup's parameter:
 * pressing Start there sends `/start <parameter>`, which tells the server
 * which Telegram account belongs to the setup. For a bot whose username the
 * user changed.
 */
export function claimLink(managerUsername: string, code: string, webhookSecret: string): string {
  return `https://t.me/${encodeURIComponent(managerUsername)}?start=${claimParameter(code, webhookSecret)}`;
}

/** The link that claims a renamed bot, for Telegram in the browser. */
export function claimWebLink(managerUsername: string, code: string, webhookSecret: string): string {
  return telegramWebLink(
    `tg://resolve?domain=${encodeURIComponent(managerUsername)}&start=${claimParameter(code, webhookSecret)}`,
  );
}

/**
 * A `/start` sent to the manager bot: null for any other text, otherwise its
 * parameter (`''` for a plain /start). Whether the parameter names a setup is
 * for codeFromClaimParameter to say.
 */
export function parseStartCommand(text: unknown): { parameter: string } | null {
  if (typeof text !== 'string' || text.length > 128) return null;
  const match = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  return { parameter: match[1] ?? '' };
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
 * - claimHash, claimedAt: hashTelegramUserId of the Telegram account that
 *   sent the manager bot `/start <code>` for this setup, and when. The first
 *   account wins; only a bot that account created is ever connected
 * - matched: 'claim' when the bot was found through that claim, not by its
 *   username
 * - claimOfferedAt: the page reported showing "Link your bot" (once)
 * - client, claude: the AI client the page was shown for (cleanClientName),
 *   and whether it is Claude: for the bot's two messages
 * - clientNoticeAt: the "your assistant is connected" message was claimed
 *   (sent, or tried once)
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
  claimHash?: string;
  claimedAt?: string;
  matched?: 'claim';
  claimOfferedAt?: string;
  client?: string;
  claude?: true;
  clientNoticeAt?: string;
}

const DATE_KEYS = [
  'expiresAt',
  'startedAt',
  'openedAt',
  'connectedAt',
  'welcomedAt',
  'claimedAt',
  'claimOfferedAt',
  'clientNoticeAt',
] as const;

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
  if (typeof source.claimHash === 'string' && /^[0-9a-f]{64}$/.test(source.claimHash)) out.claimHash = source.claimHash;
  if (source.matched === 'claim') out.matched = 'claim';
  const client = cleanClientName(source.client);
  if (client) out.client = client;
  if (source.claude === true) out.claude = true;
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
  begin(input: {
    connectorId: string;
    organizationId: string;
    userId: string;
    /** The AI client being connected: its name, and whether it is Claude. */
    client?: { name: string; claude: boolean };
  }): Promise<TelegramOneTapStart | null>;
  status(input: {
    organizationId: string;
    userId: string;
    opened?: boolean;
    /** Which link was clicked: the Telegram app's, or Telegram in the browser. */
    openedVia?: 'app' | 'web';
    /** The page shows "Link your bot" now (reported once). */
    claimOffered?: boolean;
    device?: 'mobile' | 'desktop';
  }): Promise<TelegramOneTapStatus>;
  saveToken(input: { organizationId: string; userId: string; token: unknown }): Promise<TelegramTokenAnswer>;
  /**
   * The QR code of a creation link was scanned: notes it once and answers
   * with the Telegram link to send the phone to. Null when the feature is
   * off or the code is not one of ours.
   */
  qrScanned(code: unknown): Promise<string | null>;
}

/** What a setup hands the page. */
export interface TelegramOneTapStart {
  link: string;
  username: string;
  claimLink: string;
  /** The same two links for Telegram in the browser (a computer without the app). */
  webLink: string;
  claimWebLink: string;
  /** The path on this server the creation link's QR code points to. */
  qrPath: string;
}

export type TelegramOneTapStatus =
  | { state: 'none' | 'expired' }
  | {
      state: 'waiting';
      /**
       * A bot with another username was created through this manager since
       * this setup's link was offered. Not tied to this user (Telegram does
       * not say whose setup a bot is for): it only makes the page offer
       * "Link your bot" at once instead of after a wait.
       */
      unmatched?: true;
      /** The user's Telegram account is linked to this setup; its bot does not exist yet. */
      claimed?: true;
    }
  | {
      state: 'connected';
      /** `@username`, when known. */
      bot?: string;
      /** The bot's chat, while the user has not pressed Start there yet. */
      startUrl?: string;
    };

export type TelegramTokenAnswer = { ok: true; bot?: string } | { ok: false; error: string };
