/**
 * Advice appended to a *successful* tool result.
 *
 * WHY. An error carries a hint (error-hints.ts); a success that is not what
 * the user asked for carried nothing. In the week of 8-15 Nov 2026,
 * `telegram_bot_get_updates` answered `{"ok":true,"result":[]}` to 421 of the
 * 640 workspaces that called it, and 79 of them never saw a single message:
 * people ask the assistant to "read my Telegram messages", and a bot only
 * receives what is written to the bot. The empty list said none of that, so
 * the assistant reported "no messages" and the user stopped there.
 *
 * Keyed on the catalog adapter and the tool, like the error hints, so every
 * installed connector gets it without a catalog update. Pure: no I/O.
 */

export interface ResultHintInput {
  /** The catalog adapter the connector was installed from, if any. */
  adapterSlug?: string;
  toolName: string;
  /** The arguments the caller passed (before defaults). */
  args: Record<string, unknown>;
  /** The upstream answer, as returned to the client. */
  result: unknown;
}

export const TELEGRAM_NO_UPDATES_HINT =
  'Telegram returned no messages. That is normal when nobody wrote to the bot in the last 24 hours: ' +
  'a bot only receives what is sent to the bot itself. It sees a private chat only after that person ' +
  'opened the bot and pressed Start, and a group or channel only after it was added there (in a group ' +
  'it gets commands, replies to its own messages and @mentions only, unless privacy mode is turned off ' +
  "in @BotFather). It cannot read the user's own Telegram chats, or anything sent before it was added. " +
  'If the user expected messages, tell them this, give them the link to their bot ' +
  '(https://t.me/<username>, the username comes from telegram_bot_get_me), ask them to press Start and ' +
  'send a message there, then call this tool again. Do not call it again before they have done that.';

/** Telegram's `{ ok: true, result: [] }`. */
function isEmptyTelegramUpdates(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const body = result as { ok?: unknown; result?: unknown };
  return body.ok === true && Array.isArray(body.result) && body.result.length === 0;
}

/**
 * The hint for a successful call, or `undefined` when the result speaks for
 * itself (nearly always).
 */
export function deriveResultHint(input: ResultHintInput): string | undefined {
  if (input.adapterSlug === 'telegram-bot' && input.toolName === 'telegram_bot_get_updates') {
    // With `offset` the caller is confirming updates it has already read (a
    // polling loop): an empty answer is what it expects, on every round.
    const polling = input.args.offset !== undefined && input.args.offset !== null;
    if (!polling && isEmptyTelegramUpdates(input.result)) return TELEGRAM_NO_UPDATES_HINT;
  }
  return undefined;
}
