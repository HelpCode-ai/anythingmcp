#!/usr/bin/env node
/**
 * One-off: move every installed `vinted` connector to the API Vinted's website
 * uses since September 2026, with the anonymous session token it needs.
 *
 * The adapter called www.vinted.fr/api/v2/* with no token: 401
 * invalid_authentication_token on search and filters, 404 on the homepage feed,
 * and then 404 on everything once Vinted retired those routes. Not one
 * successful call in production. Fixing the adapter JSON only helps the next
 * install, and the catalog re-sync cannot carry this change:
 *
 *   - it never touches authType/authConfig, and the fix IS the auth: a
 *     LOGIN_TOKEN bootstrap that reads the `access_token_web` cookie;
 *   - authConfig is encrypted in the row, so SQL alone cannot write it;
 *   - the endpoint change is structural and the base URL moves host, both of
 *     which wait for each owner to click.
 *
 * So this does what `resync(id, 'full', { applyBaseUrl: true })` would, plus
 * the auth, for all of them at once, with the re-sync's rules: a response
 * mapping the operator wrote is kept, manual disables are kept, tools the
 * catalog dropped (vinted_homepage) are soft-deprecated, and instructions are
 * replaced only where nobody edited them. One exception: use_proxy is set to
 * false. It was seeded from the old adapter, not chosen, and the new API
 * answers the cloud directly (verified from the droplet), while the unblocker
 * path is unverified and counts against the workspace's hourly proxy quota.
 *
 * A connector is recognised by `config.adapterSlug`, or — for installs that
 * predate the baseline — by a www.vinted.* base URL.
 *
 * Run it inside the app container, which holds ENCRYPTION_KEY and DATABASE_URL,
 * after the release carrying the new adapter is deployed:
 *
 *   docker cp scripts/ops/migrate-vinted-cloud.mjs amcp-cloud-app:/app/backend/migrate-vinted.mjs
 *   docker cp packages/backend/src/adapters/intl/vinted.json amcp-cloud-app:/app/backend/vinted.json
 *   docker exec -w /app/backend amcp-cloud-app node migrate-vinted.mjs vinted.json            # dry run
 *   docker exec -w /app/backend amcp-cloud-app node migrate-vinted.mjs vinted.json --apply
 *   docker restart amcp-cloud-app     # the tool registry caches connector config
 *
 * Prints connector ids and what changed; never secrets.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from './dist/src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const APPLY = process.argv.includes('--apply');
const adapterPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!adapterPath) {
  console.error('Usage: node migrate-vinted.mjs <path/to/vinted.json> [--apply]');
  process.exit(1);
}
const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
if (adapter.slug !== 'vinted' || adapter.connector.authType !== 'LOGIN_TOKEN') {
  console.error(`${adapterPath} is not the new vinted adapter — refusing.`);
  process.exit(1);
}

const KEY = process.env.ENCRYPTION_KEY;
if (!KEY) {
  console.error('ENCRYPTION_KEY is not set — run this inside the app container.');
  process.exit(1);
}

// Byte-for-byte the scheme in packages/backend/src/common/crypto/encryption.util.ts
// (see scripts/ops/fix-etsy-api-key.mjs).
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const keyBuf = Buffer.from(KEY, 'utf-8').subarray(0, 32);

function encrypt(plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const c = createCipheriv('aes-256-gcm', keyBuf, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

function decrypt(ciphertext) {
  const data = Buffer.from(ciphertext, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyBuf, data.subarray(0, IV_LENGTH));
  d.setAuthTag(data.subarray(data.length - TAG_LENGTH));
  return d.update(data.subarray(IV_LENGTH, data.length - TAG_LENGTH)) + d.final('utf8');
}

const probe = JSON.stringify({ probe: 'vinted', n: Date.now() });
if (decrypt(encrypt(probe)) !== probe) {
  console.error('Encryption self-test failed — refusing to touch any row.');
  process.exit(1);
}

// Same fingerprinting as packages/backend/src/adapters/catalog-fingerprint.ts,
// so the stored adapterVersion matches what the running backend computes and
// the re-sync UI does not report a phantom update afterwards.
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}
const hashContent = (v) => createHash('sha256').update(JSON.stringify(canonicalize(v))).digest('hex').slice(0, 12);
const hashInstructions = (s) => hashContent({ instructions: s ?? '' });
const toolFingerprint = (t) => ({
  name: t.name,
  description: t.description ?? '',
  parameters: t.parameters ?? {},
  endpointMapping: t.endpointMapping ?? {},
  responseMapping: t.responseMapping ?? null,
  useProxy: t.useProxy === true,
});
const adapterVersion = hashContent({
  instructions: adapter.instructions ?? '',
  connector: {
    name: adapter.connector.name,
    type: adapter.connector.type,
    baseUrl: adapter.connector.baseUrl,
    authType: adapter.connector.authType,
  },
  tools: [...adapter.tools].map(toolFingerprint).sort((a, b) => a.name.localeCompare(b.name)),
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const rows = await prisma.connector.findMany({
  where: {
    OR: [
      { config: { path: ['adapterSlug'], equals: 'vinted' } },
      { baseUrl: { startsWith: 'https://www.vinted.' } },
    ],
  },
  include: { tools: true },
});

const catalogByName = new Map(adapter.tools.map((t) => [t.name, t]));
const authConfig = encrypt(JSON.stringify(adapter.connector.authConfig));
const hasMapping = (m) => m !== null && m !== undefined;

for (const c of rows) {
  const cfg = c.config && typeof c.config === 'object' ? c.config : {};
  const baseline = typeof cfg.instructionsBaseline === 'string' ? cfg.instructionsBaseline : null;
  const userEdited = baseline !== null && baseline !== hashInstructions(c.instructions);
  const notes = [`baseUrl ${c.baseUrl} → ${adapter.connector.baseUrl}`, `auth ${c.authType} → LOGIN_TOKEN`];
  if (userEdited) notes.push('instructions kept (edited by the owner)');

  const existing = new Map(c.tools.map((t) => [t.name, t]));
  const updates = [];
  const creates = [];
  for (const ct of adapter.tools) {
    const et = existing.get(ct.name);
    if (et) {
      updates.push(
        prisma.mcpTool.update({
          where: { id: et.id },
          data: {
            description: ct.description,
            parameters: ct.parameters,
            endpointMapping: ct.endpointMapping,
            ...(hasMapping(et.responseMapping) ? {} : { responseMapping: ct.responseMapping }),
            useProxy: false,
            deprecatedAt: null,
            isEnabled: et.deprecatedAt ? true : et.isEnabled,
          },
        }),
      );
    } else {
      creates.push(
        prisma.mcpTool.create({
          data: {
            connectorId: c.id,
            name: ct.name,
            description: ct.description,
            parameters: ct.parameters,
            endpointMapping: ct.endpointMapping,
            responseMapping: ct.responseMapping ?? undefined,
            useProxy: false,
          },
        }),
      );
      notes.push(`+${ct.name}`);
    }
  }
  const deprecates = c.tools
    .filter((t) => !t.deprecatedAt && !catalogByName.has(t.name))
    .map((t) => {
      notes.push(`-${t.name}`);
      return prisma.mcpTool.update({
        where: { id: t.id },
        data: { deprecatedAt: new Date(), isEnabled: false },
      });
    });

  const connectorUpdate = prisma.connector.update({
    where: { id: c.id },
    data: {
      baseUrl: adapter.connector.baseUrl,
      authType: 'LOGIN_TOKEN',
      authConfig,
      ...(userEdited ? {} : { instructions: adapter.instructions }),
      config: {
        ...cfg,
        adapterSlug: 'vinted',
        adapterVersion,
        instructionsBaseline: userEdited ? baseline : hashInstructions(adapter.instructions),
        baseUrlBaseline: adapter.connector.baseUrl,
      },
    },
  });

  if (APPLY) {
    await prisma.$transaction([connectorUpdate, ...updates, ...creates, ...deprecates]);
  }
  console.log(`${APPLY ? '✓' : '→'} ${c.id} — ${notes.join(', ')}`);
}

console.log(`\n${APPLY ? 'Migrated' : 'Would migrate'} ${rows.length} Vinted connectors (adapterVersion ${adapterVersion}).`);
if (!APPLY && rows.length > 0) console.log('Re-run with --apply, then restart the app.');

await prisma.$disconnect();
