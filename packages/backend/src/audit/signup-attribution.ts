/**
 * Where a cloud sign-up came from: the first and last "touch" the marketing
 * site (or the cloud app itself, for visitors who came straight to it) saw
 * before the account was created. Stored as the metadata of the
 * `signup_attributed` product event; see docs/operations/signup-attribution.md
 * for the reporting queries.
 *
 * Campaign-level, plus one exception: a Google Ads click id (gclid, gbraid,
 * wbraid), kept only when the touch says the visitor granted ad consent, so
 * a purchase can be reported back to Google Ads as an offline conversion.
 * Without `ad_consent: 'granted'` the id is dropped here, whatever the
 * client sent: never a click id without consent. The client already drops
 * referrer paths and query strings; this is the server's own pass over an
 * untrusted body, with the same key set: anything else is dropped, strings
 * are capped, and a value that looks like an email address is refused.
 */

export const TOUCH_STRING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gad_source',
  'gad_campaignid',
] as const;

export const MAX_TOUCH_FIELD = 100;

/** Google Ads click ids, in the order Google prefers them for an upload. */
export const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'] as const;
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];
export const MAX_CLICK_ID = 150;
/** Google's ids are URL-safe base64-ish tokens; anything else is not one. */
export const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const AD_CONSENT_VALUES = ['granted', 'denied', 'unknown'] as const;
export type AdConsent = (typeof AD_CONSENT_VALUES)[number];

export type Channel =
  | 'google_ads'
  | 'paid_other'
  | 'ai_assistant'
  | 'github'
  | 'organic_google'
  | 'organic_search'
  | 'social'
  | 'email'
  | 'website'
  | 'referral'
  | 'direct';

export type StoredTouch = Partial<Record<(typeof TOUCH_STRING_KEYS)[number], string>> &
  /** Present only next to `ad_consent: 'granted'`. */
  Partial<Record<ClickIdKey, string>> & {
  paid?: true;
  referrer_host?: string;
  landing_path?: string;
  /** ISO 8601; the client sends epoch milliseconds. */
  ts?: string;
  captured_on?: 'site' | 'cloud';
  /** The visitor's ad (marketing cookie) consent when the touch was recorded. */
  ad_consent?: AdConsent;
  /** Derived here, so a report can group by it without repeating the rules. */
  channel: Channel;
};

export type SignupAttributionMetadata = {
  first_touch?: StoredTouch;
  last_touch?: StoredTouch;
  /** Shortcuts for the most common GROUP BY. */
  first_channel?: Channel;
  last_channel?: Channel;
};

const AI_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'claude.ai',
  'perplexity.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'chat.mistral.ai',
  'chat.deepseek.com',
  'grok.com',
  'meta.ai',
  'you.com',
  'phind.com',
  'poe.com',
];
const SOCIAL_HOSTS = [
  'linkedin.com',
  'lnkd.in',
  'x.com',
  'twitter.com',
  't.co',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'news.ycombinator.com',
  'producthunt.com',
  'bsky.app',
  'mastodon.social',
  'threads.net',
];
const SEARCH_HOSTS = [
  'bing.com',
  'duckduckgo.com',
  'search.yahoo.com',
  'yahoo.com',
  'ecosia.org',
  'search.brave.com',
  'startpage.com',
  'yandex.ru',
  'yandex.com',
  'baidu.com',
  'qwant.com',
];
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'cpm', 'display', 'paid_social', 'paidsocial'];

/** host equals `domain` or is a subdomain of it. */
function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const onAny = (host: string, domains: string[]) => domains.some((d) => onDomain(host, d));

/** google.com, google.de, google.co.uk, … */
const isGoogleSearch = (host: string) => /(^|\.)google\.[a-z.]{2,6}$/.test(host);

/** The channel one touch belongs to. Paid first, then the named sources, then referrers. */
export function classifyTouch(t: Omit<StoredTouch, 'channel'>): Channel {
  const source = (t.utm_source ?? '').toLowerCase();
  const medium = (t.utm_medium ?? '').toLowerCase();
  const host = t.referrer_host ?? '';
  const paidMedium = PAID_MEDIUMS.includes(medium);

  if (t.paid || t.gad_source || (paidMedium && (source === 'google' || source === 'adwords'))) {
    return 'google_ads';
  }
  if (paidMedium) return 'paid_other';
  if (onAny(source, AI_HOSTS) || ['chatgpt', 'openai', 'claude', 'perplexity', 'gemini', 'copilot'].includes(source)) {
    return 'ai_assistant';
  }
  if (medium === 'email' || medium === 'newsletter') return 'email';
  if (source === 'github' || onDomain(source, 'github.com')) return 'github';
  if (['linkedin', 'twitter', 'x', 'facebook', 'reddit', 'youtube', 'hackernews', 'producthunt'].includes(source) || medium === 'social') {
    return 'social';
  }
  if (host) {
    if (onAny(host, AI_HOSTS)) return 'ai_assistant';
    if (onDomain(host, 'github.com') || onDomain(host, 'github.io')) return 'github';
    if (isGoogleSearch(host)) return 'organic_google';
    if (onAny(host, SEARCH_HOSTS)) return 'organic_search';
    if (onAny(host, SOCIAL_HOSTS)) return 'social';
    if (onDomain(host, 'anythingmcp.com')) return 'website';
    return 'referral';
  }
  if (source) return 'referral';
  return 'direct';
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_TOUCH_FIELD);
  if (!v || v.includes('@')) return undefined;
  return v;
}

function cleanClickId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v || v.length > MAX_CLICK_ID || !CLICK_ID_PATTERN.test(v)) return undefined;
  return v;
}

function cleanHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/^www\./, '');
  if (!host || host.length > MAX_TOUCH_FIELD || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  return host;
}

function cleanPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.split(/[?#]/)[0];
  return path.startsWith('/') ? cleanString(path) : undefined;
}

// A touch recorded before 2025 or more than a day in the future is a broken
// clock or a forged body; the time is dropped, the touch is kept.
const MIN_TS = Date.UTC(2025, 0, 1);

function cleanTs(value: unknown, now: number): string | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms < MIN_TS || ms > now + 86_400_000) return undefined;
  return new Date(ms).toISOString();
}

export function sanitizeTouch(input: unknown, now = Date.now()): StoredTouch | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: Omit<StoredTouch, 'channel'> = {};
  for (const key of TOUCH_STRING_KEYS) {
    const v = cleanString(raw[key]);
    if (v) out[key] = v;
  }
  if (raw.paid === true) out.paid = true;
  const host = cleanHost(raw.referrer_host);
  if (host) out.referrer_host = host;
  const path = cleanPath(raw.landing_path);
  if (path) out.landing_path = path;
  const ts = cleanTs(raw.ts, now);
  if (ts) out.ts = ts;
  if (raw.captured_on === 'site' || raw.captured_on === 'cloud') out.captured_on = raw.captured_on;
  if (AD_CONSENT_VALUES.includes(raw.ad_consent as AdConsent)) out.ad_consent = raw.ad_consent as AdConsent;
  // The consent rule, enforced here and nowhere weaker: a click id is kept
  // only on a touch that says ad consent was granted.
  if (out.ad_consent === 'granted') {
    for (const key of CLICK_ID_KEYS) {
      const v = cleanClickId(raw[key]);
      if (v) out[key] = v;
    }
    if (CLICK_ID_KEYS.some((key) => out[key])) out.paid = true;
  }
  if (Object.keys(out).length === 0) return undefined;
  return { ...out, channel: classifyTouch(out) };
}

/**
 * The metadata for a `signup_attributed` event, or null when the body names
 * no touch at all. A missing last touch means it was the first touch.
 */
export function sanitizeSignupAttribution(
  input: unknown,
  now = Date.now(),
): SignupAttributionMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const first = sanitizeTouch(raw.first_touch, now);
  const last = sanitizeTouch(raw.last_touch, now) ?? first;
  if (!first && !last) return null;
  const out: SignupAttributionMetadata = {};
  if (first) {
    out.first_touch = first;
    out.first_channel = first.channel;
  }
  if (last) {
    out.last_touch = last;
    out.last_channel = last.channel;
  }
  return out;
}

/** What a signed-in user may read back about their own sign-up: one click id and its consent. */
export type AttributionClickId = Partial<Record<ClickIdKey, string>> & {
  ad_consent: 'granted';
  /** When the touch that carried it was recorded, ISO 8601. */
  captured_at?: string;
};

/**
 * The click id to report a purchase against, from stored `signup_attributed`
 * metadata: the most recent touch that carries one (the last touch, else the
 * first), and only one id, the one Google prefers. Stored rows are sanitized
 * again on the way out, so a row written before the consent rule, or edited
 * by hand, still never yields an id without `ad_consent: 'granted'`.
 */
export function clickIdFromAttribution(metadata: unknown): AttributionClickId | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = metadata as Record<string, unknown>;
  for (const candidate of [raw.last_touch, raw.first_touch]) {
    const touch = sanitizeTouch(candidate);
    if (!touch || touch.ad_consent !== 'granted') continue;
    const key = CLICK_ID_KEYS.find((k) => touch[k]);
    if (!key) continue;
    return { [key]: touch[key], ad_consent: 'granted', ...(touch.ts && { captured_at: touch.ts }) };
  }
  return null;
}
