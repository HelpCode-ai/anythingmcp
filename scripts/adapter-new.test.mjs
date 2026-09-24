import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_AUTH_TYPES, REGIONS } from './validate-adapters.mjs';
import { ScaffoldError, buildSkeleton, main, scaffold } from './adapter-new.mjs';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'adapter-new-'));

/** Run the CLI against a temp root and collect what it printed. */
function run(argv, root) {
  const out = [];
  const err = [];
  const code = main(argv, { root, out: (m) => out.push(m), err: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('a skeleton passes every hard gate for every supported auth type', () => {
  const root = tempRoot();
  for (const auth of ALLOWED_AUTH_TYPES) {
    const slug = `demo-${auth.toLowerCase().replace(/_/g, '-')}`;
    const { result } = scaffold({ slug, region: 'de', auth, root });
    assert.deepEqual(result.errors, [], `${auth} skeleton has blocking errors`);
  }
});

test('a fresh skeleton only warns about its TODO markers, and does warn about them', () => {
  const { result } = scaffold({ slug: 'acme-crm', region: 'intl', auth: 'API_KEY', root: tempRoot() });
  const rules = new Set(result.warnings.map((w) => w.rule));
  assert.deepEqual([...rules], ['todo-marker']);
  const paths = result.warnings.map((w) => w.path);
  for (const path of ['name', 'description', 'docsUrl', 'connector.baseUrl', 'connector.authConfig.headerName', 'tools[0].description']) {
    assert.ok(paths.includes(path), `expected a todo-marker at ${path}`);
  }
});

test('the skeleton has one example tool named after the slug, and wires the API key through a placeholder', () => {
  const adapter = buildSkeleton({ slug: 'acme-crm', region: 'intl', auth: 'API_KEY' });
  assert.equal(adapter.slug, 'acme-crm');
  assert.equal(adapter.tools.length, 1);
  assert.equal(adapter.tools[0].name, 'acme_crm_example');
  assert.deepEqual(adapter.requiredEnvVars, ['ACME_CRM_API_KEY']);
  assert.equal(adapter.connector.authConfig.apiKey, '{{ACME_CRM_API_KEY}}');
});

test('NONE has no credentials, and other auth types get a TODO where the credentials go', () => {
  const none = buildSkeleton({ slug: 'open-data', region: 'de', auth: 'NONE' });
  assert.deepEqual(none.requiredEnvVars, []);
  assert.equal('authConfig' in none.connector, false);
  const bearer = buildSkeleton({ slug: 'acme-crm', region: 'de', auth: 'BEARER_TOKEN' });
  assert.match(bearer.connector.authConfig.credentials, /^TODO: .*BEARER_TOKEN/);
});

test('the file is written where the catalog looks for it, as JSON with a trailing newline', () => {
  const root = tempRoot();
  const { fullPath } = scaffold({ slug: 'acme-crm', region: 'gb', auth: 'BEARER_TOKEN', root });
  assert.equal(fullPath, join(root, 'gb', 'acme-crm.json'));
  const raw = readFileSync(fullPath, 'utf8');
  assert.equal(raw.endsWith('}\n'), true);
  assert.equal(JSON.parse(raw).region, 'gb');
});

test('an existing adapter is refused without --force, and left untouched', () => {
  const root = tempRoot();
  mkdirSync(join(root, 'de'));
  writeFileSync(join(root, 'de', 'acme-crm.json'), '{"keep":"me"}');
  assert.throws(() => scaffold({ slug: 'acme-crm', region: 'de', auth: 'NONE', root }), (e) => e instanceof ScaffoldError && /--force/.test(e.message));
  assert.equal(readFileSync(join(root, 'de', 'acme-crm.json'), 'utf8'), '{"keep":"me"}');
});

test('--force overwrites an existing adapter', () => {
  const root = tempRoot();
  scaffold({ slug: 'acme-crm', region: 'de', auth: 'NONE', root });
  const { fullPath } = scaffold({ slug: 'acme-crm', region: 'de', auth: 'BEARER_TOKEN', force: true, root });
  assert.equal(JSON.parse(readFileSync(fullPath, 'utf8')).connector.authType, 'BEARER_TOKEN');
});

test('bad slugs, regions and auth types are rejected before anything is written', () => {
  const root = tempRoot();
  // "3m-tracker" would become the import name `3mTracker`, which is not valid JS.
  for (const slug of ['', 'Bad_Slug', 'two--hyphens', '-leading', 'trailing-', 'has space', '3m-tracker', '1password']) {
    assert.throws(() => scaffold({ slug, region: 'de', auth: 'NONE', root }), /slug/, `slug "${slug}"`);
  }
  assert.throws(() => scaffold({ slug: 'ok', region: 'zz', auth: 'NONE', root }), /region "zz" is not one of/);
  assert.throws(() => scaffold({ slug: 'ok', region: 'de', auth: 'MAGIC', root }), /auth "MAGIC" is not one of/);
  assert.equal(existsSync(join(root, 'de')), false);
});

test('digits are fine after the first letter, and after a hyphen', () => {
  const root = tempRoot();
  for (const slug of ['s3', 'acme-3d', 'web-2-print']) {
    assert.deepEqual(scaffold({ slug, region: 'de', auth: 'NONE', root }).result.errors, [], slug);
  }
});

test('the CLI creates the file, reports the TODO count, and prints the three next commands', () => {
  const root = tempRoot();
  const { code, out, err } = run(['acme-crm', '--region', 'intl', '--auth', 'API_KEY'], root);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /Created .*intl\/acme-crm\.json/);
  assert.match(out, /Validated: 0 errors, \d+ TODO markers left/);
  assert.match(out, /1\. node scripts\/validate-adapters\.mjs --warn/);
  assert.match(out, /2\. node scripts\/regenerate-catalog\.mjs/);
  assert.match(out, /3\. npm run dev:backend/);
});

test('the CLI exits 1 with a usage message on missing or unknown arguments', () => {
  const root = tempRoot();
  for (const argv of [[], ['only-slug'], ['a', 'b', '--region', 'de', '--auth', 'NONE'], ['ok', '--region', 'de', '--auth', 'NONE', '--nope']]) {
    const { code, err } = run(argv, root);
    assert.equal(code, 1, argv.join(' '));
    assert.match(err, /Usage: node scripts\/adapter-new\.mjs/);
  }
});

test('the CLI turns a refusal into exit code 1 and a one-line error', () => {
  const root = tempRoot();
  run(['acme-crm', '--region', 'de', '--auth', 'NONE'], root);
  const { code, err } = run(['acme-crm', '--region', 'de', '--auth', 'NONE'], root);
  assert.equal(code, 1);
  assert.match(err, /^Error: .*already exists; pass --force/);
  assert.equal(err.includes('\\'), false, 'paths use forward slashes');
});

test('every region the validator scans is accepted by the scaffolder', () => {
  const root = tempRoot();
  for (const region of REGIONS) {
    const { result } = scaffold({ slug: `probe-${region}`, region, auth: 'NONE', root });
    assert.deepEqual(result.errors, [], region);
  }
});
