/**
 * Sign-up attribution on the cloud app: where a new account came from.
 *
 * The marketing site hands its touches over as `amcp_src` (first touch) and
 * `amcp_lt` (last touch; absent when it equals the first), each a base64url
 * JSON object. A visitor who came straight here (from Google, GitHub, ChatGPT
 * or a bookmark) has none, so this page builds its own touch from its URL's
 * campaign tags and the referrer's host. The result travels with the register
 * request as `attribution` and the backend records it for a newly created
 * account only.
 *
 * Campaign-level, with one exception: a Google Ads click id (gclid, gbraid,
 * wbraid) travels only with `ad_consent: 'granted'`, so a purchase can later
 * be reported to Google Ads as an offline conversion. The site sends it only
 * with consent; for the touch this page builds itself, the id is kept only if
 * the visitor allowed marketing cookies in this app's own banner, and is
 * otherwise reduced to `paid: true`. The backend drops any id without that
 * consent again. A referrer is its host, a path loses its query string, and
 * anything that looks like an email address is dropped. The key set matches
 * the backend's SignupTouchDto exactly: the global ValidationPipe answers an
 * unknown key with a 400, so nothing else may be sent.
 */
import { sessionStore } from './storage';

export type AdConsent = 'granted' | 'denied' | 'unknown';
export type ClickIdKey = 'gclid' | 'gbraid' | 'wbraid';
export type ClickIds = Partial<Record<ClickIdKey, string>>;

export type Touch = ClickIds & {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gad_source?: string;
  gad_campaignid?: string;
  paid?: boolean;
  referrer_host?: string;
  landing_path?: string;
  ts?: number;
  captured_on?: 'site' | 'cloud';
  /** Click ids are present only next to 'granted'. */
  ad_consent?: AdConsent;
};

export type SignupAttribution = { first_touch?: Touch; last_touch?: Touch };

const MAX_FIELD = 100;
const STRING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gad_source',
  'gad_campaignid',
] as const;
/** Google Ads click ids, in the order Google prefers them. */
export const CLICK_ID_KEYS: readonly ClickIdKey[] = ['gclid', 'gbraid', 'wbraid'];
const MAX_CLICK_ID = 150;
const AD_CONSENT_VALUES: readonly AdConsent[] = ['granted', 'denied', 'unknown'];

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_FIELD);
  if (!v || v.includes('@')) return undefined;
  return v;
}

/** A Google Ads click id, or undefined for anything that is not one. */
export function cleanClickId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v || v.length > MAX_CLICK_ID || !/^[A-Za-z0-9_-]+$/.test(v)) return undefined;
  return v;
}

const hasClickId = (touch: Touch | undefined) => !!touch && CLICK_ID_KEYS.some((k) => touch[k]);

function cleanHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/^www\./, '');
  if (!host || host.length > MAX_FIELD || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  return host;
}

function cleanPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.split(/[?#]/)[0];
  return path.startsWith('/') ? cleanString(path) : undefined;
}

/** Only the keys the backend accepts, each within its bounds. */
export function sanitizeTouch(input: unknown): Touch | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: Touch = {};
  for (const key of STRING_KEYS) {
    const v = cleanString(raw[key]);
    if (v) out[key] = v;
  }
  if (raw.paid === true) out.paid = true;
  const host = cleanHost(raw.referrer_host);
  if (host) out.referrer_host = host;
  const path = cleanPath(raw.landing_path);
  if (path) out.landing_path = path;
  if (typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts > 0) out.ts = Math.floor(raw.ts);
  if (raw.captured_on === 'site' || raw.captured_on === 'cloud') out.captured_on = raw.captured_on;
  if (AD_CONSENT_VALUES.includes(raw.ad_consent as AdConsent)) out.ad_consent = raw.ad_consent as AdConsent;
  // Never a click id without consent; the backend enforces the same rule.
  if (out.ad_consent === 'granted') {
    for (const key of CLICK_ID_KEYS) {
      const v = cleanClickId(raw[key]);
      if (v) out[key] = v;
    }
    if (hasClickId(out)) out.paid = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The touch without its click ids, for when this app's own banner says no. */
function withoutClickIds(touch: Touch | undefined): Touch | undefined {
  if (!touch) return undefined;
  const rest: Touch = { ...touch };
  for (const key of CLICK_ID_KEYS) delete rest[key];
  if (rest.ad_consent) rest.ad_consent = 'denied';
  return rest;
}

/** A touch from its base64url JSON form; undefined for anything else. */
export function decodeTouch(value: string | null | undefined): Touch | undefined {
  if (!value || value.length > 4096) return undefined;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    return sanitizeTouch(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/**
 * The touch this page's own URL represents, for a visitor the marketing site
 * did not hand over. A referrer from this very host is navigation inside the
 * app, not a source; the marketing site is kept, since it then means the
 * visitor came from the site without its touch (script blocked, old link).
 *
 * An ad click id in the URL always makes the touch `paid`; the id itself is
 * kept only when `adConsent` (this app's own cookie banner) is 'granted'.
 */
export function touchFromUrl(
  href: string,
  referrer: string | null | undefined,
  now: number,
  adConsent: AdConsent = 'unknown',
): Touch {
  const touch: Touch = { ts: now, captured_on: 'cloud' };
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  if (url) {
    for (const key of STRING_KEYS) {
      const v = cleanString(url.searchParams.get(key));
      if (v) touch[key] = v;
    }
    if (CLICK_ID_KEYS.some((p) => url!.searchParams.has(p))) {
      touch.paid = true;
      touch.ad_consent = adConsent;
      if (adConsent === 'granted') {
        for (const key of CLICK_ID_KEYS) {
          const v = cleanClickId(url.searchParams.get(key));
          if (v) touch[key] = v;
        }
      }
    }
    const path = cleanPath(url.pathname);
    if (path) touch.landing_path = path;
  }
  if (referrer) {
    try {
      const refHost = new URL(referrer).hostname.toLowerCase();
      if (!url || refHost !== url.hostname.toLowerCase()) {
        const host = cleanHost(refHost);
        if (host) touch.referrer_host = host;
      }
    } catch {
      // unparsable referrer: no source
    }
  }
  return touch;
}

/**
 * What this page load says: the site's hand-over if present, else its own
 * touch. The site hands a click id over only with consent; should this app's
 * own banner say 'denied' (consent withdrawn since), the ids are dropped.
 */
export function attributionFromLanding(
  href: string,
  referrer: string | null | undefined,
  now: number,
  adConsent: AdConsent = 'unknown',
): { attribution: SignupAttribution; handedOver: boolean } {
  let params: URLSearchParams | null = null;
  try {
    params = new URL(href).searchParams;
  } catch {
    params = null;
  }
  const allow = (t: Touch | undefined) => (adConsent === 'denied' ? withoutClickIds(t) : t);
  const first = allow(decodeTouch(params?.get('amcp_src')));
  if (first) {
    const last = allow(decodeTouch(params?.get('amcp_lt')));
    return { attribution: last ? { first_touch: first, last_touch: last } : { first_touch: first }, handedOver: true };
  }
  return { attribution: { first_touch: touchFromUrl(href, referrer, now, adConsent) }, handedOver: false };
}

/**
 * The categories accepted in the cookie banner (components/cookie-consent.tsx,
 * cookie `cc_cookie`), or null when the visitor has not answered it.
 */
function consentedCategories(cookieHeader: string | null | undefined): string[] | null {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('cc_cookie='));
  if (!entry) return null;
  const raw = entry.slice('cc_cookie='.length);
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    // keep the raw form only
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { categories?: unknown };
      return Array.isArray(parsed.categories)
        ? parsed.categories.filter((c): c is string => typeof c === 'string')
        : [];
    } catch {
      // try the next form
    }
  }
  return null;
}

/** Same as the marketing site's check: analytics allowed in the cookie banner. */
export function analyticsConsented(cookieHeader: string | null | undefined): boolean {
  return consentedCategories(cookieHeader)?.includes('analytics') ?? false;
}

/**
 * Ad consent is the banner's "marketing" category, the one that drives
 * Google consent mode's ad_storage and ad_user_data. 'unknown' until the
 * visitor has answered the banner.
 */
export function marketingConsent(cookieHeader: string | null | undefined): AdConsent {
  const categories = consentedCategories(cookieHeader);
  if (!categories) return 'unknown';
  return categories.includes('marketing') ? 'granted' : 'denied';
}

// ── Keeping it for the length of the sign-up ─────────────────────────────────

const STORE_KEY = 'amcp_signup_attribution';
let memory: SignupAttribution | null = null;

function consented(): boolean {
  try {
    return analyticsConsented(document.cookie);
  } catch {
    return false;
  }
}

function adConsentNow(): AdConsent {
  try {
    return marketingConsent(document.cookie);
  } catch {
    return 'unknown';
  }
}

/**
 * The kept attribution, plus this page load's touch as the last one when that
 * touch carries a click id and nothing kept does: the visitor landed from an
 * ad before answering the cookie banner and allowed marketing cookies since.
 */
export function withLaterClickId(kept: SignupAttribution, fresh: Touch | undefined): SignupAttribution {
  if (!fresh || !hasClickId(fresh) || hasClickId(kept.first_touch) || hasClickId(kept.last_touch)) return kept;
  return kept.first_touch ? { first_touch: kept.first_touch, last_touch: fresh } : { first_touch: fresh };
}

function compact(a: SignupAttribution): SignupAttribution {
  return { ...(a.first_touch && { first_touch: a.first_touch }), ...(a.last_touch && { last_touch: a.last_touch }) };
}

/**
 * Record this page load, once per tab. A hand-over from the site always
 * wins; otherwise the first touch seen in this tab is kept, so moving between
 * sign-in and sign-up does not turn a Google visit into a direct one.
 *
 * Held in memory, which is enough while the visitor stays in the app. Also
 * kept in sessionStorage (this tab only, gone when it closes) if they allowed
 * analytics, so it survives a reload: the same consent rule as the site.
 * Called again right before the register request, so a marketing consent
 * given or withdrawn in the meantime is applied to the click ids.
 */
export function captureSignupAttribution(): void {
  if (typeof window === 'undefined') return;
  try {
    const adConsent = adConsentNow();
    const { attribution, handedOver } = attributionFromLanding(
      window.location.href,
      document.referrer,
      Date.now(),
      adConsent,
    );
    const kept = handedOver ? null : (memory ?? readStored());
    if (kept) {
      const allowed =
        adConsent === 'denied'
          ? compact({ first_touch: withoutClickIds(kept.first_touch), last_touch: withoutClickIds(kept.last_touch) })
          : kept;
      memory = withLaterClickId(allowed, attribution.first_touch);
    } else {
      memory = attribution;
    }
    if (consented()) sessionStore.set(STORE_KEY, JSON.stringify(memory));
  } catch {
    // attribution is never worth breaking the sign-up page for
  }
}

function readStored(): SignupAttribution | null {
  try {
    const raw = sessionStore.get(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SignupAttribution;
    const first = sanitizeTouch(parsed.first_touch);
    const last = sanitizeTouch(parsed.last_touch);
    if (!first && !last) return null;
    return { ...(first && { first_touch: first }), ...(last && { last_touch: last }) };
  } catch {
    return null;
  }
}

/** What to send with the register request, or undefined when nothing is known. */
export function getSignupAttribution(): SignupAttribution | undefined {
  return memory ?? readStored() ?? undefined;
}

/** Forget it once the register request has been answered. */
export function clearSignupAttribution(): void {
  memory = null;
  sessionStore.remove(STORE_KEY);
}
