#!/usr/bin/env node
/**
 * Check a new catalog adapter against an account that already works: the
 * credentials of a connector a customer built by hand on the cloud.
 *
 *   node scripts/ops/verify-adapter-with-connector.mjs \
 *     --adapter packages/backend/src/adapters/intl/printify.json \
 *     --connector cmurmpxfi0oe101nyt848tk82 \
 *     --map .context/verify/printify.map.json
 *
 * Runs every READ-ONLY tool of the adapter (AdaptersService.exerciseReadTools:
 * a GET, a GraphQL query, or an explicit readOnlyHint) and prints, per tool,
 * ok / error / skipped with the status and the shape of the answer: type, item
 * count, top-level keys. Never a value, never a credential. Tools that write
 * are reported as skipped and never sent.
 *
 * How the credentials travel: the connector's encrypted fields are read on the
 * droplet, decrypted inside amcp-cloud-backend (which holds ENCRYPTION_KEY) and
 * streamed over SSH into this process's memory. They are not written to disk,
 * not printed, and nothing is written to the cloud database. The calls go out
 * from this machine.
 *
 * The map file says where each adapter variable comes from in the customer's
 * connector, because a hand-built connector keeps its secret wherever its
 * owner put it:
 *
 *   {
 *     "vars": {
 *       "PRINTIFY_API_TOKEN": "auth.token",            // decrypted authConfig
 *       "PEOPLEHR_API_KEY":   "env.APIKey",            // decrypted envVars
 *       "FREEPIK_API_KEY":    "header.x-freepik-api-key",
 *       "EXERCISE_HOST":      "baseUrlHost",           // host of the connector's base URL
 *       "SOME_FIXED_VALUE":   "literal:eu"
 *     },
 *     "strip": { "PRINTIFY_API_TOKEN": "Bearer " },    // optional prefix to drop
 *     "params": { "printify_get_shop": { "shop_id": "123" } },
 *     "only": ["printify_list_shops"]                  // optional
 *   }
 *
 * Needs the backend built (npm run build -w packages/backend) and SSH access
 * to the droplet (CLOUD_HOST, default 104.248.242.235).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const DIST = path.join(ROOT, 'packages/backend/dist/src');
const HOST = process.env.CLOUD_HOST || '104.248.242.235';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const adapterPath = arg('adapter');
const connectorId = arg('connector');
const mapPath = arg('map');
if (!adapterPath || !connectorId || !mapPath) {
  console.error('usage: --adapter <adapter.json> --connector <connectorId> --map <map.json>');
  process.exit(2);
}
if (!/^[a-z0-9]{20,40}$/.test(connectorId)) {
  console.error('connector id looks wrong');
  process.exit(2);
}

const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

// ── 1. Read and decrypt the customer's connector on the droplet ─────────────
const decryptSrc = `
const { decrypt } = require('/app/backend/dist/src/common/crypto/encryption.util.js');
const { openEnvVars } = require('/app/backend/dist/src/common/crypto/env-vars-at-rest.js');
const out = { auth: null, env: null, headers: null, baseUrl: process.env.B || null, org: process.env.O || null };
if (process.env.A) out.auth = JSON.parse(decrypt(process.env.A, process.env.ENCRYPTION_KEY));
if (process.env.E) out.env = openEnvVars(JSON.parse(process.env.E));
if (process.env.H) out.headers = JSON.parse(process.env.H);
process.stdout.write(JSON.stringify(out));
`;
const remote = `set -e
Q() { docker exec amcp-cloud-postgres psql -U amcp -d anythingmcp -At -c "$1"; }
W="from connectors where id='${connectorId}'"
A=$(Q "select coalesce(auth_config,'') $W")
E=$(Q "select coalesce(env_vars::text,'') $W")
H=$(Q "select coalesce(headers::text,'') $W")
B=$(Q "select coalesce(base_url,'') $W")
O=$(Q "select organization_id $W")
[ -n "$O" ] || { echo "no such connector" >&2; exit 3; }
docker exec -e A="$A" -e E="$E" -e H="$H" -e B="$B" -e O="$O" -e SRC='${Buffer.from(decryptSrc).toString('base64')}' \\
  amcp-cloud-backend node -e "eval(Buffer.from(process.env.SRC,'base64').toString())"`;

const source = JSON.parse(
  execFileSync('ssh', ['-o', 'ConnectTimeout=10', `root@${HOST}`, remote], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 1 << 20,
  }),
);

// ── 2. Map them onto the adapter's variables ─────────────────────────────────
function pick(spec) {
  if (spec.startsWith('literal:')) return spec.slice('literal:'.length);
  if (spec === 'baseUrlHost') return source.baseUrl ? new URL(source.baseUrl).host : undefined;
  const [where, ...rest] = spec.split('.');
  const key = rest.join('.');
  const bag = { auth: source.auth, env: source.env, header: source.headers }[where];
  if (!bag) return undefined;
  if (where === 'header') {
    const hit = Object.keys(bag).find((k) => k.toLowerCase() === key.toLowerCase());
    return hit ? bag[hit] : undefined;
  }
  return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), bag);
}

const credentials = {};
for (const [name, spec] of Object.entries(map.vars ?? {})) {
  let value = pick(spec);
  if (typeof value !== 'string' || !value) {
    console.error(`${name}: nothing found at "${spec}" (available: auth{${Object.keys(source.auth ?? {})}}, env{${Object.keys(source.env ?? {})}}, header{${Object.keys(source.headers ?? {})}})`);
    process.exit(3);
  }
  const strip = map.strip?.[name];
  if (strip && value.startsWith(strip)) value = value.slice(strip.length);
  credentials[name] = value;
}

// ── 3. Run the adapter's read-only tools from the local build ────────────────
// Engine debug lines name every URL; keep the output to the table below.
require(require.resolve('@nestjs/common', { paths: [path.join(ROOT, 'packages/backend')] })).Logger.overrideLogger(['error']);
const { ConnectorsService } = require(path.join(DIST, 'connectors/connectors.service.js'));
const { AdaptersService } = require(path.join(DIST, 'adapters/adapters.service.js'));
const { RestEngine } = require(path.join(DIST, 'connectors/engines/rest.engine.js'));
const { GraphqlEngine } = require(path.join(DIST, 'connectors/engines/graphql.engine.js'));
const { GraphqlSchemaService } = require(path.join(DIST, 'connectors/engines/graphql-schema.service.js'));
const { McpClientEngine } = require(path.join(DIST, 'connectors/engines/mcp-client.engine.js'));
const { ODataEngine } = require(path.join(DIST, 'connectors/engines/odata.engine.js'));
const { OAuth2TokenService } = require(path.join(DIST, 'connectors/engines/oauth2-token.service.js'));
const { LoginTokenService } = require(path.join(DIST, 'connectors/engines/login-token.service.js'));

// A throwaway key: credentials are encrypted and decrypted again in memory only.
const localKey = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
const config = { get: (k) => (k === 'ENCRYPTION_KEY' ? localKey : process.env[k]) };
// No database: the connector has no id, so token services keep tokens in memory.
const noDb = new Proxy({}, { get: () => { throw new Error('no database in a verification run'); } });
const oauth2 = new OAuth2TokenService(noDb, config);
const login = new LoginTokenService(noDb, config);
const rest = new RestEngine(oauth2, login);
const graphql = new GraphqlEngine(oauth2, login, new GraphqlSchemaService());
const connectors = new ConnectorsService(noDb, config, rest, null, graphql, null, new McpClientEngine(oauth2), new ODataEngine(rest));
const adapters = new AdaptersService(noDb, null, config, connectors);

const results = await adapters.exerciseReadTools(adapter, source.org, credentials, {
  params: map.params,
  only: map.only,
});

const pad = (s, n) => String(s).padEnd(n);
const width = Math.max(...results.map((r) => r.tool.length), 10);
for (const r of results) {
  const detail =
    r.outcome === 'ok'
      ? `${r.durationMs}ms  ${r.shape}`
      : r.outcome === 'error'
        ? `${r.status ?? '-'}  ${r.message}`
        : r.reason;
  console.log(`${pad(r.tool, width)}  ${pad(r.outcome, 7)}  ${detail}`);
}
const counts = results.reduce((c, r) => ({ ...c, [r.outcome]: (c[r.outcome] ?? 0) + 1 }), {});
console.log(`\n${adapter.slug}: ${counts.ok ?? 0} ok, ${counts.error ?? 0} error, ${counts.skipped ?? 0} skipped`);
process.exit(counts.error ? 1 : 0);
