/**
 * Satellite repositories: the small, single-purpose GitHub repositories
 * (weclapp-mcp-server, soap-to-mcp, erp-mcp-server, …) that each package one
 * slice of AnythingMCP for the people searching for exactly that slice.
 *
 * Everything a satellite contains is derived from two sources so that it
 * cannot drift from the product: the adapter JSON in this repository and
 * satellites.config.json (About, topics, owner, hand-written prompts and FAQ
 * under content/<repo>/). generate.mjs writes the files; this module holds the
 * logic so the tests can exercise it without touching the filesystem.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToolsTable, access } from './templates/render-tools.mjs';
import { renderReadme } from './readme.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const MCP_SDK_VERSION = '^1.30.1';

// ── Loading ────────────────────────────────────────────────────────────────

export function loadCatalog(root = ROOT) {
  const dir = join(root, 'packages/backend/src/adapters');
  const catalog = new Map();
  for (const region of readdirSync(dir)) {
    const rdir = join(dir, region);
    if (!statSync(rdir).isDirectory()) continue;
    for (const f of readdirSync(rdir)) {
      if (!f.endsWith('.json')) continue;
      const adapter = JSON.parse(readFileSync(join(rdir, f), 'utf8'));
      catalog.set(adapter.slug, { adapter, region });
    }
  }
  return catalog;
}

export function loadConfig(path = join(HERE, 'satellites.config.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadTopicCounts(path = join(HERE, 'topic-counts.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Hand-written content for one satellite: content/<repo>/<name>[.<lang>].md */
export function loadContent(repo, dir = join(HERE, 'content')) {
  const base = join(dir, repo);
  const out = {};
  if (!existsSync(base)) return out;
  for (const f of readdirSync(base)) {
    const m = f.match(/^([a-z-]+?)(?:\.([a-z]{2}))?\.md$/);
    if (!m) continue;
    const [, name, lang = 'en'] = m;
    (out[lang] ??= {})[name] = readFileSync(join(base, f), 'utf8').trim();
  }
  return out;
}

// ── Links ──────────────────────────────────────────────────────────────────

export function repoUrl(config, repo) {
  if (repo === 'anythingmcp') return `https://github.com/${config.mainRepo}`;
  const sat = config.satellites.find((s) => s.repo === repo);
  if (!sat) throw new Error(`unknown satellite ${repo}`);
  return `https://github.com/${sat.owner}/${sat.repo}`;
}

export const cloudInstallUrl = (slug) => `https://cloud.anythingmcp.com/connectors/store?install=${slug}`;
export const localInstallUrl = (slug) => `http://localhost:3000/connectors/store?install=${slug}`;

// ── Checks (SEO-GITHUB-PLAN §3.12.6) ────────────────────────────────────────

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const BANNED = [/#1\b/, /\bbest\b/i, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u];

/**
 * Business objects an About may promise, and the tool-name fragments that
 * deliver them. An About that says "orders" must ship a tool whose name
 * mentions an order (or a receipt, which is what Etsy calls one).
 */
export const OBJECTS = [
  [/\borders?\b/i, /order|receipt/],
  [/\binvoices?\b/i, /invoice|billing/],
  [/\bstock\b|\binventory\b/i, /stock|inventor|quantit|warehouse/],
  [/\bcustomers?\b/i, /customer|part(y|ies|ner)|contact|thirdpart/],
  // "Selling Partner API" or "partner API" is an API name, not a promise of partner records.
  [/\bpartners?\b(?!\s+APIs?\b)/i, /partner|part(y|ies)/],
  [/\bitems?\b/i, /item|artic|product/],
  [/\barticles?\b/i, /article|item/],
  [/\bproducts?\b/i, /product|item|article/],
  [/\bquot(es?|ations?)\b/i, /quot/],
  [/\bproposals?\b/i, /proposal/],
  [/\bopportunit(y|ies)\b/i, /opportunit/],
  [/\bshipments?\b/i, /shipment|deliver/],
  [/\bdeliver(y|ies)\b/i, /deliver/],
  [/\breturns\b/i, /return/],
  [/\bprices?\b/i, /price/],
  [/\blistings?\b/i, /listing/],
  [/\breviews\b/i, /review/],
  [/\bcategor(y|ies)\b/i, /categor/],
  [/\bvariants?\b|\bvariations?\b/i, /variant|variation/],
  [/\brefunds?\b/i, /refund/],
  [/\breports?\b/i, /report/],
  [/\bfees?\b/i, /fee/],
  [/\bdisputes?\b/i, /dispute/],
  [/\bemployees?\b/i, /employee/],
  [/\bdebtors?\b/i, /debtor/],
  [/\bsuppliers?\b/i, /supplier|vendor/],
  [/\breceivables?\b/i, /receivable/],
  [/\bgl accounts?\b/i, /gl_account/],
  [/\bunits\b/i, /unit/],
  [/\btickets\b/i, /ticket/],
  [/\bstorefronts?\b/i, /storefront/],
  [/\bcross-sells?\b/i, /cross_sell/],
  [/\bshipping providers?\b/i, /shipping_provider/],
  [/\bthird parties\b/i, /thirdpart/],
  [/\bdocuments\b/i, /document|documenti/],
  [/\banagrafiche\b/i, /anagrafiche/],
  [/\baddresses\b/i, /address/],
];

/** Words of an About that name an object no tool of the adapter(s) covers. */
export function uncoveredObjects(about, adapters) {
  const names = adapters.flatMap((a) => a.tools.map((t) => t.name.toLowerCase()));
  return OBJECTS.filter(([word, tool]) => word.test(about) && !names.some((n) => tool.test(n))).map(
    ([word]) => about.match(word)[0],
  );
}

/**
 * Static checks for one satellite. `errors` must be fixed before anything is
 * applied on GitHub; `blockers` only stop publishing (an unverified connector
 * can be generated and reviewed, not released); `warnings` are advisory.
 */
export function checkSatellite(sat, { config, catalog, topicCounts, content = {} }) {
  const errors = [];
  const warnings = [];
  const blockers = [];
  const about = sat.about ?? '';

  // About
  if (about.length < 90 || about.length > 140) errors.push(`About is ${about.length} characters (90–140)`);
  for (const re of BANNED) if (re.test(about)) errors.push(`About contains banned wording ${re}`);
  if (!/\bClaude\b/.test(about)) errors.push('About does not mention Claude');
  if (!/\bChatGPT\b/.test(about)) errors.push('About does not mention ChatGPT');
  if (sat.type === 'generic') {
    if (!/\bMCP\b/.test(about)) errors.push('About does not mention MCP');
  } else {
    if (!about.toLowerCase().startsWith(sat.system.toLowerCase())) {
      errors.push(`About does not start with the system name "${sat.system}"`);
    }
    const firstFive = about.split(/\s+/).slice(0, 5).join(' ');
    if (!/\bMCP server\b/i.test(firstFive)) errors.push('"MCP server" is not within the first five words of the About');
  }

  // Adapters
  const adapters = [];
  for (const slug of sat.adapters ?? []) {
    const entry = catalog.get(slug);
    if (!entry) errors.push(`adapter ${slug} is not in the catalog`);
    else adapters.push(entry.adapter);
  }
  if (sat.type === 'connector' && adapters.length === 1) {
    const missing = uncoveredObjects(about, adapters);
    if (missing.length) errors.push(`About promises ${missing.join(', ')} but no tool covers it`);
  }
  if (sat.type === 'umbrella' && sat.category) {
    const inCategory = [...catalog.values()].filter((e) => e.adapter.category === sat.category).map((e) => e.adapter.slug);
    const left = inCategory.filter((s) => !sat.adapters.includes(s));
    if (left.length) warnings.push(`category ${sat.category} adapters not in the umbrella: ${left.join(', ')}`);
  }
  for (const a of adapters) {
    if (/\*\*Unverified/.test(a.instructions ?? '')) {
      // An umbrella lists every system and marks the unverified ones; a
      // single-system satellite would be promoting one.
      (sat.type === 'umbrella' ? warnings : blockers).push(`adapter ${a.slug} declares itself unverified against a live tenant`);
    }
  }

  // Topics
  const topics = [...config.baseTopics, ...(sat.topics ?? [])];
  const seen = new Set();
  for (const t of topics) {
    if (!TOPIC_RE.test(t)) errors.push(`topic "${t}" is not a valid GitHub topic`);
    if (seen.has(t)) errors.push(`topic "${t}" is duplicated`);
    seen.add(t);
    if (!(t in topicCounts.counts)) errors.push(`topic "${t}" was never measured (add it to topic-counts.json)`);
  }
  if (seen.size < 12 || seen.size > 20) errors.push(`${seen.size} topics (12–20)`);
  if (!seen.has('anythingmcp')) errors.push('topic "anythingmcp" missing');

  // Links and ownership
  if (!config.owners[sat.owner]) errors.push(`unknown owner ${sat.owner}`);
  if (!/^https:\/\/anythingmcp\.com\//.test(sat.website ?? '')) errors.push('website must be an https://anythingmcp.com/ URL');
  for (const r of [...(sat.related ?? []), ...(sat.umbrella ? [sat.umbrella] : [])]) {
    if (!config.satellites.some((s) => s.repo === r)) errors.push(`related repo ${r} is not in the config`);
  }

  // Content
  for (const lang of sat.languages ?? ['en']) {
    for (const part of ['prompts', 'faq']) {
      if (!content[lang]?.[part]) (lang === 'en' ? blockers : warnings).push(`no ${part}${lang === 'en' ? '' : `.${lang}`}.md in content/${sat.repo}/`);
    }
  }

  // Publishing
  if (!sat.lastVerified) blockers.push('lastVerified is null: nobody has confirmed it against a live system');
  if (!config.license) blockers.push('licence not decided (config.license is null)');
  if (sat.blockedBy) blockers.push(sat.blockedBy);

  return { errors, warnings, blockers };
}

// ── File generation ────────────────────────────────────────────────────────

const pretty = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/** The read-only call scripts/smoke.mjs makes once tools/list has passed. */
function smokeCall(sat, adapters) {
  for (const a of adapters) {
    const byProbe = a.probe?.tool && a.tools.find((t) => t.name === a.probe.tool);
    const candidates = byProbe ? [byProbe, ...a.tools] : a.tools;
    const t = candidates.find(
      (x) => access(x, a.connector?.type) === 'read' && !(x.parameters?.required ?? []).length,
    );
    if (t) return { tool: t.name, args: {}, mayFailWithoutCredentials: true };
  }
  return null;
}

const healthy = (test) =>
  `    healthcheck:\n      test: ${test}\n      interval: 3s\n      timeout: 3s\n      retries: 30\n    restart: unless-stopped\n`;
const nodeService = (name, dir, port) =>
  `  ${name}:\n    image: node:22-alpine\n    container_name: \${COMPOSE_PROJECT_NAME:-amcp}-${name}\n    working_dir: /srv\n    command: ["node", "server.mjs"]\n    volumes:\n      - ./examples/${dir}:/srv:ro\n    ports:\n      - "127.0.0.1:\${${port}:-8080}:8080"\n` +
  healthy('["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]');

/**
 * The runnable demo each generic satellite ships, so a visitor sees the whole
 * chain work in five minutes: the service(s) added to docker-compose, the
 * files they need, how install.sh wires them up, and what smoke.mjs expects.
 */
export const DEMOS = {
  soap: {
    label: 'a demo SOAP service',
    hosts: ['soap-demo'],
    services: nodeService('soap-demo', 'soap-demo', 'SOAP_DEMO_PORT'),
    files: { 'examples/soap-demo/server.mjs': 'soap-demo/server.mjs', 'examples/soap-demo/inventory.wsdl': 'soap-demo/inventory.wsdl' },
    setup: { type: 'soap', name: 'Inventory (demo SOAP service)', baseUrl: 'http://soap-demo:8080/inventory', wsdl: 'http://soap-demo:8080/inventory?wsdl' },
    // AnythingMCP names WSDL tools <service>_<operation>, lower-cased.
    expectedTools: () => ['inventoryservice_getitem', 'inventoryservice_listlowstock', 'inventoryservice_getorderstatus'],
    smokeCall: { tool: 'inventoryservice_getitem', args: { sku: 'DR-1001' } },
  },
  sql: {
    label: 'demo PostgreSQL and MySQL databases',
    hosts: ['pg-demo', 'mysql-demo'],
    services:
      '  pg-demo:\n    image: postgres:17-alpine\n    container_name: ${COMPOSE_PROJECT_NAME:-amcp}-pg-demo\n    environment:\n      - POSTGRES_USER=shop_owner\n      - POSTGRES_PASSWORD=shop_owner\n      - POSTGRES_DB=shop\n    volumes:\n      - ./examples/sql-demo/postgres.sql:/docker-entrypoint-initdb.d/10-shop.sql:ro\n' +
      healthy('["CMD-SHELL", "pg_isready -U shop_owner -d shop"]') +
      '\n  mysql-demo:\n    image: mysql:8\n    container_name: ${COMPOSE_PROJECT_NAME:-amcp}-mysql-demo\n    environment:\n      - MYSQL_ROOT_PASSWORD=root-demo\n      - MYSQL_DATABASE=shop\n    volumes:\n      - ./examples/sql-demo/mysql.sql:/docker-entrypoint-initdb.d/10-shop.sql:ro\n' +
      // TCP, not the socket: during init MySQL runs a socket-only server that
      // would answer the ping before the seed has run.
      healthy('["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -proot-demo --silent"]'),
    files: { 'examples/sql-demo/postgres.sql': 'sql-demo/postgres.sql', 'examples/sql-demo/mysql.sql': 'sql-demo/mysql.sql' },
    setup: { type: 'adapter' },
    // The demo databases, reached as the read-only user the seed creates.
    envDefaults: {
      POSTGRES_HOST: 'pg-demo', POSTGRES_PORT: '5432', POSTGRES_DATABASE: 'shop', POSTGRES_USER: 'amcp_reader', POSTGRES_PASSWORD: 'amcp_reader',
      MYSQL_HOST: 'mysql-demo', MYSQL_PORT: '3306', MYSQL_DATABASE: 'shop', MYSQL_USER: 'amcp_reader', MYSQL_PASSWORD: 'amcp_reader',
    },
    expectedTools: (adapters) => adapters.filter((a) => ['postgres', 'mysql'].includes(a.slug)).flatMap((a) => a.tools.map((t) => t.name)),
    smokeCall: {
      tool: 'postgres_query',
      args: { query: "SELECT c.name, o.order_number, o.order_date FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'OPEN' ORDER BY o.order_date LIMIT 10" },
    },
  },
  openapi: {
    label: 'a demo REST API with an OpenAPI spec',
    hosts: ['api-demo'],
    services: nodeService('api-demo', 'api-demo', 'API_DEMO_PORT'),
    files: { 'examples/api-demo/server.mjs': 'api-demo/server.mjs' },
    setup: {
      type: 'openapi',
      name: 'Orders API (demo)',
      baseUrl: 'http://api-demo:8080',
      spec: 'http://api-demo:8080/openapi.json',
      authType: 'API_KEY',
      authConfig: { headerName: 'X-Api-Key', apiKey: 'demo-key' },
    },
    // Tool names come from the spec's operationIds, lower-cased.
    expectedTools: () => ['listcustomers', 'getcustomer', 'listorders', 'getorder', 'addordernote'],
    smokeCall: { tool: 'listorders', args: { status: 'OPEN' } },
  },
};

/** docker-compose.yml: the main repository's quickstart, plus the demo services of a generic satellite. */
export function buildCompose(quickstart, sat) {
  let yml = quickstart;
  const demo = DEMOS[sat.kind];
  const header = [
    `# ${sat.repo}: AnythingMCP, pulled from Docker Hub${demo ? `, plus ${demo.label}` : ''}.`,
    '# Generated from docker-compose.quickstart.yml in HelpCode-ai/anythingmcp.',
    '# Start it with ./scripts/install.sh, which also writes .env.',
    '',
  ].join('\n');
  yml = yml.replace(/^# =+\n[\s\S]*?^# =+\n\n/m, header);
  if (demo) {
    const anchor = '      - ALLOW_OPEN_REGISTRATION=false\n';
    if (!yml.includes(anchor)) throw new Error('quickstart compose changed: registration anchor not found');
    yml = yml.replace(
      anchor,
      `${anchor}      # The demo services are private Docker hostnames; the SSRF guard blocks\n      # those unless they are listed here.\n      - SSRF_ALLOWED_HOSTS=${demo.hosts.join(',')}\n`,
    );
    const pg = '\n  postgres:\n';
    if (!yml.includes(pg)) throw new Error('quickstart compose changed: postgres service not found');
    yml = yml.replace(pg, `\n${demo.services}${pg}`);
  }
  return yml;
}

function envExample(adapters, defaults = {}) {
  const lines = [
    '# Copied to .env by scripts/install.sh, which also fills the secrets.',
    '# Keep .env: ENCRYPTION_KEY decrypts every credential AnythingMCP stores.',
    'JWT_SECRET=',
    'ENCRYPTION_KEY=',
    '',
    '# First admin account, created by scripts/install.sh.',
    'AMCP_ADMIN_EMAIL=',
    'AMCP_ADMIN_PASSWORD=',
  ];
  for (const a of adapters) {
    lines.push('', `# ${a.name}: fill these and re-run scripts/install.sh to install the connector.`);
    for (const v of a.requiredEnvVars ?? []) lines.push(`${v}=${defaults[v] ?? ''}`);
  }
  lines.push('', '# Written by scripts/install.sh.', 'MCP_URL=', 'MCP_API_KEY=');
  return `${lines.join('\n')}\n`;
}

function citation(sat, config) {
  const owner = sat.owner === 'kochfreiburg' ? 'KOCH Freiburg GmbH' : sat.owner === 'HelpCode-ai' ? 'helpcode.ai GmbH' : sat.owner;
  return [
    'cff-version: 1.2.0',
    `title: "${sat.repo}: ${sat.about.replace(/"/g, "'")}"`,
    'message: "If you use this software, please cite AnythingMCP, which it is built on."',
    'type: software',
    'authors:',
    `  - name: "${owner}"`,
    `repository-code: "https://github.com/${sat.owner}/${sat.repo}"`,
    `url: "${sat.website}"`,
    ...(config.license ? [`license: ${config.license}`] : []),
    'references:',
    '  - type: software',
    '    title: "AnythingMCP"',
    '    authors:',
    '      - name: "helpcode.ai GmbH"',
    `    repository-code: "https://github.com/${config.mainRepo}"`,
    '',
  ].join('\n');
}

const MIT = (holder, year) => `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * Every file of one satellite, as { relativePath: contents }. Pure apart from
 * reading templates, so the snapshot tests can call it directly.
 */
export function buildSatellite(sat, ctx) {
  const { config, catalog, date, root = ROOT } = ctx;
  const content = ctx.content ?? loadContent(sat.repo);
  const entries = (sat.adapters ?? []).map((slug) => catalog.get(slug));
  const adapters = entries.map((e) => e.adapter);
  const tpl = (f) => readFileSync(join(HERE, 'templates', f), 'utf8');
  const files = {};
  const withAdapters = sat.type !== 'generic' || adapters.length > 0;

  if (sat.type === 'generic' && !DEMOS[sat.kind]) {
    throw new Error(`${sat.repo}: no demo is implemented yet for generic kind "${sat.kind}"`);
  }

  const manifest = {
    $comment: 'Read by scripts/install.sh, scripts/smoke.mjs and the sync workflow. Generated; edit satellites.config.json in HelpCode-ai/anythingmcp instead.',
    repo: sat.repo,
    owner: sat.owner,
    mainRepo: config.mainRepo,
    adapters: entries.map((e) => ({ slug: e.adapter.slug, region: e.region, requiredEnvVars: e.adapter.requiredEnvVars ?? [] })),
    setup: DEMOS[sat.kind]?.setup ?? { type: 'adapter' },
    smokeCall: DEMOS[sat.kind]?.smokeCall ?? smokeCall(sat, adapters),
  };
  if (DEMOS[sat.kind]) manifest.expectedTools = DEMOS[sat.kind].expectedTools(adapters);
  files['satellite.json'] = pretty(manifest);

  for (const lang of sat.languages ?? ['en']) {
    const path = lang === 'en' ? 'README.md' : `docs/README.${lang}.md`;
    const readme = renderReadme(sat, { ...ctx, adapters, content, lang, manifest });
    if (readme) files[path] = readme;
  }
  const prompts = content.en?.prompts;
  if (prompts) files['examples/prompts.md'] = `# Example prompts: ${sat.system}\n\n${prompts}\n`;

  for (const e of entries) files[`adapter/${e.adapter.slug}.json`] = pretty(e.adapter);
  files['docker-compose.yml'] = buildCompose(readFileSync(join(root, 'docker-compose.quickstart.yml'), 'utf8'), sat);
  files['.env.example'] = envExample(adapters, DEMOS[sat.kind]?.envDefaults);
  files['.gitignore'] = '.env\nnode_modules/\n';
  files['package.json'] = pretty({
    name: sat.repo,
    private: true,
    type: 'module',
    description: sat.about,
    scripts: {
      smoke: 'node scripts/smoke.mjs',
      ...(withAdapters ? { 'render-tools': 'node scripts/render-tools.mjs', sync: 'node scripts/sync-adapter.mjs' } : {}),
    },
    dependencies: { '@modelcontextprotocol/sdk': MCP_SDK_VERSION },
    engines: { node: '>=18' },
  });
  files['scripts/install.sh'] = tpl('install.sh');
  files['scripts/smoke.mjs'] = tpl('smoke.mjs');
  if (withAdapters) {
    files['scripts/render-tools.mjs'] = tpl('render-tools.mjs');
    files['scripts/sync-adapter.mjs'] = tpl('sync-adapter.mjs');
    files['.github/workflows/sync-adapter.yml'] = tpl('sync-adapter.yml').replace(
      '__ASSIGNEES__\n',
      config.owners[sat.owner]?.syncAssignees?.length
        ? `          assignees: ${config.owners[sat.owner].syncAssignees.join(', ')}\n`
        : '',
    );
  }
  for (const [dest, src] of Object.entries(DEMOS[sat.kind]?.files ?? {})) files[dest] = tpl(src);
  files['CITATION.cff'] = citation(sat, config);
  if (config.license === 'MIT') {
    const holder = sat.owner === 'kochfreiburg' ? 'KOCH Freiburg GmbH' : sat.owner === 'HelpCode-ai' ? 'helpcode.ai GmbH' : sat.owner;
    files.LICENSE = MIT(holder, date.slice(0, 4));
  } else if (config.license === 'AGPL-3.0-only') {
    files.LICENSE = readFileSync(join(root, 'LICENSE'), 'utf8');
  }
  return files;
}

/** gh commands that set About, website and topics, one block per repository. */
export function applyMetadataScript(sats, config) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = [
    '#!/usr/bin/env bash',
    '# Sets About, website and topics on each satellite. Run it from a machine',
    '# where `gh` is logged in with admin rights on the owner. Generated by',
    '# scripts/satellites/generate.mjs; do not edit by hand.',
    'set -euo pipefail',
    '',
  ];
  for (const s of sats) {
    const topics = [...config.baseTopics, ...s.topics];
    lines.push(
      `# ${s.owner}/${s.repo}`,
      `gh repo edit ${s.owner}/${s.repo} \\`,
      `  --description ${q(s.about)} \\`,
      `  --homepage ${q(s.website)} \\`,
      `  --add-topic ${topics.join(',')}`,
      '',
    );
  }
  return `${lines.join('\n')}`;
}

export { renderToolsTable };
