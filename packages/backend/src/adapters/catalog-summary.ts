import { createHash } from 'crypto';
import type { AdapterMeta } from './catalog';
import type { EnvVarKind } from './env-var-meta';

/**
 * Setup instructions shorter than this do not make a page worth indexing on
 * the website (its `isEnrichedAdapter`). Sent as a flag in the slim list so
 * the site can decide without downloading the instructions.
 */
export const ENRICHED_INSTRUCTIONS_MIN_CHARS = 200;

/**
 * One row of `GET /api/adapters?fields=slim`: what the marketing website's
 * catalog, marketplace cards, guides and sitemap read, and nothing else.
 *
 * The full list carries every adapter's setup instructions, variable help
 * texts, prerequisites and probe. For 467 adapters that came to 2.6 MB, above
 * the 2 MB limit of Next's data cache, so the site fetched the whole catalog
 * again on every render. The instructions of one adapter are at
 * `GET /api/adapters/:slug/instructions`.
 */
export interface AdapterSummary {
  slug: string;
  name: string;
  description: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  toolCount: number;
  version: string;
  authType?: string;
  featured?: boolean;
  priority?: number;
  selfHostOnly?: boolean;
  setupKind?: AdapterMeta['setupKind'];
  setupEffort?: AdapterMeta['setupEffort'];
  /** Only `kind` and `secret` of each variable: enough to tell a credential
   *  from an address or a setting. Labels, help, links and patterns stay in
   *  the full list. */
  envVarMeta?: Record<string, { kind?: EnvVarKind; secret?: boolean }>;
  /** The adapter has setup instructions of at least
   *  ENRICHED_INSTRUCTIONS_MIN_CHARS characters. */
  enriched: boolean;
}

export function toAdapterSummary(a: AdapterMeta): AdapterSummary {
  const summary: AdapterSummary = {
    slug: a.slug,
    name: a.name,
    description: a.description,
    region: a.region,
    category: a.category,
    icon: a.icon,
    docsUrl: a.docsUrl,
    requiredEnvVars: a.requiredEnvVars,
    toolCount: a.toolCount,
    version: a.version,
    enriched:
      (a.instructions?.trim().length ?? 0) >= ENRICHED_INSTRUCTIONS_MIN_CHARS,
  };
  if (a.authType) summary.authType = a.authType;
  if (a.featured) summary.featured = true;
  if (a.priority) summary.priority = a.priority;
  if (a.selfHostOnly) summary.selfHostOnly = true;
  if (a.setupKind) summary.setupKind = a.setupKind;
  if (a.setupEffort) summary.setupEffort = a.setupEffort;
  if (a.envVarMeta) {
    const meta: NonNullable<AdapterSummary['envVarMeta']> = {};
    for (const [name, m] of Object.entries(a.envVarMeta)) {
      const slim: { kind?: EnvVarKind; secret?: boolean } = {};
      if (m?.kind) slim.kind = m.kind;
      if (m?.secret !== undefined) slim.secret = m.secret;
      if (Object.keys(slim).length > 0) meta[name] = slim;
    }
    if (Object.keys(meta).length > 0) summary.envVarMeta = meta;
  }
  return summary;
}

/** A response body serialised once, with its strong ETag. */
export interface SerializedBody {
  body: string;
  etag: string;
}

export function serializeWithEtag(value: unknown): SerializedBody {
  const body = JSON.stringify(value);
  const hash = createHash('sha1').update(body).digest('base64url');
  return { body, etag: `"${hash}"` };
}
