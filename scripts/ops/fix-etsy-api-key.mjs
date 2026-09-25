#!/usr/bin/env node
/**
 * One-off: repair every installed `etsy` connector whose `x-api-key` header
 * carries the keystring without the shared secret.
 *
 * Etsy wants the API key on EVERY request in the form `keystring:shared_secret`
 * (developers.etsy.com → Essentials → Authentication). The adapter shipped the
 * keystring alone, so every installed Etsy connector answered
 *
 *   403 {"error":"Invalid API key: should be in the format 'keystring:shared_secret'."}
 *
 * 70 calls, 70 failures, 54 connectors across the cloud, and a customer had to
 * read our own connector page to find it. Fixing the adapter JSON only helps the
 * next install: `authConfig` is copied into the connector row at import time,
 * with `{{VAR}}` placeholders resolved against whatever credentials were typed,
 * and the result is encrypted — so SQL cannot patch it and the shape differs
 * per row. This decrypts, rewrites the one header in the form that row already
 * uses, and re-encrypts. Nothing else is touched.
 *
 * Three shapes exist in production:
 *   A  header === "{{ETSY_CLIENT_ID}}"        → "{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}"
 *   B  header === authConfig.clientId literal → "<clientId>:<clientSecret>"
 *   C  no extraHeaders at all (older adapter) → built from whichever form the row uses
 * Anything else (a stray email address someone typed into the field) is left
 * for its owner: we cannot invent the missing half.
 *
 * Run it inside the backend container, which holds ENCRYPTION_KEY and DATABASE_URL:
 *
 *   docker cp scripts/ops/fix-etsy-api-key.mjs amcp-cloud-backend:/app/backend/fix-etsy.mjs
 *   docker exec -w /app/backend amcp-cloud-backend node fix-etsy.mjs            # dry run
 *   docker exec -w /app/backend amcp-cloud-backend node fix-etsy.mjs --apply
 *   # These three on the droplet host, not in the container. The restart takes the API
 *   # down for ~30-60 s; silence the uptime probe first. It honours an expiry
 *   # epoch in this file (deploy/cloud/uptime-probe.sh, as deploy-cloud.yml
 *   # does), so a forgotten marker lapses by itself after 10 minutes:
 *   mkdir -p /var/lib/anythingmcp-probe && echo $(( $(date -u +%s) + 600 )) > /var/lib/anythingmcp-probe/maintenance
 *   docker restart amcp-cloud-backend     # the tool registry caches connector config
 *   rm -f /var/lib/anythingmcp-probe/maintenance
 *
 * Secrets never reach stdout: it prints connector ids and which case applied.
 */
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { PrismaClient } from './dist/src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const APPLY = process.argv.includes('--apply');
const ID_VAR = '{{ETSY_CLIENT_ID}}';
const SECRET_VAR = '{{ETSY_CLIENT_SECRET}}';

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
const probe = JSON.stringify({ probe: 'etsy', n: Date.now() });
if (decrypt(encrypt(probe)) !== probe) {
  console.error('Encryption self-test failed — refusing to touch any row.');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const rows = await prisma.connector.findMany({
  where: { baseUrl: { contains: 'openapi.etsy.com' } },
  select: { id: true, name: true, organizationId: true, authConfig: true },
});

/** The value the x-api-key header should hold for this row, or undefined. */
function targetHeader(cfg) {
  const header = cfg?.extraHeaders?.['x-api-key'];
  const clientId = cfg?.clientId;
  const clientSecret = cfg?.clientSecret;

  const joined =
    typeof clientId === 'string' && typeof clientSecret === 'string'
      ? `${clientId}:${clientSecret}`
      : undefined;

  // Already right.
  if (typeof header === 'string' && header.includes(':')) return undefined;

  // A: the row kept the placeholders (installed without credentials).
  if (header === ID_VAR) return `${ID_VAR}:${SECRET_VAR}`;

  // C: older adapter, no extraHeaders at all.
  if (header === undefined && joined) return joined;

  // B: install-time resolution put the bare keystring in the header.
  if (typeof header === 'string' && header === clientId && joined) return joined;

  return undefined;
}

let patched = 0;
let skipped = 0;

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

  const target = targetHeader(cfg);
  if (!target) {
    skipped++;
    continue;
  }

  const kind = target.includes('{{') ? 'placeholders' : 'resolved values';
  cfg.extraHeaders = { ...(cfg.extraHeaders || {}), 'x-api-key': target };

  if (APPLY) {
    await prisma.connector.update({
      where: { id: row.id },
      data: { authConfig: encrypt(JSON.stringify(cfg)) },
    });
  }
  console.log(`${APPLY ? '✓' : '→'} ${row.id} (org ${row.organizationId}) — ${kind}`);
  patched++;
}

console.log(
  `\n${APPLY ? 'Patched' : 'Would patch'} ${patched} of ${rows.length} Etsy connectors ` +
    `(${skipped} left alone).`,
);
if (!APPLY && patched > 0) console.log('Re-run with --apply, then restart the backend (see the header).');

await prisma.$disconnect();
