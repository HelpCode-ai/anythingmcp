/**
 * Which catalog adapters talk to the API at a given URL.
 *
 * People keep building by hand connectors the catalog already has: in four
 * days of October 2026, custom connectors were made for Fatture in Cloud,
 * Printify, Printful, Pinterest, ERPNext, The Odds API, Yandex Disk and Odoo,
 * most with fewer tools than the catalog's. The new-connector form sends the
 * base URL the user types here and offers the ready-made connector instead.
 *
 * Matching is by host. An adapter whose host contains a variable
 * (`https://{{SHOP}}.myshopify.com`) matches any value of it, as long as a
 * fixed domain is left (`{{ODOO_URL}}` alone matches nothing). When several
 * adapters share a host (graph.facebook.com, www.googleapis.com), the ones
 * whose base path the URL starts with come first, and only they are kept.
 */

export interface UrlMatchCandidate {
  slug: string;
  name: string;
  icon: string;
  description: string;
  toolCount: number;
  baseUrl: string;
}

export interface UrlMatch {
  slug: string;
  name: string;
  icon: string;
  description: string;
  toolCount: number;
}

/** At most this many suggestions; a shared host lists the best few. */
export const URL_MATCH_MAX = 5;

const VAR = '__amcp_var__';

interface HostPattern {
  exact: string | null;
  regex: RegExp | null;
  path: string;
}

/** The host part of a URL the user typed, with or without a scheme. */
function parseUserUrl(input: string): { host: string; path: string } | null {
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!host.includes('.')) return null;
    return { host, path: normalizePath(url.pathname) };
  } catch {
    return null;
  }
}

function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\/+$/, '');
}

const patternCache = new Map<string, HostPattern | null>();

/** How an adapter's base URL matches a host, or null if it cannot. */
export function hostPattern(baseUrl: string): HostPattern | null {
  if (patternCache.has(baseUrl)) return patternCache.get(baseUrl)!;
  let pattern: HostPattern | null = null;
  try {
    const url = new URL(baseUrl.replace(/\{\{[^}]+\}\}/g, VAR));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    // The fixed part must still name a domain: `x.myshopify.com` keeps
    // `myshopify.com`, a host that is only a variable keeps nothing.
    const fixed = host.split('.').filter((label) => !label.includes(VAR));
    const path = url.pathname.includes(VAR)
      ? normalizePath(url.pathname.slice(0, url.pathname.indexOf(VAR)))
      : normalizePath(url.pathname);
    if (fixed.length >= 2 && !host.startsWith('localhost')) {
      pattern = host.includes(VAR)
        ? {
            exact: null,
            regex: new RegExp(
              '^' +
                host
                  .split(VAR)
                  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  .join('[a-z0-9-]+(?:\\.[a-z0-9-]+)*') +
                '$',
            ),
            path,
          }
        : { exact: host, regex: null, path };
    }
  } catch {
    pattern = null;
  }
  patternCache.set(baseUrl, pattern);
  return pattern;
}

/** The adapters among `candidates` that serve the API at `url`, best first. */
export function matchCatalogUrl(url: string, candidates: UrlMatchCandidate[]): UrlMatch[] {
  const target = parseUserUrl(url);
  if (!target) return [];
  const scored: Array<{ c: UrlMatchCandidate; score: number; pathHit: boolean }> = [];
  for (const c of candidates) {
    const p = hostPattern(c.baseUrl);
    if (!p) continue;
    const hostHit = p.exact ? p.exact === target.host : p.regex!.test(target.host);
    if (!hostHit) continue;
    const pathHit =
      p.path !== '' && (target.path === p.path || target.path.startsWith(`${p.path}/`));
    // A longer base path that fits is the more specific adapter.
    scored.push({ c, score: (p.exact ? 2 : 1) + (pathHit ? 4 + p.path.length / 1000 : 0), pathHit });
  }
  const anyPathHit = scored.some((s) => s.pathHit);
  return scored
    .filter((s) => !anyPathHit || s.pathHit)
    .sort((a, b) => b.score - a.score || b.c.toolCount - a.c.toolCount || a.c.name.localeCompare(b.c.name))
    .slice(0, URL_MATCH_MAX)
    .map(({ c }) => ({
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      description: c.description,
      toolCount: c.toolCount,
    }));
}
