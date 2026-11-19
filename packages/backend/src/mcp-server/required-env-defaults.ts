import { TELEGRAM_NO_CHAT_REFUSAL } from './error-hints';

/**
 * A catalog parameter that the vendor requires, that the tool lets the caller
 * leave out because a connector variable fills it (`endpointMapping.envDefaults`),
 * and that is still empty after the defaults were applied: the call is refused
 * here instead of being sent.
 *
 * WHY. The Telegram send tools fill `chat_id` from TELEGRAM_DEFAULT_CHAT_ID.
 * When the call names no chat and the connector has no default chat, the
 * request still went out with an empty `chat_id`, and Telegram answered
 * "Bad Request: chat_id is empty" (15 calls in 13 connectors on Cloud in one
 * day). The error hint explained it afterwards; nothing needs the round trip.
 *
 * Why a list and not every envDefaults parameter. Most of them are optional at
 * the vendor: a Mirakl marketplace uses the account's default shop when
 * `shop_id` is left out, so refusing an empty `shop_id` would break those
 * calls. Only parameters listed here are checked, and only on tools whose
 * installed mapping still names a default for them.
 */
const REQUIRED_ENV_DEFAULTS: Record<string, Record<string, string>> = {
  'telegram-bot': { chat_id: TELEGRAM_NO_CHAT_REFUSAL },
};

/** Raised before any request is sent; `code` reaches the client with the message. */
export class MissingDefaultArgumentError extends Error {
  readonly code = 'MISSING_ARGUMENT';
  constructor(readonly param: string, message: string) {
    super(message);
    this.name = 'MissingDefaultArgumentError';
  }
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * The refusal for a call whose required default stayed empty, or undefined.
 * `params` are the arguments after env and schema defaults were applied.
 */
export function missingRequiredDefault(
  adapterSlug: string | undefined,
  endpointMapping: unknown,
  params: Record<string, unknown>,
): MissingDefaultArgumentError | undefined {
  const rules = adapterSlug ? REQUIRED_ENV_DEFAULTS[adapterSlug] : undefined;
  if (!rules) return undefined;
  const defaults = (endpointMapping as { envDefaults?: unknown } | null | undefined)?.envDefaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return undefined;

  for (const [param, message] of Object.entries(rules)) {
    if (typeof (defaults as Record<string, unknown>)[param] !== 'string') continue;
    if (isEmpty(params[param])) return new MissingDefaultArgumentError(param, message);
  }
  return undefined;
}
