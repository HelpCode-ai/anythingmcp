import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';

/**
 * What the events of one authorization attempt have in common, and the split
 * tests of the pages a person sees during it.
 *
 * An attempt is one pending authorization: from the AI client's `/authorize`
 * to the code it gets back (or to the moment the person leaves). Reloads, the
 * round trip to Google and the detour through sign-up all stay inside it.
 */

/** 'mobile' (a phone or tablet browser) or 'desktop': the only two values the event store keeps. */
export type AttemptDevice = 'mobile' | 'desktop';

/** Whether the request comes from a phone or tablet browser, by its user agent. */
export function isPhoneUserAgent(userAgent: string | string[] | undefined): boolean {
  const ua = Array.isArray(userAgent) ? userAgent.join(' ') : (userAgent ?? '');
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

export function deviceOf(userAgent: string | string[] | undefined): AttemptDevice {
  return isPhoneUserAgent(userAgent) ? 'mobile' : 'desktop';
}

/**
 * The value that ties the events of one attempt together: the moment the
 * pending authorization expires, set once when it starts, as a short base-36
 * number. Nothing of the session itself is stored.
 */
export function attemptKey(expiresAt: number | null | undefined): string | undefined {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0
    ? Math.floor(expiresAt).toString(36)
    : undefined;
}

/**
 * The page a person sees after approving into an empty workspace:
 * - `control`: "Claude is connected", as before;
 * - `next_step`: a heading that says what is still to do, and the page goes
 *   on by itself once the one-tap Telegram bot is connected.
 */
export const CONNECTED_PAGE_ARMS = ['control', 'next_step'] as const;
export type ConnectedPageArm = (typeof CONNECTED_PAGE_ARMS)[number];

/**
 * `AUTHORIZE_CONNECTED_PAGE_TEST`: unset gives everyone `next_step` (the page
 * no longer says the client is connected before Continue); 'split' runs the
 * equal split; 'control' or 'next_step' gives everyone that arm; 'off' shows
 * the page as before and records no arm.
 */
export const CONNECTED_PAGE_TEST_ENV = 'AUTHORIZE_CONNECTED_PAGE_TEST';

/**
 * One of `arms` equal parts for a pending authorization, always the same for
 * one of them. The session id only seeds a hash; it is never stored.
 */
function armIndex(test: string, sessionId: string, arms: number): number {
  return createHash('sha256').update(`${test}:${sessionId}`).digest().readUInt32BE(0) % arms;
}

/**
 * The arm of a split test for one pending authorization, or null when the
 * test does not run: on a self-hosted instance, without a session, or with
 * the setting 'off'. Null means the control page and no arm on the events.
 * A setting that names an arm gives everyone that arm; any other value is
 * read as unset (an equal split).
 */
export function testArm<T extends string>(
  test: string,
  arms: readonly T[],
  sessionId: string | null | undefined,
  opts: { cloud: boolean; setting?: string | null },
): T | null {
  if (!opts.cloud || typeof sessionId !== 'string' || !sessionId) return null;
  const setting = (opts.setting ?? '').trim().toLowerCase();
  if (setting === 'off') return null;
  const forced = arms.find((arm) => arm === setting);
  if (forced) return forced;
  return arms[armIndex(test, sessionId, arms.length)];
}

export function connectedPageArm(
  sessionId: string | null | undefined,
  opts: { cloud: boolean; setting?: string | null },
): ConnectedPageArm | null {
  const setting = (opts.setting ?? '').trim().toLowerCase();
  // The equal split only when asked for. "Claude is connected" before the
  // client is connected contradicts the page the person sees next, so the
  // default is the heading that says what is still to do (2026-11-22).
  if (setting === 'split') return testArm('authorize-connected-page-v1', CONNECTED_PAGE_ARMS, sessionId, { cloud: opts.cloud });
  const known = setting === 'off' || CONNECTED_PAGE_ARMS.some((arm) => arm === setting);
  return testArm('authorize-connected-page-v1', CONNECTED_PAGE_ARMS, sessionId, {
    cloud: opts.cloud,
    setting: known ? setting : 'next_step',
  });
}

/**
 * The sign-in page inside an authorization (plan items A3 and A4):
 * - `control`: the page as before (English, sign-up box and consent box
 *   above the buttons on a computer);
 * - `buttons_first`: in the browser's language (one of the seven), one line
 *   on what the person gets, the provider buttons right under the heading on
 *   every screen, the consent box after them, and "create an account with
 *   email" as a link instead of the sign-up box.
 */
export const SIGNIN_PAGE_ARMS = ['control', 'buttons_first'] as const;
export type SignInPageArm = (typeof SIGNIN_PAGE_ARMS)[number];

/** `AUTHORIZE_SIGNIN_PAGE_TEST`: unset for the equal split, 'off', or one arm for everyone. */
export const SIGNIN_PAGE_TEST_ENV = 'AUTHORIZE_SIGNIN_PAGE_TEST';

export function signInPageArm(
  sessionId: string | null | undefined,
  opts: { cloud: boolean; setting?: string | null },
): SignInPageArm | null {
  return testArm('authorize-signin-page-v1', SIGNIN_PAGE_ARMS, sessionId, opts);
}

/**
 * The seven languages of the trial pages, as a bucket for the events: the
 * first language of the browser that is one of them, 'other' for any other
 * language, undefined when the browser names none.
 */
export const PAGE_LANGUAGES = ['en', 'de', 'it', 'es', 'zh', 'ja', 'ru'] as const;
export type PageLanguage = (typeof PAGE_LANGUAGES)[number];

/** The browser's languages by preference, as primary subtags (`de-AT` → `de`). */
function acceptedLanguages(header: string | string[] | undefined): string[] {
  const raw = (Array.isArray(header) ? header.join(',') : (header ?? '')).slice(0, 400);
  return raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase().split('-')[0], quality: Number.isNaN(quality) ? 0 : quality, index };
    })
    .filter((entry) => /^[a-z]{2,3}$/.test(entry.tag) && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.tag);
}

/** The first of the browser's languages a page of ours speaks, or null. */
export function pageLanguageFor(header: string | string[] | undefined): PageLanguage | null {
  for (const tag of acceptedLanguages(header)) {
    const known = PAGE_LANGUAGES.find((lang) => lang === tag);
    if (known) return known;
  }
  return null;
}

/** The language bucket of an event: the browser's first choice if we speak it, else 'other'. */
export function languageBucket(header: string | string[] | undefined): PageLanguage | 'other' | undefined {
  const first = acceptedLanguages(header)[0];
  if (!first) return undefined;
  return PAGE_LANGUAGES.find((lang) => lang === first) ?? 'other';
}

/**
 * What `/callback` knows about the attempt it finishes, for the
 * `authorization_code_issued` event. The OAuth store writes that event and
 * never sees the request, so the callback route carries this in an
 * AsyncLocalStorage (see AuthorizationAttemptMiddleware). Statistics only:
 * nothing in the authorization reads it.
 */
export interface AuthorizationAttemptContext {
  device: AttemptDevice;
  /** Resolves to the attempt key, or undefined when the session is gone. Never rejects. */
  attempt: Promise<string | undefined>;
  connectedArm?: ConnectedPageArm;
  signinArm?: SignInPageArm;
}

export const authorizationAttemptContext = new AsyncLocalStorage<AuthorizationAttemptContext>();
