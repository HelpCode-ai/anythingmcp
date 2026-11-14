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

test('aliases are short names, each listed once', () => {
  const ok = validateAdapter(adapter({ aliases: ['Old Good', 'GD'] }), 'good.json', 'de');
  assert.deepEqual(ok.errors, []);

  for (const aliases of ['Old Good', [''], [42], ['x'.repeat(41)]]) {
    const bad = validateAdapter(adapter({ aliases }), 'good.json', 'de');
    assert.deepEqual(bad.errors.map(({ rule, path }) => [rule, path]), [['aliases-shape', 'aliases']]);
  }

  const twice = validateAdapter(adapter({ aliases: ['GD', 'gd'] }), 'good.json', 'de');
  assert.deepEqual(twice.errors.map(({ rule, path }) => [rule, path]), [['aliases-duplicate', 'aliases[1]']]);

  const own = validateAdapter(adapter({ aliases: ['good'] }), 'good.json', 'de');
  assert.deepEqual(own.errors, []);
  assert.ok(own.warnings.some(({ rule, path }) => rule === 'aliases-redundant' && path === 'aliases[0]'));
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
    ['Errors inside a 200 response', 'errors-inside-a-200-response'],
    ["MCP adapters \\(a vendor's own MCP server\\)", 'mcp-adapters-a-vendors-own-mcp-server'],
    ['XML bodies', 'xml-bodies'],
  ]) {
    assert.match(docs, new RegExp(`^#{2,3} ${heading}$`, 'm'));
    const diagnostic = renderReport([{
      region: 'de', file: 'bad.json', errors: [{ rule: 'test', path: '$', message: 'test', fix: 'fix', docs: anchor }], warnings: [],
    }], false);
    assert.match(diagnostic.stderr, new RegExp(`tool-definition\\.md#${anchor}`));
  }
  assert.doesNotMatch(docs, /\{#[^}]+\}/);
});

test('loginBasicAuth needs credentials and keeps the password out of the login body and headers', () => {
  const login = (authConfig, authType = 'LOGIN_TOKEN') => validateAdapter(adapter({
    connector: { type: 'REST', authType, authConfig: {
      loginUrl: 'https://good.test/login', loginMethod: 'POST', tokenJsonPath: 'data.token',
      username: '{{GOOD_USER}}', password: '{{GOOD_KEY}}', loginBasicAuth: true, loginBody: {}, ...authConfig,
    } },
    requiredEnvVars: ['GOOD_USER', 'GOOD_KEY'],
  }), 'good.json', 'de').errors.filter((e) => e.rule === 'login-basic-auth');

  assert.deepEqual(login({}), []);
  assert.deepEqual(login({ loginBasicAuth: false, loginBody: { p: '${password}' } }), []);
  for (const [config, expected] of [
    [{ username: undefined }, /needs authConfig\.username/],
    [{ password: '' }, /needs authConfig\.password/],
    [{ loginBody: { pass: '${password}' } }, /remove \$\{password\}/],
    [{ loginBodyTemplate: '{"p":"${passwordHashed}"}' }, /remove \$\{passwordHashed\}/],
    [{ loginHeaders: { authorization: 'Basic x' } }, /remove Authorization from loginHeaders/],
    [{ signedJwt: { privateKey: '{{GOOD_KEY}}' } }, /signedJwt/],
    [{ passwordHashing: { scheme: 'bcrypt' } }, /passwordHashing/],
    [{ loginBasicAuth: 'yes' }, /true or false/],
  ]) {
    const errors = login(config);
    assert.equal(errors.length, 1, JSON.stringify(config));
    assert.match(errors[0].message, expected);
    assert.equal(errors[0].docs, 'authentication');
  }
  assert.match(login({}, 'BASIC_AUTH')[0].message, /only applies to LOGIN_TOKEN/);
});

test('LOGIN_TOKEN for XML APIs: login formats, the token in the body and the re-login on a body error', () => {
  const TOKEN = '$' + '{loginToken}';
  const xmlTool = (bodyTemplate) => ({
    name: 'good_lookup', description: 'x'.repeat(60), parameters: { type: 'object', properties: {} },
    endpointMapping: { method: 'POST', path: '/q', bodyEncoding: 'xml', bodyTemplate },
  });
  const check = ({ authConfig = {}, authType = 'LOGIN_TOKEN', type = 'REST', config, tools } = {}) => validateAdapter(adapter({
    connector: {
      type, authType,
      authConfig: {
        loginUrl: 'https://good.test/auth', username: '{{GOOD_USER}}', password: '{{GOOD_KEY}}', tokenJsonPath: 'auth_response.token',
        loginBodyFormat: 'xml', loginBody: '<auth><key>$' + '{password}</key></auth>', loginResponseFormat: 'xml',
        tokenPlacement: 'body', refreshOnBody401: true, ...authConfig,
      },
      config: config === undefined ? { errorWhen: [{ path: 'r.error.code', equals: 'ERR_098', status: 401 }] } : config,
    },
    requiredEnvVars: ['GOOD_USER', 'GOOD_KEY'],
    tools: tools ?? [xmlTool(`<q token="${TOKEN}"/>`)],
  }), 'good.json', 'de').errors.filter((e) => e.rule === 'login-token-xml');

  assert.deepEqual(check(), []);
  // An adapter that sets none of the fields is not looked at.
  assert.deepEqual(check({ authConfig: { loginBodyFormat: undefined, loginResponseFormat: undefined, tokenPlacement: undefined, refreshOnBody401: undefined, loginBody: {} }, tools: [xmlTool('<q/>')] }), []);
  assert.deepEqual(check({ authConfig: { tokenPlacement: 'header', headerName: 'X-Token' }, tools: [xmlTool('<q/>')] }), []);
  for (const [options, expected] of [
    [{ authConfig: { loginBodyFormat: 'json' } }, /loginBodyFormat must be "xml"/],
    [{ authConfig: { loginBody: { key: 'x' } } }, /needs loginBody to be the XML document as a string/],
    [{ authConfig: { loginResponseFormat: true } }, /loginResponseFormat must be "xml"/],
    [{ authConfig: { tokenPlacement: 'query' } }, /tokenPlacement must be "header" or "body"/],
    [{ type: 'GRAPHQL' }, /only supported by REST connectors/],
    [{ tools: [xmlTool('<q/>')] }, /at least one tool's bodyTemplate must contain/],
    [{ authConfig: { headerTemplate: 'Bearer x' } }, /headerTemplate is not sent with tokenPlacement: "body"/],
    [{ authConfig: { tokenPlacement: undefined } }, /renders empty without authConfig\.tokenPlacement: "body"/],
    [{ authConfig: { refreshOnBody401: 'yes' } }, /refreshOnBody401 must be true or false/],
    [{ config: {} }, /refreshOnBody401 needs a connector\.config\.errorWhen rule with status 401/],
    [{ config: { errorWhen: [{ path: 'r.error', status: 400 }] } }, /rule with status 401/],
  ]) {
    const errors = check(options);
    assert.equal(errors.length, 1, JSON.stringify(options));
    assert.match(errors[0].message, expected);
    assert.equal(errors[0].docs, 'authentication');
  }
  const other = check({ authType: 'API_KEY' }).map((e) => e.message);
  assert.equal(other.length, 5);
  assert.ok(other.slice(0, 4).every((m) => /only applies to LOGIN_TOKEN authentication/.test(m)));
  assert.match(other[4], /needs LOGIN_TOKEN authentication with tokenPlacement: "body"/);
});

test('optional and repeated blocks in an XML bodyTemplate are named, closed and only in XML bodies', () => {
  const open = (kind, name) => '$' + `{${kind}${name}}`;
  const blocks = (bodyTemplate, bodyEncoding = 'xml') => validateAdapter(adapter({
    tools: [{
      name: 'good_lookup', description: 'x'.repeat(60), parameters: { type: 'object', properties: {} },
      endpointMapping: { method: 'POST', path: '/q', bodyEncoding, bodyTemplate },
    }],
  }), 'good.json', 'de').errors.filter((e) => e.rule === 'xml-template-blocks');

  const nested = `<q>${open('?', 'ids')}<ids>${open('*', 'ids')}<id/>${open('/', 'ids')}</ids>${open('/', 'ids')}${open('?', 'a|b')}<d/>${open('/', 'a|b')}</q>`;
  assert.deepEqual(blocks(nested), []);
  assert.deepEqual(blocks('<q>$' + '{page}</q>'), []);
  assert.deepEqual(blocks('{"a":"$' + '{page}"}', 'json'), []);
  for (const [template, encoding, expected] of [
    [`<q>${open('?', 'page')}<p/></q>`, 'xml', /the block page is not closed once for every time it is opened/],
    [`<q>${open('?', 'ids')}${open('*', 'ids')}<id/>${open('/', 'ids')}</q>`, 'xml', /the block ids is not closed once/],
    [`<q>${open('*', 'a|b')}<p/>${open('/', 'a|b')}</q>`, 'xml', /a block opener must name a parameter/],
    [`<q>${open('?', '')}<p/></q>`, 'xml', /a block opener must name a parameter/],
    [`{"a":"${open('?', 'page')}x${open('/', 'page')}"}`, 'json', /need bodyEncoding: "xml"/],
  ]) {
    const errors = blocks(template, encoding);
    assert.equal(errors.length, 1, template);
    assert.match(errors[0].message, expected);
    assert.equal(errors[0].docs, 'xml-bodies');
    assert.equal(errors[0].path, 'tools[0].endpointMapping.bodyTemplate');
  }
});

test('DATABASE adapters may authenticate with a connection string', () => {
  const result = validateAdapter(adapter({
    slug: 'postgres', icon: 'postgres', region: 'intl',
    connector: { type: 'DATABASE', authType: 'CONNECTION_STRING' },
  }), 'postgres.json', 'intl');
  assert.deepEqual(result.errors, []);
});

test('EMAIL adapters (IMAP/SMTP) are a supported connector type', () => {
  const result = validateAdapter(adapter({
    slug: 'imap-smtp', icon: 'imap-smtp', region: 'intl',
    connector: { type: 'EMAIL', authType: 'BASIC_AUTH' },
  }), 'imap-smtp.json', 'intl');
  assert.deepEqual(result.errors, []);
});

test('the per-country region directories are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-validator-regions-'));
  const regions = ['it', 'es', 'fr', 'nl', 'be', 'ch', 'se', 'dk', 'no', 'fi', 'cz', 'pl', 'ro', 'eg'];
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

test('envVarMeta describes declared variables with known fields only', () => {
  const ok = validateAdapter(adapter({ envVarMeta: { GOOD_KEY: { label: 'API key', kind: 'credential', secret: true, help: 'Settings > API', link: 'https://example.test/keys', pattern: '^[a-z0-9]+$' } } }), 'good.json', 'de');
  assert.deepEqual(ok.errors, []);
  const unknown = validateAdapter(adapter({ envVarMeta: { OTHER: { label: 'x' } } }), 'good.json', 'de');
  assert.ok(unknown.errors.some((e) => e.rule === 'env-meta-unknown'));
  const bad = validateAdapter(adapter({ envVarMeta: { GOOD_KEY: { kind: 'password', pattern: '(', link: 'http://x', colour: 'red' } } }), 'good.json', 'de');
  const rules = bad.errors.map((e) => e.rule).sort();
  assert.deepEqual(rules, ['env-meta-field', 'env-meta-kind', 'env-meta-link', 'env-meta-pattern']);
});

test('envVarMeta options are a list of 2 to 20 unique value and label pairs', () => {
  const fr = { value: 'https://fr.example.test', label: 'France' };
  const es = { value: 'https://es.example.test', label: 'Spain' };
  const check = (meta, extra = {}) => validateAdapter(adapter({
    requiredEnvVars: ['GOOD_KEY', 'GOOD_HOST'], envVarMeta: { GOOD_HOST: meta }, ...extra,
  }), 'good.json', 'de').errors;
  const paths = (meta, extra) => check(meta, extra).map((e) => `${e.rule} ${e.path}`);

  assert.deepEqual(check({ label: 'Country', kind: 'address', options: [fr, es] }), []);
  assert.deepEqual(check({ pattern: '^https://[a-z]+\\.example\\.test$', options: [fr, es] }), []);
  assert.deepEqual(check({ options: Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `Choice ${i}` })) }), []);
  // The value may equal the label, and an explicit "secret": false is fine.
  assert.deepEqual(check({ secret: false, options: [{ value: 'eu', label: 'eu' }, { value: 'us', label: 'us' }] }), []);

  for (const options of ['fr,es', {}, [], [fr], Array.from({ length: 21 }, (_, i) => ({ value: `v${i}`, label: `Choice ${i}` }))]) {
    assert.deepEqual(paths({ options }), ['env-meta-options envVarMeta.GOOD_HOST.options']);
  }
  assert.deepEqual(paths({ options: [fr, 'es', null] }), [
    'env-meta-options envVarMeta.GOOD_HOST.options[1]',
    'env-meta-options envVarMeta.GOOD_HOST.options[2]',
  ]);
  assert.deepEqual(paths({ options: [fr, { value: '', label: 'Spain' }, { value: 7, label: 'Italy' }, { label: 'Poland' }] }), [
    'env-meta-options envVarMeta.GOOD_HOST.options[1].value',
    'env-meta-options envVarMeta.GOOD_HOST.options[2].value',
    'env-meta-options envVarMeta.GOOD_HOST.options[3].value',
  ]);
  assert.deepEqual(paths({ options: [fr, { value: 'https://es.example.test' }, { value: 'https://it.example.test', label: '  ' }] }), [
    'env-meta-options envVarMeta.GOOD_HOST.options[1].label',
    'env-meta-options envVarMeta.GOOD_HOST.options[2].label',
  ]);
  assert.deepEqual(paths({ options: [fr, es, { ...fr, label: 'Frankreich' }] }), ['env-meta-options envVarMeta.GOOD_HOST.options[2].value']);
  assert.deepEqual(paths({ options: [fr, { ...es, value: ' https://es.example.test' }] }), ['env-meta-options envVarMeta.GOOD_HOST.options[1].value']);
  assert.deepEqual(paths({ options: [fr, { ...es, hint: 'Iberia' }] }), ['env-meta-options envVarMeta.GOOD_HOST.options[1].hint']);

  // Every value must be one the variable's own pattern accepts.
  const offPattern = check({ pattern: '^https://', options: [fr, { value: 'es.example.test', label: 'Spain' }] });
  assert.deepEqual(offPattern.map((e) => `${e.rule} ${e.path}`), ['env-meta-options envVarMeta.GOOD_HOST.options[1].value']);
  assert.match(offPattern[0].message, /does not match the variable's own pattern/);
  // A broken pattern is reported once, by its own rule.
  assert.deepEqual(paths({ pattern: '(', options: [fr, es] }), ['env-meta-pattern envVarMeta.GOOD_HOST.pattern']);

  // The choices are shown and the chosen one is shown back: never a secret.
  const secret = check({ secret: true, options: [fr, es] });
  assert.deepEqual(secret.map((e) => `${e.rule} ${e.path}`), ['env-meta-options envVarMeta.GOOD_HOST.options']);
  assert.match(secret[0].message, /secret/);

  // Values are compared as stored: a variable the base URL starts with is
  // stored as a whole URL, the first label of a host in lower case.
  const rest = (baseUrl) => ({ connector: { type: 'REST', authType: 'API_KEY', baseUrl } });
  const bare = [{ value: 'fr.example.test', label: 'France' }, { value: 'es.example.test', label: 'Spain' }];
  assert.deepEqual(paths({ options: bare }, rest('{{GOOD_HOST}}/api')), [
    'env-meta-options envVarMeta.GOOD_HOST.options[0].value',
    'env-meta-options envVarMeta.GOOD_HOST.options[1].value',
  ]);
  assert.deepEqual(paths({ options: [fr, es] }, rest('{{GOOD_HOST}}/api')), []);
  assert.deepEqual(paths({ options: bare }, rest('https://{{GOOD_HOST}}/api')), []);
  const regions = [{ value: 'eu', label: 'Europe' }, { value: 'US', label: 'United States' }];
  assert.deepEqual(paths({ options: regions }, rest('https://{{GOOD_HOST}}.example.test/api')), ['env-meta-options envVarMeta.GOOD_HOST.options[1].value']);
  assert.deepEqual(paths({ options: regions }, rest('https://api-{{GOOD_HOST}}.example.test')), []);

  for (const e of [...offPattern, ...secret, ...check({ options: [fr] })]) {
    assert.ok(e.fix && e.fix.length > 20, 'every options error says how to fix it');
    assert.equal(e.docs, 'adapter-fields');
  }
});

test('connector.config.errorWhen rules are checked', () => {
  const good = validateAdapter(adapter({
    connector: { type: 'REST', authType: 'API_KEY', config: { errorWhen: [
      { path: 'Status', in: [1, 2], messagePath: 'Message', status: 401 },
      { path: 'result', matches: 'failed', messagePath: ['result', 'msg'] },
    ] } },
  }), 'good.json', 'de');
  assert.deepEqual(good.errors, []);

  const bad = validateAdapter(adapter({
    connector: { type: 'REST', authType: 'API_KEY', config: { errorWhen: [
      { equals: 1 }, { path: 'a', matches: '(' }, { path: 'a', status: 200 }, { path: 'a', typo: 1 },
    ] } },
  }), 'good.json', 'de');
  assert.deepEqual(bad.errors.map((e) => e.message), [
    'errorWhen[0].path must be a non-empty string',
    'errorWhen[1].matches is not a valid regular expression',
    'errorWhen[2].status must be an HTTP error status (400-599)',
    'errorWhen[3].typo is not a known field',
  ]);
  assert.ok(bad.errors.every((e) => e.rule === 'error-when' && e.docs === 'errors-inside-a-200-response'));
});

test('connector.config.mcpFixedArguments is an object on an MCP connector', () => {
  const check = (connector) => validateAdapter(adapter({ connector }), 'good.json', 'de').errors;
  const fixed = { meta: { 'ucp-agent': { profile: 'https://example.test/agent.json' } } };

  assert.deepEqual(check({ type: 'MCP', authType: 'NONE', config: { mcpToolPrefix: 'good_', mcpFixedArguments: fixed } }), []);
  // Absent: nothing to check, on any connector type.
  assert.deepEqual(check({ type: 'MCP', authType: 'NONE', config: { mcpToolPrefix: 'good_' } }), []);
  assert.deepEqual(check({ type: 'REST', authType: 'API_KEY', config: {} }), []);

  const onRest = check({ type: 'REST', authType: 'API_KEY', config: { mcpFixedArguments: fixed } });
  assert.deepEqual(onRest.map((e) => e.message), ['mcpFixedArguments only applies to connectors of type "MCP", not "REST"']);
  for (const value of ['meta', ['meta'], null, 7]) {
    const errors = check({ type: 'MCP', authType: 'NONE', config: { mcpFixedArguments: value } });
    assert.deepEqual(errors.map((e) => e.message), ['mcpFixedArguments must be an object of argument names and their values']);
    assert.ok(errors.every((e) => e.rule === 'mcp-fixed-arguments' && e.path === 'connector.config.mcpFixedArguments' && e.docs === 'mcp-adapters-a-vendors-own-mcp-server'));
  }
});

test('setupGuide asks for every required variable once, with https links and real screenshots', () => {
  const rules = (overrides) => validateAdapter(adapter(overrides), 'good.json', 'de').errors.map((e) => e.rule);
  const ok = {
    effort: 'api_key', minutes: 2, examples: ['List my orders'],
    steps: [{ id: 'key', title: 'Copy the key', action: { label: 'Open', url: 'https://example.test/keys' }, fields: ['GOOD_KEY'] }],
  };
  assert.deepEqual(rules({ setupGuide: ok }), []);

  assert.ok(rules({ setupGuide: { ...ok, steps: [{ id: 'intro', title: 'Intro' }] } }).includes('setup-guide-missing-field'));
  assert.ok(rules({ setupGuide: { ...ok, effort: 'easy' } }).includes('setup-guide-effort'));
  assert.ok(rules({ setupGuide: { ...ok, extra: 1 } }).includes('setup-guide-field'));
  assert.ok(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], action: { label: 'Open', url: 'http://example.test' } }] } }).includes('setup-guide-action'));
  assert.ok(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], fields: ['OTHER'] }] } }).includes('setup-guide-fields'));
  assert.ok(rules({ setupGuide: { ...ok, steps: [ok.steps[0], { id: 'again', title: 'Again', fields: ['GOOD_KEY'] }] } }).includes('setup-guide-fields'));
  assert.ok(rules({ setupGuide: { ...ok, steps: [ok.steps[0], { ...ok.steps[0], id: 'other' }] } }).includes('setup-guide-step-title'));
  assert.ok(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], values: [{ label: 'Key', value: '{{GOOD_KEY}}' }] }] } }).includes('setup-guide-values'));
  assert.deepEqual(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], values: [{ label: 'Callback', value: '{{redirectUri}}' }] }] } }), []);
  assert.ok(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], image: { src: '/no-such-shot.png', alt: 'x', capturedAt: '2026-10-22' } }] } }).includes('setup-guide-image'));
  // Protocol-relative: would load from another host.
  assert.ok(rules({ setupGuide: { ...ok, steps: [{ ...ok.steps[0], image: { src: '//evil.example/shot.png', alt: 'x', capturedAt: '2026-10-22' } }] } }).includes('setup-guide-image'));

  // An advanced required variable (a token the sign-in fills in) is not asked for.
  assert.deepEqual(rules({ requiredEnvVars: ['GOOD_KEY', 'GOOD_TOKEN'], envVarMeta: { GOOD_TOKEN: { advanced: true } }, setupGuide: ok }), []);
});

test('setupGuide links into the user instance only through an https address asked for earlier', () => {
  const base = {
    requiredEnvVars: ['SHOP_URL', 'GOOD_KEY'],
    envVarMeta: { SHOP_URL: { kind: 'address', pattern: '^https://[^\\s]+$' } },
  };
  const guide = (stepOrder) => ({ effort: 'api_key', minutes: 3, steps: stepOrder });
  const shop = { id: 'shop', title: 'Shop', fields: ['SHOP_URL'] };
  const key = { id: 'key', title: 'Key', action: { label: 'Open', url: '{{SHOP_URL}}/admin/keys' }, fields: ['GOOD_KEY'] };
  const rules = (o) => validateAdapter(adapter(o), 'good.json', 'de').errors.map((e) => e.rule);
  assert.deepEqual(rules({ ...base, setupGuide: guide([shop, key]) }), []);
  assert.ok(rules({ ...base, setupGuide: guide([{ ...key, fields: ['GOOD_KEY', 'SHOP_URL'] }]) }).includes('setup-guide-action'));
  assert.ok(rules({ ...base, envVarMeta: {}, setupGuide: guide([shop, key]) }).includes('setup-guide-action'));
});

test('setupGuide saves and checks the keys mid-way only when the provider can be asked, and waits right after', () => {
  const check = { connector: { type: 'REST', authType: 'OAUTH2' }, checkBeforeAuthorization: { path: '/ping', headers: { 'x-api-key': '{{GOOD_KEY}}' } } };
  const guide = (steps) => ({ effort: 'own_app', minutes: 10, steps });
  const keys = { id: 'keys', title: 'Keys', fields: ['GOOD_KEY'], saveAndCheck: true };
  const wait = { id: 'wait', title: 'Wait', waitForProvider: true };
  const last = { id: 'sign-in', title: 'Sign in' };
  const rules = (o) => validateAdapter(adapter(o), 'good.json', 'de').errors.map((e) => e.rule);
  assert.deepEqual(rules({ ...check, setupGuide: guide([keys, wait, last]) }), []);

  // Nothing to ask the provider with.
  assert.ok(rules({ setupGuide: guide([keys, wait, last]) }).includes('setup-guide-save-and-check'));
  // Nothing to save.
  assert.ok(rules({ ...check, setupGuide: guide([{ ...keys, fields: undefined }, { id: 'k2', title: 'K2', fields: ['GOOD_KEY'] }, last]) }).includes('setup-guide-save-and-check'));
  // The last step checks the keys anyway.
  assert.ok(rules({ ...check, setupGuide: guide([keys]) }).includes('setup-guide-save-and-check'));
  // A wait step needs keys saved right before it, nothing to enter, and a step after it.
  assert.ok(rules({ ...check, setupGuide: guide([keys, last, wait]) }).includes('setup-guide-wait'));
  assert.ok(rules({ ...check, setupGuide: guide([keys, { ...wait, confirm: 'Done' }, last]) }).includes('setup-guide-wait'));
  assert.ok(rules({ ...check, setupGuide: guide([{ ...keys, saveAndCheck: undefined }, wait, last]) }).includes('setup-guide-wait'));
});

test('docs explain the setup guide the validator links to', () => {
  assert.match(docs, /^### Setup guide$/m);
});
