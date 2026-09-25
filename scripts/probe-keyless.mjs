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
 * copied into the backend container and run there.
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
 *
 * "Keyless" means the user supplies nothing, not `authType: NONE`. An adapter
 * whose auth is fully described by its own JSON — no `{{VAR}}` in authConfig,
 * no requiredEnvVars beyond operator-provided ones — is probed too, with its
 * auth reproduced here. Vinted is the case that made this necessary: it moved
 * to LOGIN_TOKEN with an anonymous session (HEAD the catalog page, read the
 * `access_token_web` cookie, send it as a Bearer token), and the NONE-only
 * filter silently dropped it from the weekly run. Supported:
 *   - NONE
 *   - LOGIN_TOKEN, mirroring login-token.service.ts: tokenSource `cookie`
 *     (last non-empty Set-Cookie value, as a browser keeps it) or `body`
 *     (tokenJsonPath), then headerName/headerTemplate/extraHeaders as in
 *     injectLoginTokenHeaders(). Password hashing (bcrypt) is not.
 * Anything else with static credentials is listed as `unsupported-auth`, a
 * warning like `no-probe`, so it shows up instead of vanishing.
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

/**
 * No user-supplied credentials: every required env var is operator-provided,
 * and — for any auth type other than NONE — the authConfig carries no `{{VAR}}`
 * placeholder, i.e. the adapter JSON alone is enough to authenticate.
 */
function isKeyless(a) {
  if (!(a.requiredEnvVars || []).every((v) => OPERATOR_PROVIDED.has(v))) return false;
  const authType = a.connector?.authType;
  if (!authType || authType === 'NONE') return true;
  return !/\{\{\w+\}\}/.test(JSON.stringify(a.connector.authConfig ?? {}));
}

const PROBED_AUTH = new Set(['NONE', 'LOGIN_TOKEN']);
const USER_AGENT = 'anythingmcp/1.0 (+https://anythingmcp.com)';

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

/** Mirror of jsonPath() in login-token.service.ts. */
function jsonPath(value, path) {
  let cur = value;
  for (const p of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === undefined || cur === null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : typeof cur === 'object' ? cur[p] : undefined;
  }
  return cur;
}

/** Mirror of interpolateDeep() in login-token.service.ts. */
function interpolateDeep(value, params) {
  if (typeof value === 'string') {
    const full = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (full) return params[full[1]] ?? '';
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => params[n] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, params));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = interpolateDeep(v, params);
    return o;
  }
  return value;
}

/**
 * Last non-empty value of a cookie across every Set-Cookie header — mirror of
 * extractSetCookieValue(). Vinted clears `access_token_web` on one domain and
 * sets the real one on another in the same response; the first match is empty.
 */
function lastSetCookie(headers, name) {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  let found = null;
  for (const entry of all) {
    const t = entry.trimStart();
    if (!t.startsWith(`${name}=`)) continue;
    const end = t.indexOf(';');
    const v = t.slice(name.length + 1, end === -1 ? undefined : end);
    if (v) found = v;
  }
  return found;
}

async function timedFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Obtain a LOGIN_TOKEN the way login-token.service.ts performLogin() does and
 * return the headers injectLoginTokenHeaders() would add. Throws an Error with
 * a `verdict` on failure; never prints the token.
 */
async function loginTokenHeaders(cfg) {
  const fail = (verdict, note, status) => Object.assign(new Error(note), { verdict, status });
  if (cfg.passwordHashing && cfg.passwordHashing.scheme !== 'none') {
    throw fail('unsupported-auth', `LOGIN_TOKEN passwordHashing ${cfg.passwordHashing.scheme}`);
  }
  if (!cfg.loginUrl) throw fail('bad-probe', 'LOGIN_TOKEN without loginUrl');
  const params = { username: cfg.username ?? '', password: cfg.password ?? '', passwordHashed: cfg.password ?? '', aud: cfg.aud ?? '', otp: cfg.otp ?? '' };
  let data;
  if (cfg.loginBody !== undefined) data = interpolateDeep(cfg.loginBody, params);
  else if (cfg.loginBodyTemplate) data = JSON.parse(cfg.loginBodyTemplate.replace(/\$\{(\w+)\}/g, (_, n) => params[n] ?? ''));
  else data = params;

  const method = String(cfg.loginMethod || 'POST').toUpperCase();
  const url = new URL(cfg.loginUrl);
  let body;
  // axios sends `data` as the query string for GET and drops it for HEAD.
  if (method === 'GET' && data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) url.searchParams.set(k, String(v));
  } else if (method !== 'GET' && method !== 'HEAD' && data !== null && data !== undefined) {
    body = JSON.stringify(data);
  }
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', ...(cfg.loginHeaders || {}) };

  let res;
  try {
    res = await timedFetch(url, { method, headers, body });
  } catch (err) {
    throw fail('login-failed', `login ${method} ${url.origin}${url.pathname}: ${err?.name === 'AbortError' ? 'timeout' : err?.cause?.code || err?.message}`);
  }
  const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
  if (res.status >= 400) {
    const v = classify(res.status, text, res.headers);
    throw fail(v === 'bot-blocked' ? 'bot-blocked' : 'login-failed', `login ${method} ${url.origin}${url.pathname} answered HTTP ${res.status}`, res.status);
  }

  let token;
  if (cfg.tokenSource === 'cookie') {
    token = lastSetCookie(res.headers, cfg.cookieName);
    if (!token) throw fail('login-failed', `login set no non-empty "${cfg.cookieName}" cookie`, res.status);
  } else {
    let json;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    token = jsonPath(json, cfg.tokenJsonPath || '');
    if (!token || typeof token !== 'string') throw fail('login-failed', `no token at "${cfg.tokenJsonPath}" in login response`, res.status);
  }
  const aud = cfg.audJsonPath ? undefined : cfg.aud;
  const fill = (s) => s.replace(/\$\{token\}/g, token).replace(/\$\{aud\}/g, aud || '');
  const out = { [cfg.headerName || 'Authorization']: fill(cfg.headerTemplate || 'Bearer ${token}') };
  for (const [k, v] of Object.entries(cfg.extraHeaders || {})) out[k] = fill(String(v));
  return out;
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
  const authType = a.connector.authType || 'NONE';
  if (!PROBED_AUTH.has(authType)) return { slug: a.slug, verdict: 'unsupported-auth', note: `authType ${authType} is not reproduced by this probe` };
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

  const headers = { 'User-Agent': USER_AGENT };
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

  const started = Date.now();
  let authNote;
  if (authType === 'LOGIN_TOKEN') {
    try {
      Object.assign(headers, await loginTokenHeaders(a.connector.authConfig || {}));
      authNote = 'anonymous LOGIN_TOKEN';
    } catch (err) {
      return { slug: a.slug, tool: tool.name, status: err.status ?? 0, ms: Date.now() - started, verdict: err.verdict || 'login-failed', note: err.message };
    }
  }

  try {
    const res = await timedFetch(url, { method, headers, body });
    const text = await res.text().catch(() => '');
    const verdict = classify(res.status, text, res.headers);
    return { slug: a.slug, tool: tool.name, status: res.status, ms: Date.now() - started, verdict, note: authNote, url: url.origin + url.pathname };
  } catch (err) {
    const note = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS / 1000}s` : String(err?.cause?.code || err?.message || err);
    return { slug: a.slug, tool: tool.name, status: 0, ms: Date.now() - started, verdict: 'unreachable', note, url: url.origin + url.pathname };
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

const FAIL = new Set(['bot-blocked', 'auth-required', 'login-failed', 'upstream-error', 'unreachable', 'bad-probe']);
const failing = results.filter((r) => FAIL.has(r.verdict) && !r.selfHostOnly);
const noProbe = results.filter((r) => r.verdict === 'no-probe');
const unsupported = results.filter((r) => r.verdict === 'unsupported-auth');

console.log('');
console.log(
  `${results.length} keyless adapters probed: ${results.filter((r) => r.verdict === 'ok').length} ok, ` +
    `${failing.length} failing, ${noProbe.length} without a probe, ${unsupported.length} with unsupported auth, ` +
    `${results.filter((r) => r.verdict === 'skipped').length} skipped.`,
);
if (noProbe.length) console.log(`No probe (add a "probe" field): ${noProbe.map((r) => r.slug).join(', ')}`);
if (unsupported.length) console.log(`Static credentials this probe cannot reproduce yet: ${unsupported.map((r) => r.slug).join(', ')}`);

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
