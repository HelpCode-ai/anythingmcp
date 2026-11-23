import { returnAssistant } from './return-assistant';

/**
 * An AI client's authorization that this browser started and has not finished
 * ("Connect" in Claude, then a detour through the dashboard: a sign-up, the
 * card-trial offer, a wrong tab). The backend keeps it for 30 minutes in
 * httpOnly cookies the dashboard cannot read, so the dashboard asks:
 *
 *   GET /auth/pending  →  { pending: false }
 *                      |  { pending: true, client: "Claude", step: "allow" | "continue" }
 *
 * Cloud only. Any failure (network, a status other than 200, a body that is
 * not this shape) means "nothing is waiting": the way back is an offer, never
 * something to get wrong.
 */
export type PendingAuthorizationStep = 'allow' | 'continue';

export interface PendingAuthorization {
  /** The client's own name, cleaned and cut for display; null when it gave none. */
  client: string | null;
  step: PendingAuthorizationStep;
}

/** Longest client name shown. The name is free text chosen by the AI client. */
export const CLIENT_NAME_MAX = 40;

/**
 * A client name fit to show as text: no control or direction-override
 * characters, single spaces, at most CLIENT_NAME_MAX characters. Rendering it
 * as text (never as HTML) is the caller's part.
 */
export function displayClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  if (chars.length <= CLIENT_NAME_MAX) return clean;
  return `${chars.slice(0, CLIENT_NAME_MAX - 1).join('').trimEnd()}…`;
}

/** The answer of GET /auth/pending, or null for anything that is not a waiting authorization. */
export function parsePendingAuthorization(body: unknown): PendingAuthorization | null {
  if (!body || typeof body !== 'object') return null;
  const { pending, client, step } = body as { pending?: unknown; client?: unknown; step?: unknown };
  if (pending !== true || (step !== 'allow' && step !== 'continue')) return null;
  return { client: displayClientName(client), step };
}

/**
 * Where the authorization goes on: the consent page while it is not allowed
 * yet, `/callback` once only "Continue" is missing. Both are backend pages on
 * this origin, so they need a full navigation. Always one of these two
 * constants, never a value from the answer.
 */
export function pendingAuthorizationPath(step: PendingAuthorizationStep): '/auth/login' | '/callback' {
  return step === 'continue' ? '/callback' : '/auth/login';
}

/** Asks the backend; null when nothing is waiting or the question failed. */
export async function fetchPendingAuthorization(timeoutMs = 5000): Promise<PendingAuthorization | null> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch('/auth/pending', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (response.status !== 200) return null;
    return parsePendingAuthorization(await response.json());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The display name for the `client` query of the sign-up an authorization
 * page opens ('claude', 'chatgpt', 'muse', 'other'). The value comes from a
 * URL, so it is only looked up in the fixed list of assistants; anything else
 * is null and the page says "your AI assistant".
 */
export function signUpClientName(client: string | null | undefined): string | null {
  const assistant = returnAssistant((client ?? '').toLowerCase());
  return assistant && assistant.id !== 'assistant' ? assistant.name : null;
}
