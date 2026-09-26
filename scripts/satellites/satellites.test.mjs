import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import {
  HERE,
  loadCatalog,
  loadConfig,
  loadTopicCounts,
  loadContent,
  checkSatellite,
  buildSatellite,
  buildCompose,
  uncoveredObjects,
  applyMetadataScript,
} from './lib.mjs';
import { access, renderToolsTable, replaceBetweenMarkers } from './templates/render-tools.mjs';
import { introWordCount } from './readme.mjs';

const FIXTURES = join(HERE, '__fixtures__');
const SNAPSHOTS = join(HERE, '__snapshots__');
const PILOTS = ['soap-to-mcp', 'weclapp-mcp-server', 'odoo-mcp-server'];
const config = loadConfig();
const topicCounts = loadTopicCounts();

/** Catalog frozen in __fixtures__/adapters, so an adapter PR never touches these snapshots. */
function fixtureCatalog() {
  const catalog = new Map();
  const regions = { weclapp: 'de', odoo: 'intl' };
  for (const f of readdirSync(join(FIXTURES, 'adapters'))) {
    const adapter = JSON.parse(readFileSync(join(FIXTURES, 'adapters', f), 'utf8'));
    catalog.set(adapter.slug, { adapter, region: regions[adapter.slug] });
  }
  return catalog;
}

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

for (const repo of PILOTS) {
  test(`snapshot: ${repo}`, () => {
    const sat = config.satellites.find((s) => s.repo === repo);
    const files = buildSatellite(sat, {
      config: { ...config, license: null },
      catalog: fixtureCatalog(),
      date: '2026-09-26',
      root: FIXTURES,
    });
    // Adapter copies are the fixtures themselves; everything else is generator output.
    const generated = Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('adapter/')));
    const dir = join(SNAPSHOTS, repo);
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      rmSync(dir, { recursive: true, force: true });
      for (const [rel, text] of Object.entries(generated)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
    }
    assert.ok(existsSync(dir), `no snapshot for ${repo}; run UPDATE_SNAPSHOTS=1 node --test scripts/satellites/`);
    const expected = walk(dir).map((p) => relative(dir, p)).sort();
    assert.deepEqual(Object.keys(generated).sort(), expected, 'file list changed');
    for (const rel of expected) {
      assert.equal(generated[rel], readFileSync(join(dir, rel), 'utf8'), `${repo}/${rel} differs from its snapshot`);
    }
  });
}

test('every configured satellite passes the static checks', () => {
  const catalog = loadCatalog();
  for (const sat of config.satellites) {
    const { errors } = checkSatellite(sat, { config, catalog, topicCounts, content: loadContent(sat.repo) });
    assert.deepEqual(errors, [], `${sat.owner}/${sat.repo}`);
  }
});

test('the pilot READMEs open with a 40–60 word direct answer', () => {
  for (const repo of PILOTS) {
    const sat = config.satellites.find((s) => s.repo === repo);
    const files = buildSatellite(sat, { config: { ...config, license: null }, catalog: fixtureCatalog(), date: '2026-09-26', root: FIXTURES });
    const n = introWordCount(files['README.md']);
    assert.ok(n >= 40 && n <= 60, `${repo}: ${n} words`);
  }
});

test('checks reject a bad About and bad topics', () => {
  const catalog = fixtureCatalog();
  const base = config.satellites.find((s) => s.repo === 'weclapp-mcp-server');
  const run = (patch) => checkSatellite({ ...base, ...patch }, { config, catalog, topicCounts, content: {} }).errors.join('\n');
  assert.match(run({ about: 'weclapp MCP server for Claude & ChatGPT.' }), /characters/);
  assert.match(run({ about: `🔌 ${base.about}`.slice(0, 130) }), /banned|start with/);
  assert.match(run({ about: 'weclapp MCP server: the #1 way to connect weclapp Cloud ERP to Claude & ChatGPT. Customers, orders and invoices.' }), /banned/);
  assert.match(run({ about: 'weclapp MCP server: connect weclapp Cloud ERP to Claude & ChatGPT. Customers, orders, invoices, refunds and tickets.' }), /refunds, tickets/);
  assert.match(run({ topics: ['weclapp'] }), /9 topics/);
  assert.match(run({ topics: [...base.topics, 'not-measured-topic'] }), /never measured/);
  assert.match(run({ topics: [...base.topics, 'Bad_Topic'] }), /not a valid/);
});

test('an About may name an API ("Selling Partner API") without promising partners', () => {
  const amazon = { tools: [{ name: 'amazon_seller_list_orders' }, { name: 'amazon_seller_fba_inventory' }] };
  assert.deepEqual(uncoveredObjects('Connect the Selling Partner API. Orders and FBA inventory.', [amazon]), []);
  assert.deepEqual(uncoveredObjects('Orders, partners and inventory.', [amazon]), ['partners']);
});

test('unverified adapters, missing verification and an undecided licence block publishing, not generation', () => {
  const sat = { ...config.satellites.find((s) => s.repo === 'odoo-mcp-server'), lastVerified: null };
  const unverified = { adapter: { ...fixtureCatalog().get('odoo').adapter, instructions: '**Unverified.** built from docs' }, region: 'intl' };
  const catalog = new Map([['odoo', unverified]]);
  const { errors, blockers } = checkSatellite(sat, { config: { ...config, license: null }, catalog, topicCounts, content: loadContent(sat.repo) });
  assert.deepEqual(errors, []);
  assert.ok(blockers.some((b) => /lastVerified/.test(b)));
  assert.ok(blockers.some((b) => /licence/.test(b)));
  assert.ok(blockers.some((b) => /declares itself unverified/.test(b)));
});

test('an umbrella lists unverified adapters as a warning, not a blocker', () => {
  const sat = { ...config.satellites.find((s) => s.repo === 'erp-mcp-server'), adapters: ['odoo'] };
  const unverified = { adapter: { ...fixtureCatalog().get('odoo').adapter, instructions: '**Unverified.**' }, region: 'intl' };
  const { blockers, warnings } = checkSatellite(sat, { config, catalog: new Map([['odoo', unverified]]), topicCounts, content: loadContent(sat.repo) });
  assert.ok(!blockers.some((b) => /unverified/.test(b)));
  assert.ok(warnings.some((w) => /unverified/.test(w)));
});

test('links to unpublished siblings are dropped when publishing', () => {
  const sat = config.satellites.find((s) => s.repo === 'weclapp-mcp-server');
  const available = new Set(['kochfreiburg/weclapp-mcp-server', 'HelpCode-ai/erp-mcp-server']);
  const files = buildSatellite(sat, { config: { ...config, license: null, available }, catalog: fixtureCatalog(), date: '2026-09-26', root: FIXTURES });
  // Exact link targets, not substrings.
  const links = new Set([...files['README.md'].matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)].map((m) => new URL(m[1]).pathname));
  assert.ok(links.has('/HelpCode-ai/erp-mcp-server'));
  assert.ok(!links.has('/kochfreiburg/xentral-mcp-server'));
});

test('access(): protocol first, then tool names; model-written SQL reads (engine guard)', () => {
  assert.equal(access({ name: 'x_list', endpointMapping: { method: 'GET' } }), 'read');
  assert.equal(access({ name: 'odoo_search_read', endpointMapping: { method: 'POST' } }), 'read');
  assert.equal(access({ name: 'odoo_write', endpointMapping: { method: 'POST' } }), 'write');
  assert.equal(access({ name: 'x_update', endpointMapping: { method: 'PATCH' } }), 'write');
  assert.equal(access({ name: 'x', endpointMapping: { method: 'GET' }, annotations: { readOnlyHint: false } }), 'write');
  assert.equal(access({ name: 'db_query', endpointMapping: { method: 'query', path: '${query}' } }, 'DATABASE'), 'read');
  assert.equal(access({ name: 'db_tables', endpointMapping: { method: 'query', path: 'SELECT 1' } }, 'DATABASE'), 'read');
  assert.equal(access({ name: 'gql', endpointMapping: { method: 'mutation' } }, 'GRAPHQL'), 'write');
});

test('re-rendering the tools table is idempotent', () => {
  const { adapter } = fixtureCatalog().get('weclapp');
  const doc = `# x\n\n${renderToolsTable([adapter])}\n\nafter\n`;
  assert.equal(replaceBetweenMarkers(doc, renderToolsTable([adapter])), doc);
});

test('the SOAP compose file whitelists the demo host and adds the service', () => {
  const quickstart = readFileSync(join(FIXTURES, 'docker-compose.quickstart.yml'), 'utf8');
  const yml = buildCompose(quickstart, { repo: 'soap-to-mcp', kind: 'soap' });
  assert.match(yml, /SSRF_ALLOWED_HOSTS=soap-demo/);
  assert.match(yml, /\n {2}soap-demo:\n/);
  assert.doesNotThrow(() => buildCompose(quickstart, { repo: 'x', kind: undefined }));
});

test('apply-metadata.sh sets description, homepage and every topic', () => {
  const sat = config.satellites.find((s) => s.repo === 'weclapp-mcp-server');
  const sh = applyMetadataScript([sat], config);
  assert.match(sh, /gh repo edit kochfreiburg\/weclapp-mcp-server/);
  assert.match(sh, /--add-topic mcp,mcp-server,.*,weclapp,/);
});
