import { sessionStore } from './storage';

/**
 * The GTM event for a sign-up whose email address has been verified. The
 * Google Ads conversion should trigger on this rather than on the register
 * form: a submitted form is not an account anyone can use, and on 24 Sep only
 * 19 of 51 sign-ups ever verified.
 */
export const SIGN_UP_VERIFIED_EVENT = 'sign_up_verified';

/**
 * Tell GTM a sign-up was verified. Does nothing unless GTM is on the page:
 * `window.dataLayer` exists only when GTM_ID is set, i.e. on AnythingMCP
 * Cloud, so a self-hosted instance never emits anything.
 *
 * `once` names this verification (a user id, a spent link token) and keeps a
 * re-render, a remount or a second tab from counting it twice. It stays in
 * this browser; the event itself carries only how the address was verified,
 * never who.
 */
export function pushSignUpVerified(once: string, method: 'code' | 'link'): void {
  if (typeof window === 'undefined') return;
  const dataLayer = window.dataLayer;
  if (!Array.isArray(dataLayer)) return;
  const key = `amcp_sign_up_verified:${once}`;
  try {
    if (sessionStore.get(key)) return;
    sessionStore.set(key, '1');
    dataLayer.push({ event: SIGN_UP_VERIFIED_EVENT, method });
  } catch {
    // a lost conversion must not break verification
  }
}
