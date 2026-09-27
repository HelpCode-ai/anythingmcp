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
 * Campaign-level only: ad click ids are reduced to `paid: true`, a referrer
 * is its host, a path loses its query string, and anything that looks like
 * an email address is dropped. The key set matches the backend's
 * SignupTouchDto exactly: the global ValidationPipe answers an unknown key
 * with a 400, so nothing else may be sent.
 */
import { sessionStore } from './storage';

export type Touch = {
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
const CLICK_ID_PARAMS = ['gclid', 'gbraid', 'wbraid'];

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_FIELD);
  if (!v || v.includes('@')) return undefined;
  return v;
}

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
  return Object.keys(out).length > 0 ? out : undefined;
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
 */
export function touchFromUrl(href: string, referrer: string | null | undefined, now: number): Touch {
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
    if (CLICK_ID_PARAMS.some((p) => url!.searchParams.has(p))) touch.paid = true;
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

/** What this page load says: the site's hand-over if present, else its own touch. */
export function attributionFromLanding(
  href: string,
  referrer: string | null | undefined,
  now: number,
): { attribution: SignupAttribution; handedOver: boolean } {
  let params: URLSearchParams | null = null;
  try {
    params = new URL(href).searchParams;
  } catch {
    params = null;
  }
  const first = decodeTouch(params?.get('amcp_src'));
  if (first) {
    const last = decodeTouch(params?.get('amcp_lt'));
    return { attribution: last ? { first_touch: first, last_touch: last } : { first_touch: first }, handedOver: true };
  }
  return { attribution: { first_touch: touchFromUrl(href, referrer, now) }, handedOver: false };
}

/** Same as the marketing site's check: analytics allowed in the cookie banner. */
export function analyticsConsented(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  const entry = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('cc_cookie='));
  if (!entry) return false;
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
      return Array.isArray(parsed.categories) && parsed.categories.includes('analytics');
    } catch {
      // try the next form
    }
  }
  return false;
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

/**
 * Record this page load, once per tab. A hand-over from the site always
 * wins; otherwise the first touch seen in this tab is kept, so moving between
 * sign-in and sign-up does not turn a Google visit into a direct one.
 *
 * Held in memory, which is enough while the visitor stays in the app. Also
 * kept in sessionStorage (this tab only, gone when it closes) if they allowed
 * analytics, so it survives a reload: the same consent rule as the site.
 */
export function captureSignupAttribution(): void {
  if (typeof window === 'undefined') return;
  try {
    const { attribution, handedOver } = attributionFromLanding(
      window.location.href,
      document.referrer,
      Date.now(),
    );
    if (!handedOver && (memory ?? readStored())) {
      memory = memory ?? readStored();
      return;
    }
    memory = attribution;
    if (consented()) sessionStore.set(STORE_KEY, JSON.stringify(attribution));
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
