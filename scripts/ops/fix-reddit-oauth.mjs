#!/usr/bin/env node
/**
 * One-off: move every installed `reddit` connector onto the adapter's current
 * auth shape (OAuth2 app-only against oauth.reddit.com).
 *
 * Every Reddit call on the cloud has failed with Reddit's HTML "Blocked" page.
 * That page is what Reddit sends to any request without a valid OAuth token —
 * from a datacenter IP and from a residential one alike. Installed connectors
 * never had one:
 *
 *   legacy   Installed before the July 2026 migration (#423): authType API_KEY,
 *            `Authorization: Bearer <REDDIT_ACCESS_TOKEN>`, a token Reddit
 *            expires after one hour and nothing ever renewed. These rows also
 *            carry the user-context tools (reddit_me, submit_post, vote, ...)
 *            that an app-only token cannot serve.
 *   current  OAuth2 client_credentials. Works once REDDIT_CLIENT_ID/SECRET are
 *            right; only the User-Agent is refreshed to Reddit's format here.
 *
 * Catalog re-sync cannot do this: it never touches authType, authConfig or env
 * vars, and authConfig is encrypted, so SQL cannot either. This decrypts,
 * rewrites, and re-encrypts.
 *
 * A legacy row cannot be made to work without the customer: we never had their
 * client ID and secret. It is rewritten to the OAuth2 shape with
 * `{{REDDIT_CLIENT_ID}}` / `{{REDDIT_CLIENT_SECRET}}` placeholders, which the
 * engine resolves from the connector's env vars on every call. Until the
 * customer sets them, calls stop before reaching Reddit with "missing values
 * for REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET ... Open the connector and set
 * those variables" instead of an HTML page. The expired static token is
 * dropped from authConfig (it is useless and should not linger). Tools the
 * catalog no longer ships are soft-deprecated exactly as a full catalog
 * re-sync would (deprecatedAt set, disabled; nothing is deleted).
 *
 * Run it inside the backend container, which holds ENCRYPTION_KEY and DATABASE_URL:
 *
 *   docker cp scripts/ops/fix-reddit-oauth.mjs amcp-cloud-backend:/app/backend/fix-reddit.mjs
 *   docker exec -w /app/backend amcp-cloud-backend node fix-reddit.mjs            # dry run
 *   docker exec -w /app/backend amcp-cloud-backend node fix-reddit.mjs --apply
 *   # These three on the droplet host, not in the container. The restart takes the API
 *   # down for ~30-60 s; silence the uptime probe first. It honours an expiry
 *   # epoch in this file (deploy/cloud/uptime-probe.sh, as deploy-cloud.yml
 *   # does), so a forgotten marker lapses by itself after 10 minutes:
 *   mkdir -p /var/lib/anythingmcp-probe && echo $(( $(date -u +%s) + 600 )) > /var/lib/anythingmcp-probe/maintenance
 *   docker restart amcp-cloud-backend     # the tool registry caches connector config
 *   rm -f /var/lib/anythingmcp-probe/maintenance
 *
 * Secrets never reach stdout: it prints connector ids, which case applied, and
 * whether the client ID/secret are present, never their values.
 */
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { PrismaClient } from './dist/src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const APPLY = process.argv.includes('--apply');

// Mirrors packages/backend/src/adapters/intl/reddit.json at the time of writing.
const USER_AGENT = 'web:anythingmcp:v1 (by /u/anythingmcp)';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const CATALOG_TOOLS = new Set([
  'reddit_get_subreddit_about',
  'reddit_list_subreddit_posts',
  'reddit_search',
  'reddit_get_post_comments',
  'reddit_get_user_about',
  'reddit_get_user_posts',
]);

const KEY = process.env.ENCRYPTION_KEY;
if (!KEY) {
  console.error('ENCRYPTION_KEY is not set — run this inside the backend container.');
  process.exit(1);
}

// Byte-for-byte the scheme in packages/backend/src/common/crypto/encryption.util.ts:
// base64(iv[16] + ciphertext + tag[16]), key = the raw env value truncated to 32
// bytes (NOT hashed), and no AAD for connector.authConfig.
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const keyBuf = Buffer.from(KEY, 'utf-8').subarray(0, 32);

function decrypt(ciphertext) {
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const body = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  const d = createDecipheriv('aes-256-gcm', keyBuf, iv);
  d.setAuthTag(tag);
  return d.update(body) + d.final('utf8');
}

function encrypt(plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const c = createCipheriv('aes-256-gcm', keyBuf, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

// Round-trip first: a wrong key or a drifted scheme stops here instead of
// writing rows nobody can read again.
const probe = JSON.stringify({ probe: 'reddit', n: Date.now() });
if (decrypt(encrypt(probe)) !== probe) {
  console.error('Encryption self-test failed — refusing to touch any row.');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const rows = await prisma.connector.findMany({
  where: { baseUrl: { contains: 'reddit.com' } },
  select: {
    id: true,
    organizationId: true,
    authType: true,
    authConfig: true,
    envVars: true,
    tools: { select: { id: true, name: true, deprecatedAt: true } },
  },
});

/** Is this credential usable as it stands (a literal, or a placeholder the env vars fill)? */
function credentialState(value, envVars, varName) {
  if (typeof value !== 'string' || value === '') return 'missing';
  if (!value.includes('{{')) return 'set';
  return typeof envVars?.[varName] === 'string' && envVars[varName] !== ''
    ? 'set'
    : 'missing';
}

let patched = 0;
let skipped = 0;
let needCustomer = 0;

for (const row of rows) {
  if (!row.authConfig) {
    console.log(`- ${row.id}: no auth_config, skipped`);
    skipped++;
    continue;
  }
  let cfg;
  try {
    cfg = JSON.parse(decrypt(row.authConfig));
  } catch (e) {
    console.log(`! ${row.id}: cannot decrypt (${e.message}), skipped`);
    skipped++;
    continue;
  }
  const envVars = row.envVars && typeof row.envVars === 'object' ? row.envVars : {};

  let kind;
  let next;
  if (row.authType === 'OAUTH2' && cfg.grant === 'client_credentials') {
    kind = 'current';
    next = {
      ...cfg,
      extraHeaders: { ...(cfg.extraHeaders || {}), 'User-Agent': USER_AGENT },
    };
  } else if (row.authType === 'API_KEY') {
    kind = 'legacy';
    // Nothing from the old shape carries over: its only credential was the
    // expired bearer token.
    next = {
      grant: 'client_credentials',
      tokenUrl: TOKEN_URL,
      clientId: '{{REDDIT_CLIENT_ID}}',
      clientSecret: '{{REDDIT_CLIENT_SECRET}}',
      extraHeaders: { 'User-Agent': USER_AGENT },
    };
  } else {
    console.log(`? ${row.id}: authType ${row.authType} / grant ${cfg.grant ?? '-'} — unknown shape, left alone`);
    skipped++;
    continue;
  }

  const obsolete = row.tools.filter((t) => !t.deprecatedAt && !CATALOG_TOOLS.has(t.name));
  const uaChanged = cfg.extraHeaders?.['User-Agent'] !== USER_AGENT;
  if (kind === 'current' && !uaChanged && obsolete.length === 0) {
    skipped++;
  } else {
    if (APPLY) {
      const now = new Date();
      await prisma.$transaction([
        prisma.connector.update({
          where: { id: row.id },
          data: { authType: 'OAUTH2', authConfig: encrypt(JSON.stringify(next)) },
        }),
        ...obsolete.map((t) =>
          prisma.mcpTool.update({
            where: { id: t.id },
            data: { deprecatedAt: now, isEnabled: false },
          }),
        ),
      ]);
    }
    patched++;
  }

  const id = credentialState(next.clientId, envVars, 'REDDIT_CLIENT_ID');
  const secret = credentialState(next.clientSecret, envVars, 'REDDIT_CLIENT_SECRET');
  const ready = id === 'set' && secret === 'set';
  if (!ready) needCustomer++;
  console.log(
    `${APPLY ? '✓' : '→'} ${row.id} (org ${row.organizationId}) — ${kind}` +
      `${kind === 'legacy' ? ' → OAUTH2 client_credentials' : ''}` +
      `${uaChanged ? ', User-Agent' : ''}` +
      `${obsolete.length ? `, deprecate ${obsolete.map((t) => t.name).join(' ')}` : ''}` +
      ` | client id ${id}, secret ${secret}${ready ? '' : ' → customer must set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET'}`,
  );
}

console.log(
  `\n${APPLY ? 'Patched' : 'Would patch'} ${patched} of ${rows.length} Reddit connectors ` +
    `(${skipped} unchanged or left alone). ${needCustomer} still need the customer's client ID and secret.`,
);
if (!APPLY && patched > 0) console.log('Re-run with --apply, then restart the backend (see the header).');

await prisma.$disconnect();
