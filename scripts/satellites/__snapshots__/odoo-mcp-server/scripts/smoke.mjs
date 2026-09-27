#!/usr/bin/env node
/**
 * Smoke test: connect to the MCP endpoint the way Claude or Cursor would,
 * list the tools, check that every tool from adapter/*.json is there, and run
 * one read-only call.
 *
 *   npm install && node scripts/smoke.mjs
 *
 * Reads MCP_URL (default http://localhost:4000/mcp) and MCP_API_KEY from the
 * environment or from .env, where scripts/install.sh writes them; neither is
 * ever printed. To try another tool than the one in satellite.json:
 *
 *   node scripts/smoke.mjs <tool> '<json arguments>'
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...readDotEnv(join(root, '.env')), ...process.env };
const manifest = JSON.parse(readFileSync(join(root, 'satellite.json'), 'utf8'));

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]),
  );
}

const url = env.MCP_URL || 'http://localhost:4000/mcp';
const [cliTool, cliArgs] = process.argv.slice(2);
if (!env.MCP_API_KEY) {
  console.error('MCP_API_KEY is not set. Run scripts/install.sh first, or export the key from the AnythingMCP UI.');
  process.exit(2);
}

// A demo satellite lists what its install creates; otherwise
// every adapter in adapter/ must be there.
// every tool of every adapter whose credentials are in .env (install.sh skips
// the others) must be there.
const configured = (m) => (m.requiredEnvVars ?? []).every((v) => env[v]);
const expected = new Set(
  manifest.expectedTools ??
    manifest.adapters
      .filter(configured)
      .flatMap((a) => JSON.parse(readFileSync(join(root, 'adapter', `${a.slug}.json`), 'utf8')).tools.map((t) => t.name)),
);

const client = new Client({ name: `${manifest.repo}-smoke`, version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'X-API-Key': env.MCP_API_KEY } },
  }),
);

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const missing = [...expected].filter((n) => !names.has(n));
console.log(`tools/list: ${tools.length} tools`);
for (const n of [...expected].sort()) console.log(`  ${names.has(n) ? 'ok     ' : 'MISSING'} ${n}`);

let failed = missing.length > 0;
let callRefused = false;
const call = cliTool ? { tool: cliTool, args: JSON.parse(cliArgs || '{}') } : manifest.smokeCall;
if (call && names.has(call.tool)) {
  const res = await client.callTool({ name: call.tool, arguments: call.args ?? {} });
  const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
  console.log(`\ntools/call ${call.tool} ${JSON.stringify(call.args ?? {})} -> ${res.isError ? 'ERROR' : 'ok'}`);
  console.log(text.length > 800 ? `${text.slice(0, 800)}…` : text);
  if (res.isError) {
    if (call.mayFailWithoutCredentials) {
      console.log('\nThe call reached the vendor and was refused. With real credentials in .env it should succeed;');
      console.log('tools/list above is what this smoke test guarantees without them.');
      callRefused = true;
    } else failed = true;
  }
} else if (call) {
  console.log(`\nskipped tools/call: ${call.tool} is not on this server`);
}

await client.close();
if (failed) {
  console.error(missing.length ? `\n${missing.length} expected tool(s) missing.` : '\nThe read-only call failed.');
  process.exit(1);
}
console.log(callRefused ? '\nSmoke test passed for tools/list; the tool call still needs real credentials.' : '\nSmoke test passed.');
