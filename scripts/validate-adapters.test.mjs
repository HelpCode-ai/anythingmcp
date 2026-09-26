import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as validatorModule from './validate-adapters.mjs';

const { validateAdapter, renderReport } = validatorModule;
const docs = readFileSync(new URL('../docs/tool-definition.md', import.meta.url), 'utf8');

function adapter(overrides = {}) {
  return {
    slug: 'good', name: 'Good', description: 'A valid adapter', region: 'de',
    category: 'other', icon: 'good', docsUrl: 'https://example.test',
    requiredEnvVars: ['GOOD_KEY'], connector: { type: 'REST', authType: 'API_KEY' },
    instructions: 'x'.repeat(800),
    tools: [{ name: 'good_lookup', description: 'x'.repeat(60), parameters: {
      type: 'object', properties: { query: { type: 'string', description: 'query' } },
    } }],
    ...overrides,
  };
}

test('blocking diagnostics identify every error family with paths, fixes, and docs anchors', () => {
  const invalid = adapter({
    slug: 'wrong', connector: { type: 'INVALID', authType: 'INVALID' },
    optionalEnvVars: ['GOOD_KEY'],
    tools: [{ name: 'wrong_tool' }, {}, {}, { name: 'wrong_tool_4', parameters: {
      properties: { foo: {} },
    } }],
  });
  const result = validateAdapter(invalid, 'bad.json', 'de');
  const output = renderReport([{ region: 'de', file: 'bad.json', ...result }], true);
  assert.match(output.stderr, /de\/bad\.json.*optional-env-overlap.*path: optionalEnvVars\[0\]/);
  assert.match(output.stderr, /path: optionalEnvVars\[0\].*tool-definition\.md#adapter-fields/);
  assert.match(output.stderr, /path: tools\[1\]\.name/);
  assert.match(output.stderr, /path: tools\[3\]\.parameters\.properties\.foo/);
  assert.match(output.stdout, /0 passed, 1 failed/);
});

test('malformed JSON reports the root JSONPath and parse-specific action', () => {
  const loaded = validatorModule.loadAdapter('broken.json', () => '{');
  assert.equal(loaded.errors[0].path, '$');
  assert.match(loaded.errors[0].message, /invalid JSON/);
  assert.match(loaded.errors[0].fix, /JSON syntax/);
  assert.match(loaded.errors[0].docs, /adapter-file-errors/);
});

test('valid JSON primitives are failed as an invalid adapter envelope', () => {
  for (const source of ['null', '7']) {
    const loaded = validatorModule.loadAdapter('primitive.json', () => source);
    assert.equal(loaded.ok, true);
    const result = validatorModule.adapterResult(loaded, 'primitive.json', 'de');
    assert.equal(result.errors[0].rule, 'adapter-envelope');
    assert.match(result.errors[0].message, /JSON object/);
  }
});

test('malformed tool entries use the blocking unnamed-tool diagnostic', () => {
  for (const tool of [null, 'not an object']) {
    const result = validateAdapter(adapter({ tools: [tool] }), 'good.json', 'de');
    assert.equal(result.errors[0].rule, 'tool-name');
    assert.equal(result.errors[0].path, 'tools[0].name');
  }
});

test('stat failures retain JSON candidates for actionable read diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-validator-'));
  mkdirSync(join(root, 'de'));
  writeFileSync(join(root, 'de', 'gone.json'), '{}');
  const candidates = validatorModule.collectAdapters(root, () => { throw new Error('disappeared'); });
  assert.equal(candidates.length, 1);
  const loaded = validatorModule.loadAdapter(candidates[0].fullPath, () => { throw new Error('gone'); });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.rule, 'json-read');
});

test('missing required fields remain individually actionable', () => {
  const result = validateAdapter({}, 'empty.json', 'de');
  assert.deepEqual(result.errors.map(({ rule, path }) => [rule, path]), [
    ['required-field', 'slug'], ['required-field', 'name'], ['required-field', 'description'],
    ['required-field', 'region'], ['required-field', 'category'], ['required-field', 'icon'],
    ['required-field', 'docsUrl'], ['required-field', 'requiredEnvVars'],
    ['required-field', 'connector'], ['required-field', 'tools'],
  ]);
});

test('connector, auth, optional-env shape, and empty tools are blocking families', () => {
  const result = validateAdapter(adapter({
    connector: {}, optionalEnvVars: { BAD: true }, tools: [],
  }), 'good.json', 'de');
  assert.deepEqual(result.errors.map(({ rule }) => rule), [
    'connector-type', 'auth-type', 'optional-env-shape', 'tools',
  ]);
});

test('envVarAliases must be keyed by a current variable and list only previous names', () => {
  const ok = validateAdapter(adapter({ envVarAliases: { GOOD_KEY: ['OLD_KEY'] } }), 'good.json', 'de');
  assert.deepEqual(ok.errors, []);

  const shape = validateAdapter(adapter({ envVarAliases: { GOOD_KEY: 'OLD_KEY' } }), 'good.json', 'de');
  assert.deepEqual(shape.errors.map(({ rule }) => rule), ['env-alias-shape']);

  const wrong = validateAdapter(adapter({ envVarAliases: { OLD_KEY: ['GOOD_KEY'] } }), 'good.json', 'de');
  assert.deepEqual(wrong.errors.map(({ rule, path }) => [rule, path]), [
    ['env-alias-unknown', 'envVarAliases.OLD_KEY'],
    ['env-alias-current', 'envVarAliases.OLD_KEY'],
  ]);
});

test('required-env warning preserves the explanatory operator guidance', () => {
  const result = validateAdapter(adapter(), 'good.json', 'de');
  assert.equal(result.warnings[0].message, 'requiredEnvVars contains "GOOD_KEY" but it\'s not auto-injected via {{GOOD_KEY}} (operator must set it for documentation, agent passes it as a tool param)');
});

test('an optional key used as ${VAR} in a tool header counts as referenced', () => {
  const withTemplate = adapter({
    requiredEnvVars: [],
    optionalEnvVars: ['GOOD_KEY'],
    tools: [{ name: 'good_lookup', description: 'x'.repeat(60), parameters: { type: 'object', properties: {} },
      endpointMapping: { method: 'GET', path: '/x', headers: { Authorization: 'Bearer ${GOOD_KEY}' } } }],
  });
  assert.deepEqual(validateAdapter(withTemplate, 'good.json', 'de').warnings, []);
  const unused = adapter({ requiredEnvVars: [], optionalEnvVars: ['GOOD_KEY'] });
  assert.equal(validateAdapter(unused, 'good.json', 'de').warnings[0].rule, 'optional-env-reference');
});

test('leftover TODO markers are non-blocking warnings with the path of each one', () => {
  const draft = adapter({
    description: 'TODO: describe this adapter',
    tools: [{ name: 'good_lookup', description: 'x'.repeat(60), parameters: {
      type: 'object', properties: { query: { type: 'string', description: 'TODO: what to look up' } },
    } }],
  });
  const result = validateAdapter(draft, 'good.json', 'de');
  const todos = result.warnings.filter((w) => w.rule === 'todo-marker');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(todos.map((w) => w.path), ['description', 'tools[0].parameters.properties.query.description']);
  assert.match(todos[0].message, /leftover TODO marker at description/);
});

test('the TODO rule ignores lowercase mentions and adds nothing to a clean adapter', () => {
  const clean = adapter({ description: 'Manage your to-do list and todo items in Todoist' });
  const result = validateAdapter(clean, 'good.json', 'de');
  assert.equal(result.warnings.some((w) => w.rule === 'todo-marker'), false);
});

test('read failures use an injected reader and a distinct actionable diagnostic', () => {
  const loaded = validatorModule.loadAdapter('missing.json', () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  });
  assert.equal(loaded.errors[0].path, '$');
  assert.match(loaded.errors[0].message, /unable to read adapter file.*permission denied/);
  assert.match(loaded.errors[0].fix, /file permissions|file path/i);
  assert.match(loaded.errors[0].docs, /adapter-file-errors/);
});

test('default output keeps summaries and grouped counts on stdout, details on stderr', () => {
  const noisy = adapter({ slug: 'noisy', instructions: 'short', tools: [{
    name: 'other', description: 'short', parameters: { properties: {
      first: { type: 'string' }, second: { type: 'string' },
    } },
  }] });
  const result = renderReport([{ region: 'de', file: 'noisy.json', ...validateAdapter(noisy, 'noisy.json', 'de') }], false);
  assert.match(result.stdout, /Warnings by rule:/);
  assert.match(result.stdout, /parameter-description.*2/);
  assert.doesNotMatch(result.stdout, /noisy\.json.*missing description/);
  assert.equal(result.stderr, '');

  const warned = renderReport([{ region: 'de', file: 'noisy.json', ...validateAdapter(noisy, 'noisy.json', 'de') }], true);
  assert.match(warned.stderr, /noisy\.json.*path: tools\[0\]\.parameters\.properties\.first/);
  assert.match(warned.stdout, /Warnings by rule:.*instructions.*1/s);
});

test('diagnostic docs use ordinary GitHub heading slugs', () => {
  for (const [heading, anchor] of [
    ['Adapter envelope', 'adapter-envelope'], ['Adapter fields', 'adapter-fields'],
    ['Tools', 'tools'], ['Connector', 'connector'], ['Authentication', 'authentication'],
    ['Adapter file errors', 'adapter-file-errors'], ['GraphQL variables', 'graphql-variables'],
  ]) {
    assert.match(docs, new RegExp(`^#{2,3} ${heading}$`, 'm'));
    const diagnostic = renderReport([{
      region: 'de', file: 'bad.json', errors: [{ rule: 'test', path: '$', message: 'test', fix: 'fix', docs: anchor }], warnings: [],
    }], false);
    assert.match(diagnostic.stderr, new RegExp(`tool-definition\\.md#${anchor}`));
  }
  assert.doesNotMatch(docs, /\{#[^}]+\}/);
});

test('DATABASE adapters may authenticate with a connection string', () => {
  const result = validateAdapter(adapter({
    slug: 'postgres', icon: 'postgres', region: 'intl',
    connector: { type: 'DATABASE', authType: 'CONNECTION_STRING' },
  }), 'postgres.json', 'intl');
  assert.deepEqual(result.errors, []);
});

test('the per-country region directories are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-validator-regions-'));
  const regions = ['it', 'es', 'fr', 'nl', 'be', 'ch', 'se', 'dk'];
  for (const region of regions) {
    mkdirSync(join(root, region));
    writeFileSync(join(root, region, `${region}-one.json`), '{}');
  }
  const found = validatorModule.collectAdapters(root).map((c) => c.region);
  assert.deepEqual(found.sort(), [...regions].sort());
});

function graphqlAdapter(endpointMapping, properties = { post_id: { type: 'string', description: 'id' } }) {
  return adapter({
    connector: { type: 'GRAPHQL', authType: 'BEARER_TOKEN' },
    tools: [{ name: 'good_get_post', description: 'x'.repeat(60), parameters: { type: 'object', properties }, endpointMapping }],
  });
}
const graphqlErrors = (endpointMapping, properties) =>
  validateAdapter(graphqlAdapter(endpointMapping, properties), 'good.json', 'de').errors.filter((e) => e.rule === 'graphql-variables');

test('GraphQL variables mapped through queryParams pass', () => {
  assert.deepEqual(graphqlErrors({
    method: 'query',
    path: 'query GetPost($id: ID!, $first: Int = 20, $after: String) { post(id: $id) { id } }',
    queryParams: { id: '$post_id', first: 20 },
  }), []);
});

test('GraphQL bodyMapping is rejected: the engine never reads it and sends variables {}', () => {
  const errors = graphqlErrors({
    method: 'query',
    path: 'query GetPost($id: ID!) { post(id: $id) { id } }',
    bodyMapping: { variables: { id: '$post_id' } },
  });
  assert.deepEqual(errors.map((e) => e.path), ['tools[0].endpointMapping.bodyMapping', 'tools[0].endpointMapping.path']);
  assert.match(errors[0].message, /never reads/);
  assert.match(errors[1].message, /required variable \$id/);
  assert.equal(errors[0].docs, 'graphql-variables');
});

test('bodyMapping stays legal on REST adapters that POST to a /graphql path', () => {
  const rest = adapter({ tools: [{ name: 'good_nrql', description: 'x'.repeat(60), parameters: { type: 'object', properties: {} },
    endpointMapping: { method: 'POST', path: '/graphql', bodyMapping: { query: 'query($a: Int!) { x(a: $a) }', variables: { a: '$a' } } } }] });
  assert.deepEqual(validateAdapter(rest, 'good.json', 'de').errors, []);
});

test('GraphQL queryParams must be flat, declared, and point at a real parameter', () => {
  const nested = graphqlErrors({
    method: 'mutation',
    path: 'mutation Update($input: PostInput!) { update(input: $input) { id } }',
    queryParams: { input: { id: '$post_id' } },
  });
  assert.equal(nested.length, 1);
  assert.match(nested[0].message, /nests \$param references/);

  // A literal object constant has nothing to resolve, and is sent as written.
  assert.deepEqual(graphqlErrors({
    method: 'query',
    path: 'query Posts($filter: Filter!) { posts(filter: $filter) { id } }',
    queryParams: { filter: { status: 'OPEN' } },
  }, {}), []);

  const undeclared = graphqlErrors({ method: 'query', path: 'query GetPost($id: ID!) { post(id: $id) { id } }', queryParams: { id: '$post_id', postId: '$post_id' } });
  assert.deepEqual(undeclared.map((e) => e.path), ['tools[0].endpointMapping.queryParams.postId']);
  assert.match(undeclared[0].message, /does not declare/);

  const unknownParam = graphqlErrors({ method: 'query', path: 'query GetPost($id: ID!) { post(id: $id) { id } }', queryParams: { id: '$postId' } });
  assert.match(unknownParam[0].message, /neither a tool parameter nor an env var/);

  // Env vars are injected as parameters by name, so they count.
  assert.deepEqual(graphqlErrors({ method: 'query', path: 'query GetPost($id: ID!) { post(id: $id) { id } }', queryParams: { id: '$GOOD_KEY' } }), []);
});

test('generic GraphQL tools that take the operation as input are not checked for variables', () => {
  assert.deepEqual(graphqlErrors({ method: 'query', path: '$query', variablesFromParam: 'variables' }, {
    query: { type: 'string', description: 'q' }, variables: { type: 'object', description: 'v' },
  }), []);
  assert.deepEqual(graphqlErrors({ method: 'static', path: 'https://example.test/schema' }, {}), []);
});

test('graphqlVariableDefinitions reads required-ness, defaults and anonymous documents', () => {
  assert.deepEqual(validatorModule.graphqlVariableDefinitions(
    'query Q($a: ID!, $b: [Int!]! = [1], $c: String @deprecated, $d: Input!) { x }',
  ), [
    { name: 'a', required: true }, { name: 'b', required: false },
    { name: 'c', required: false }, { name: 'd', required: true },
  ]);
  assert.deepEqual(validatorModule.graphqlVariableDefinitions('{ me { id } }'), []);
  assert.deepEqual(validatorModule.graphqlVariableDefinitions('mutation($in: X!) { a }'), [{ name: 'in', required: true }]);
});
