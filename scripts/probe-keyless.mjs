#!/usr/bin/env node
/**
 * Call one real tool of every keyless adapter and report what the upstream
 * actually answers from THIS network.
 *
 * "26 adapters need no API key" is printed on the banner, the README and every
 * directory listing, and it was verified by counting `authType: NONE` — not by
 * calling anything. Called from the cloud droplet on 2026-09-15, five of them
 * answered with a Cloudflare challenge, an Akamai block, a session-token
 * demand or an HTTP 406: fine from a laptop, dead from any datacenter. This
 * script is the machine check that number was missing, in the spirit of
 * adapter-count.mjs --check.
 *
 * Run it from a datacenter address (CI runner, the cloud droplet) — a
 * residential IP proves nothing. Dependency-free on purpose so it can be
 * copied into the app container and run there.
 *
 *   node scripts/probe-keyless.mjs            # table for every keyless adapter
 *   node scripts/probe-keyless.mjs --check    # exit 1 if a non-selfHostOnly one fails
 *   node scripts/probe-keyless.mjs --all      # include selfHostOnly adapters
 *   node scripts/probe-keyless.mjs --only=deutsche-bahn,trenitalia
 *
 * Which call is made:
 *   - the adapter's `probe` ({ tool, params }) if it declares one — the same
 *     field the import-time credential check uses;
 *   - otherwise the first GET tool with no required parameters;
 *   - otherwise the adapter is reported as `no-probe` (a warning, never a
 *     failure — declare a probe to make it count).
 *
 * `{{VAR}}` placeholders in the base URL are filled from PROBE_<VAR> in the
 * environment (e.g. PROBE_MOTIS_URL for deutsche-bahn); an unfilled one is
 * reported as `skipped`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ADAPTERS_DIR = process.env.ADAPTERS_DIR || join(ROOT, 'packages/backend/src/adapters');
const TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const ALL = args.includes('--all');
const only = (args.find((a) => a.startsWith('--only=')) || '')
  .slice('--only='.length)
  .split(',')
  .filter(Boolean);

// Same list as packages/backend/src/adapters/cloud-managed-env.ts: vars the
// operator supplies, so an adapter that needs one is still "no API key".
const OPERATOR_PROVIDED = new Set(['MOTIS_URL']);

function loadAdapters() {
  const out = [];
  for (const region of readdirSync(ADAPTERS_DIR)) {
    const dir = join(ADAPTERS_DIR, region);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  }
  return out;
}

function isKeyless(a) {
  if (a.connector?.authType !== 'NONE') return false;
  return (a.requiredEnvVars || []).every((v) => OPERATOR_PROVIDED.has(v));
}

/** Mirror of RestEngine.resolveValue for the subset a probe needs. */
function resolveValue(value, params) {
  if (typeof value === 'string') {
    if (value.startsWith('$') && !value.includes('${')) {
      const v = params[value.slice(1)];
      return v !== undefined && v !== '' ? v : undefined;
    }
    if (value.includes('${')) {
      let missing = false;
      const s = value.replace(/\$\{([\w$]+)\}/g, (_, n) => {
        const v = params[n];
        if (v === undefined || v === '') missing = true;
        return v === undefined ? '' : String(v);
      });
      return missing ? undefined : s;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, params)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveValue(v, params);
      if (r !== undefined) o[k] = r;
    }
    return o;
  }
  return value;
}

/** `__TOMORROW__` inside a string → tomorrow as YYYY-MM-DD, so a probe can ask for a real date. */
function materialise(params) {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    out[k] = typeof v === 'string' ? v.replaceAll('__TOMORROW__', tomorrow) : v;
  }
  return out;
}

function pickProbe(a) {
  if (a.probe?.tool) {
    const tool = a.tools.find((t) => t.name === a.probe.tool);
    if (!tool) return { error: `probe names unknown tool ${a.probe.tool}` };
    return { tool, params: materialise(a.probe.params) };
  }
  const tool = a.tools.find(
    (t) =>
      String(t.endpointMapping?.method || '').toUpperCase() === 'GET' &&
      (t.parameters?.required || []).length === 0 &&
      typeof t.endpointMapping?.path === 'string',
  );
  if (!tool) return { error: 'no-probe' };
  const params = {};
  for (const [k, p] of Object.entries(tool.parameters?.properties || {})) {
    if (p && p.default !== undefined) params[k] = p.default;
  }
  return { tool, params };
}

function fillTemplate(str, env) {
  const missing = [];
  const out = str.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const v = env[`PROBE_${name}`];
    if (!v) missing.push(name);
    return v ? v.replace(/\/+$/, '') : '';
  });
  return { out, missing };
}

function classify(status, bodyText, headers) {
  const body = (bodyText || '').slice(0, 4000).toLowerCase();
  const server = String(headers.get('server') || '').toLowerCase();
  if (status >= 200 && status < 300) return 'ok';
  if (
    body.includes('just a moment') ||
    body.includes('cf-chl') ||
    body.includes('challenge-platform') ||
    (status === 403 && server.includes('cloudflare')) ||
    body.includes('akamai') ||
    (body.includes('access denied') && body.includes('reference #'))
  ) {
    return 'bot-blocked';
  }
  if (status === 401 || status === 403) return 'auth-required';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'upstream-error';
  return `http-${status}`;
}

async function probe(a) {
  const picked = pickProbe(a);
  if (picked.error) return { slug: a.slug, verdict: picked.error === 'no-probe' ? 'no-probe' : 'bad-probe', note: picked.error };
  const { tool, params } = picked;
  const em = tool.endpointMapping;

  const base = fillTemplate(a.connector.baseUrl, process.env);
  if (base.missing.length) return { slug: a.slug, verdict: 'skipped', note: `needs PROBE_${base.missing.join(', PROBE_')}` };

  let path = em.path || '';
  path = path.replace(/\{(\w+)\}/g, (_, n) => (params[n] !== undefined ? encodeURIComponent(String(params[n])) : `{${n}}`));
  if (/\{\w+\}/.test(path)) return { slug: a.slug, verdict: 'bad-probe', note: `unfilled path param in ${path}` };

  const url = new URL(base.out.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
  const q = resolveValue(em.queryParams || {}, params);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));

  const headers = { 'User-Agent': 'anythingmcp/1.0 (+https://anythingmcp.com)' };
  for (const [k, v] of Object.entries(a.connector.headers || {})) headers[k] = fillTemplate(String(v), process.env).out;
  for (const [k, v] of Object.entries(em.headers || {})) headers[k] = String(resolveValue(v, params) ?? '');

  const method = String(em.method || 'GET').toUpperCase();
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (em.bodyTemplate) {
      body = em.bodyTemplate.replace(/\$\{(\w+)\}/g, (_, n) => String(params[n] ?? ''));
    } else {
      body = JSON.stringify(resolveValue(em.bodyMapping || {}, params));
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text().catch(() => '');
    const verdict = classify(res.status, text, res.headers);
    return { slug: a.slug, tool: tool.name, status: res.status, ms: Date.now() - started, verdict, url: url.origin + url.pathname };
  } catch (err) {
    const note = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS / 1000}s` : String(err?.cause?.code || err?.message || err);
    return { slug: a.slug, tool: tool.name, status: 0, ms: Date.now() - started, verdict: 'unreachable', note, url: url.origin + url.pathname };
  } finally {
    clearTimeout(timer);
  }
}

const adapters = loadAdapters()
  .filter(isKeyless)
  .filter((a) => ALL || !a.selfHostOnly)
  .filter((a) => only.length === 0 || only.includes(a.slug));

const results = [];
for (const a of adapters) {
  const r = await probe(a);
  r.selfHostOnly = a.selfHostOnly === true;
  results.push(r);
  const status = r.status !== undefined ? String(r.status).padStart(3) : '   ';
  console.log(
    `${r.verdict.padEnd(15)} ${status} ${String(r.ms ?? '').padStart(6)}ms  ${a.slug.padEnd(24)} ${r.tool || ''} ${r.note ? `(${r.note})` : ''}${r.selfHostOnly ? ' [selfHostOnly]' : ''}`,
  );
}

const FAIL = new Set(['bot-blocked', 'auth-required', 'upstream-error', 'unreachable', 'bad-probe']);
const failing = results.filter((r) => FAIL.has(r.verdict) && !r.selfHostOnly);
const noProbe = results.filter((r) => r.verdict === 'no-probe');

console.log('');
console.log(
  `${results.length} keyless adapters probed: ${results.filter((r) => r.verdict === 'ok').length} ok, ` +
    `${failing.length} failing, ${noProbe.length} without a probe, ` +
    `${results.filter((r) => r.verdict === 'skipped').length} skipped.`,
);
if (noProbe.length) console.log(`No probe (add a "probe" field): ${noProbe.map((r) => r.slug).join(', ')}`);

if (CHECK && failing.length) {
  for (const r of failing) {
    console.error(`::error::${r.slug} (${r.tool}) answered ${r.verdict}${r.status ? ` HTTP ${r.status}` : ''} from this network`);
  }
  console.error(
    'A keyless adapter that fails from a datacenter is not "no API key needed" for cloud users. ' +
      'Fix the upstream call, or mark the adapter "selfHostOnly": true so it stays out of the cloud catalog and the advertised count.',
  );
  process.exit(1);
}
