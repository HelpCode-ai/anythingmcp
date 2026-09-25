#!/usr/bin/env node
/**
 * One-off: bring every installed connector of one catalog adapter up to the
 * current catalog, the way the connector page's "Update from catalog" button
 * does — for all of them at once, and dry-run unless told otherwise.
 *
 *   node resync.mjs <slug> [--base-url-from=<url>[,<url>…]] [--apply]
 *
 * Why an ops step at all: tool definitions and the base URL are copied into
 * the connector row at install. The boot-time reconciler only applies the
 * "safe" class of catalog changes (descriptions, parameters, instructions);
 * a changed GraphQL document or REST path is structural and waits for each
 * owner to click, and a base URL never moves without an explicit say-so.
 * Written for:
 *
 *   buffer  every tool's operation was rewritten to Buffer's real schema,
 *           and the host moved to https://api.buffer.com. Installs from
 *           before 2026-09-12 still call graphql.buffer.com (no DNS record);
 *           later ones call api.buffer.com/graphql. Both are catalog values:
 *             --base-url-from=https://graphql.buffer.com,https://api.buffer.com/graphql
 *   immobilienscout24
 *           geo autocomplete path and search range parameters. Its base URL
 *           did not change, so no --base-url-from. This does NOT repair a
 *           wrong consumer key: authConfig is never touched here, and an
 *           e-mail address typed into the key field has to be replaced by
 *           its owner (reinstall with the real key pair).
 *
 * It calls the compiled CatalogResyncService itself, so the rules are the
 * shipped ones, not a copy: operator-written response mappings, role access,
 * manual disables and useProxy are kept, tools the catalog dropped are
 * soft-deprecated, instructions are refreshed only where the owner has not
 * edited them, auth and env vars are never read or written.
 *
 * The base URL moves only when the connector's current value is one of the
 * --base-url-from values, whatever provenance the diff reports: a connector
 * pointed somewhere else on purpose (a proxy, a sandbox) is left alone and
 * listed.
 *
 * Run it inside the backend container AFTER the release carrying the adapter
 * change is deployed — the diff is computed against the catalog compiled into
 * that container:
 *
 *   docker cp scripts/ops/resync-catalog-connectors.mjs amcp-cloud-backend:/app/backend/resync.mjs
 *   docker exec -w /app/backend amcp-cloud-backend node resync.mjs buffer \
 *     --base-url-from=https://graphql.buffer.com,https://api.buffer.com/graphql        # dry run
 *   docker exec -w /app/backend amcp-cloud-backend node resync.mjs buffer \
 *     --base-url-from=https://graphql.buffer.com,https://api.buffer.com/graphql --apply
 *   # These three on the droplet host, not in the container. The restart takes the API
 *   # down for ~30-60 s; silence the uptime probe first. It honours an expiry
 *   # epoch in this file (deploy/cloud/uptime-probe.sh, as deploy-cloud.yml
 *   # does), so a forgotten marker lapses by itself after 10 minutes:
 *   mkdir -p /var/lib/anythingmcp-probe && echo $(( $(date -u +%s) + 600 )) > /var/lib/anythingmcp-probe/maintenance
 *   docker restart amcp-cloud-backend     # the tool registry caches connector tools
 *   rm -f /var/lib/anythingmcp-probe/maintenance
 *
 * Prints connector ids and what changed; no credentials, no customer data.
 */
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { PrismaPg } from '@prisma/adapter-pg';

// Resolved next to this file, i.e. /app/backend inside the container.
const require = createRequire(import.meta.url);
const { PrismaClient } = require('./dist/src/generated/prisma/client.js');
const { CatalogResyncService } = require('./dist/src/connectors/catalog-resync.service.js');
const { getAdapter } = require('./dist/src/adapters/catalog.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slug = args.find((a) => !a.startsWith('--'));
const trim = (u) => u.trim().replace(/\/+$/, '');
const baseUrlFrom = new Set(
  (args.find((a) => a.startsWith('--base-url-from='))?.split('=')[1] ?? '')
    .split(',')
    .map(trim)
    .filter(Boolean),
);

if (!slug || !getAdapter(slug)) {
  console.error(`Usage: node resync.mjs <slug> [--base-url-from=<url>,…] [--apply]` +
    (slug ? `\nNo adapter "${slug}" in this build's catalog.` : ''));
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — run this inside the backend container.');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const resync = new CatalogResyncService(prisma);

const rows = await prisma.connector.findMany({
  where: { config: { path: ['adapterSlug'], equals: slug } },
  select: { id: true },
  orderBy: { createdAt: 'asc' },
});

// Installs old enough to predate config.adapterSlug are invisible to the
// re-sync service (it will not guess a slug). Name them so nobody assumes
// they were handled.
const unmanaged = baseUrlFrom.size
  ? (
      await prisma.connector.findMany({
        where: { baseUrl: { in: [...baseUrlFrom].flatMap((u) => [u, `${u}/`]) } },
        select: { id: true, config: true },
      })
    ).filter((c) => c.config?.adapterSlug !== slug)
  : [];

const counts = { synced: 0, upToDate: 0, baseUrlKept: 0 };
for (const { id } of rows) {
  const diff = await resync.computeDiff(id);
  if (!diff || diff.isUpToDate) {
    counts.upToDate++;
    continue;
  }
  const moveBaseUrl = diff.baseUrl !== null && baseUrlFrom.has(trim(diff.baseUrl.from));
  const onlyAKeptBaseUrl =
    !moveBaseUrl &&
    diff.updated.length === 0 &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    !diff.instructionsRefreshable;
  const parts = [
    diff.updated.length && `${diff.updated.length} updated`,
    diff.added.length && `added ${diff.added.join(', ')}`,
    diff.removed.length && `deprecated ${diff.removed.join(', ')}`,
    diff.instructionsRefreshable && 'instructions',
    diff.baseUrl &&
      (moveBaseUrl
        ? `baseUrl ${diff.baseUrl.from} → ${diff.baseUrl.to}`
        : `baseUrl KEPT at ${diff.baseUrl.from} (${diff.baseUrl.provenance})`),
  ].filter(Boolean);
  if (diff.baseUrl && !moveBaseUrl) counts.baseUrlKept++;
  if (onlyAKeptBaseUrl) {
    // Tools already current; the one difference is a base URL we leave be.
    console.log(`= ${id}: ${parts.join('; ')}`);
    counts.upToDate++;
    continue;
  }

  if (APPLY) {
    await resync.resync(id, 'full', { applyBaseUrl: moveBaseUrl });
  }
  console.log(`${APPLY ? '✓' : '→'} ${id}: ${parts.join('; ')}`);
  counts.synced++;
}

console.log(
  `\n${slug}: ${rows.length} connectors, ${APPLY ? 'synced' : 'would sync'} ${counts.synced}, ` +
    `${counts.upToDate} already current` +
    (counts.baseUrlKept ? `, ${counts.baseUrlKept} with a base URL left as it is` : '') +
    '.',
);
for (const { id } of unmanaged) {
  console.log(`! ${id}: on an old ${slug} base URL but not catalog-managed (no adapterSlug) — not touched`);
}
if (!APPLY && counts.synced > 0) console.log('Re-run with --apply, then restart the backend (see the header).');

await prisma.$disconnect();
