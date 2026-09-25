#!/usr/bin/env node
/**
 * One-off: move installed `amadeus` connectors from a pasted Bearer token to
 * the OAuth2 client-credentials grant the adapter now declares.
 *
 * Amadeus access tokens expire after ~30 minutes, so the old adapter's
 * `BEARER_TOKEN` + `{{AMADEUS_ACCESS_TOKEN}}` could never work for longer than
 * that. The adapter now asks for the API key and secret and lets the engine
 * mint tokens. The catalog re-sync never touches authType/authConfig, and
 * authConfig is encrypted, so existing rows need this script: without it they
 * would show the new instructions (set AMADEUS_CLIENT_ID / SECRET) while still
 * demanding AMADEUS_ACCESS_TOKEN.
 *
 * Per BEARER_TOKEN row it writes:
 *   authType   OAUTH2
 *   authConfig { grant: client_credentials, tokenAuthMethod: client_secret_post,
 *                tokenUrl: <host>/v1/security/oauth2/token,
 *                clientId: {{AMADEUS_CLIENT_ID}}, clientSecret: {{AMADEUS_CLIENT_SECRET}} }
 * Placeholders are resolved from the row's own env vars where it already has
 * them — the token service re-reads authConfig from the database before each
 * token request, so a placeholder at rest would be sent as the literal client
 * id. Where it has none they stay placeholders: the call then fails with the
 * "missing a value for AMADEUS_CLIENT_ID" message, and setting the variables in
 * the UI re-resolves authConfig from the adapter template. The old token is
 * dropped: whatever it was, it expired half an hour after it was pasted.
 *
 * Host: `test.api.amadeus.com` stopped resolving when Amadeus retired the
 * Self-Service portal (2026-07-17), so rows on it move to `api.amadeus.com`
 * (baseUrl and baseUrlBaseline). Any other host is kept, and the token URL
 * follows it. Rows already on OAUTH2, or on any other auth type, are left alone.
 *
 * Run it inside the backend container, which holds ENCRYPTION_KEY and DATABASE_URL:
 *
 *   docker cp scripts/ops/migrate-amadeus-client-credentials.mjs amcp-cloud-backend:/app/backend/migrate-amadeus.mjs
 *   docker exec -w /app/backend amcp-cloud-backend node migrate-amadeus.mjs            # dry run
 *   docker exec -w /app/backend amcp-cloud-backend node migrate-amadeus.mjs --apply
 *   docker restart amcp-cloud-backend     # the tool registry caches connector config
 *
 * Secrets never reach stdout: it prints connector ids and what changed.
 */
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { PrismaClient } from './dist/src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const APPLY = process.argv.includes('--apply');
const RETIRED_HOST = 'test.api.amadeus.com';
const LIVE_ORIGIN = 'https://api.amadeus.com';

const KEY = process.env.ENCRYPTION_KEY;
if (!KEY) {
  console.error('ENCRYPTION_KEY is not set — run this inside the app container.');
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
const probe = JSON.stringify({ probe: 'amadeus', n: Date.now() });
if (decrypt(encrypt(probe)) !== probe) {
  console.error('Encryption self-test failed — refusing to touch any row.');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const rows = await prisma.connector.findMany({
  where: { config: { path: ['adapterSlug'], equals: 'amadeus' } },
  select: {
    id: true,
    organizationId: true,
    authType: true,
    baseUrl: true,
    config: true,
    envVars: true,
  },
});

let patched = 0;
let skipped = 0;

for (const row of rows) {
  if (row.authType !== 'BEARER_TOKEN') {
    console.log(`- ${row.id}: authType ${row.authType}, left alone`);
    skipped++;
    continue;
  }

  let baseUrl;
  let origin;
  try {
    const url = new URL(row.baseUrl);
    const retired = url.hostname === RETIRED_HOST;
    baseUrl = retired ? LIVE_ORIGIN + row.baseUrl.slice(url.origin.length) : row.baseUrl;
    origin = retired ? LIVE_ORIGIN : url.origin;
  } catch {
    console.log(`! ${row.id}: baseUrl is not a URL, left alone`);
    skipped++;
    continue;
  }

  const vars = row.envVars ?? {};
  const valueOr = (name) =>
    typeof vars[name] === 'string' && vars[name].trim() ? vars[name].trim() : `{{${name}}}`;
  const authConfig = {
    grant: 'client_credentials',
    tokenAuthMethod: 'client_secret_post',
    tokenUrl: `${origin}/v1/security/oauth2/token`,
    clientId: valueOr('AMADEUS_CLIENT_ID'),
    clientSecret: valueOr('AMADEUS_CLIENT_SECRET'),
  };
  const credentials = authConfig.clientId.includes('{{') || authConfig.clientSecret.includes('{{')
    ? 'awaiting AMADEUS_CLIENT_ID/SECRET'
    : 'credentials from env vars';
  const movedHost = baseUrl !== row.baseUrl;

  if (APPLY) {
    await prisma.connector.update({
      where: { id: row.id },
      data: {
        authType: 'OAUTH2',
        authConfig: encrypt(JSON.stringify(authConfig)),
        ...(movedHost
          ? {
              baseUrl,
              config: { ...(row.config ?? {}), baseUrlBaseline: baseUrl },
            }
          : {}),
      },
    });
  }
  console.log(
    `${APPLY ? '✓' : '→'} ${row.id} (org ${row.organizationId}) — OAUTH2 client_credentials, ${credentials}` +
      (movedHost ? `, baseUrl ${row.baseUrl} → ${baseUrl}` : ''),
  );
  patched++;
}

console.log(
  `\n${APPLY ? 'Migrated' : 'Would migrate'} ${patched} of ${rows.length} Amadeus connectors ` +
    `(${skipped} left alone).`,
);
if (!APPLY && patched > 0) console.log('Re-run with --apply, then restart the app.');

await prisma.$disconnect();
