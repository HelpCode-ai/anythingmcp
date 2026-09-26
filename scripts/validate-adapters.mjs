#!/usr/bin/env node
/**
 * Validates every adapter JSON under packages/backend/src/adapters/ against
 * the quality gate that protects the catalog from low-effort connectors.
 *
 * Exits with code 0 if all adapters pass, 1 if any fail.
 *
 * Hard gates (fail CI): required fields, filename/slug agreement, supported
 * connector and authentication types, a non-empty tools array, and GraphQL
 * tools whose variables the engine would drop (rule graphql-variables).
 *
 * Soft warnings (printed with --warn, but do not fail CI): short instructions,
 * unprefixed tool names, short tool descriptions, missing parameter
 * descriptions, and leftover TODO markers from the scaffolder.
 * Environment-reference checks are also informational because
 * some adapters document values supplied as tool parameters.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');
export const REGIONS = [
  'de', 'gb', 'intl', 'br', 'in', 'jp', 'ng',
  'it', 'es', 'fr', 'nl', 'be', 'ch', 'se', 'dk',
];
const ALLOWED_CONNECTOR_TYPES = new Set(['REST', 'GRAPHQL', 'SOAP', 'MCP', 'DATABASE', 'LOGIN_TOKEN']);
export const ALLOWED_AUTH_TYPES = new Set(['NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_AUTH', 'OAUTH2', 'OAUTH1', 'LOGIN_TOKEN', 'QUERY_AUTH', 'CONNECTION_STRING', 'HMAC']);
const REQUIRED_TOP_LEVEL = ['slug', 'name', 'description', 'region', 'category', 'icon', 'docsUrl', 'requiredEnvVars', 'connector', 'tools'];
const MIN_INSTRUCTIONS_LEN = 800;
const MIN_TOOL_DESCRIPTION_LEN = 60;

const error = (rule, path, message, fix, docs) => ({ rule, path, message, fix, docs });
const warning = (rule, path, message) => ({ rule, path, message });

export function collectAdapters(root = DEFAULT_ADAPTERS_DIR, stat = statSync) {
  return REGIONS.flatMap((region) => {
    const regionPath = join(root, region);
    let entries;
    try {
      entries = readdirSync(regionPath);
    } catch {
      return [];
    }
    return entries
      .filter((file) => file.endsWith('.json'))
      .map((file) => ({ region, file, fullPath: join(regionPath, file) }))
      .filter(({ fullPath }) => {
        try {
          return stat(fullPath).isFile();
        } catch {
          return true;
        }
      });
  });
}

/** Read and parse one adapter, keeping filesystem and syntax failures distinct. */
export function loadAdapter(file, readFile = readFileSync) {
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: error('json-read', '$', `unable to read adapter file — ${e.message}`, 'Check that the file path exists and that file permissions allow it to be read.', 'adapter-file-errors'),
      errors: [error('json-read', '$', `unable to read adapter file — ${e.message}`, 'Check that the file path exists and that file permissions allow it to be read.', 'adapter-file-errors')],
      warnings: [],
    };
  }
  try {
    return { ok: true, adapter: JSON.parse(raw), errors: [], warnings: [] };
  } catch (e) {
    const parseError = error('json-parse', '$', `invalid JSON — ${e.message}`, 'Fix the JSON syntax and validate it before running the catalog gate.', 'adapter-file-errors');
    return {
      ok: false,
      error: parseError,
      errors: [parseError],
      warnings: [],
    };
  }
}

export function adapterResult(loaded, file, region) {
  if (!loaded.ok) return { region, file, errors: [loaded.error], warnings: loaded.warnings };
  if (!loaded.adapter || typeof loaded.adapter !== 'object' || Array.isArray(loaded.adapter)) {
    return {
      region, file,
      errors: [error('adapter-envelope', '$', 'adapter JSON must be a JSON object', 'Wrap the adapter definition in a JSON object with the required fields.', 'adapter-envelope')],
      warnings: [],
    };
  }
  return { region, file, ...validateAdapter(loaded.adapter, file, region) };
}

// `{{VAR}}` is resolved into auth/base URL/headers; `${VAR}` inside a tool's
// mapping reads the same connector variable at call time (and leaves an
// endpoint header out when it is empty, which is how an optional key works).
function isPlaceholderReferenced(envVar, adapter) {
  const json = JSON.stringify(adapter);
  return json.includes(`{{${envVar}}}`) || json.includes(`\${${envVar}}`);
}

// Leftover marker from `scripts/adapter-new.mjs`. Case-sensitive on purpose:
// real adapters mention "to-do" lists, and only the uppercase word is ours.
const TODO_MARKER = /\bTODO\b/;

/** Walk every string in the adapter and warn where a TODO marker is left. */
function collectTodoMarkers(value, path, warnings) {
  if (typeof value === 'string') {
    if (TODO_MARKER.test(value)) warnings.push(warning('todo-marker', path, `leftover TODO marker at ${path} — finish or remove it before submitting`));
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectTodoMarkers(item, `${path}[${i}]`, warnings));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectTodoMarkers(item, path === '$' ? key : `${path}.${key}`, warnings);
  }
}

const GRAPHQL_OPERATION_METHODS = new Set(['query', 'mutation', 'subscription']);

/**
 * The variable definitions of a GraphQL operation, e.g. for
 * `query Q($id: ID!, $first: Int = 20) { … }` →
 * [{ name: 'id', required: true }, { name: 'first', required: false }].
 * Returns [] for an anonymous `{ … }` document. Deliberately dependency-free:
 * a variable definition is `$name: Type [= default] [@directive]`, and a
 * default value cannot contain a `$`, so splitting on `$` is exact enough.
 */
export function graphqlVariableDefinitions(document) {
  const head = /^\s*(?:query|mutation|subscription)\b\s*[A-Za-z_]?\w*\s*\(/.exec(document);
  if (!head) return [];
  let depth = 1;
  let end = head[0].length;
  while (end < document.length && depth > 0) {
    if (document[end] === '(') depth++;
    else if (document[end] === ')') depth--;
    end++;
  }
  return document
    .slice(head[0].length, end - 1)
    .split('$')
    .slice(1)
    .map((def) => {
      const m = /^([A-Za-z_]\w*)\s*:\s*([^=@]*?)\s*(=|@|,|$)/.exec(def.trim());
      if (!m) return null;
      return { name: m[1], required: m[2].trim().endsWith('!') && m[3] !== '=' };
    })
    .filter(Boolean);
}

/** True when a `$param` reference is nested somewhere inside an object or array. */
function hasNestedParamRef(value) {
  if (typeof value === 'string') return /^\$[A-Za-z_]/.test(value);
  if (Array.isArray(value)) return value.some(hasNestedParamRef);
  if (value && typeof value === 'object') return Object.values(value).some(hasNestedParamRef);
  return false;
}

/**
 * The GraphQL engine (packages/backend/src/connectors/engines/graphql.engine.ts)
 * builds `variables` from exactly two places: `endpointMapping.queryParams`, one
 * flat entry per variable whose value is `"$param"` or a literal, or the whole
 * map from the tool param named by `variablesFromParam`. Anything else is
 * silently dropped — Buffer, Slab, Tidio and Wave put theirs under
 * `bodyMapping.variables` and every call went out with `"variables":{}`.
 */
function graphqlVariableErrors(adapter, tool, base) {
  const errors = [];
  const em = tool.endpointMapping;
  if (!em || typeof em !== 'object' || !GRAPHQL_OPERATION_METHODS.has(em.method)) return errors;
  const at = `${base}.endpointMapping`;
  const docs = 'graphql-variables';
  const rule = 'graphql-variables';

  if (em.bodyMapping !== undefined) {
    errors.push(error(rule, `${at}.bodyMapping`, `tool "${tool.name}" sets bodyMapping, which the GraphQL engine never reads — its variables are sent as {}`, 'Move each variable to endpointMapping.queryParams as "<variableName>": "$<toolParam>" (inline input objects in the operation instead of passing an $input object).', docs));
  }
  const queryParams = em.queryParams && typeof em.queryParams === 'object' ? em.queryParams : {};
  const params = tool.parameters?.properties && typeof tool.parameters.properties === 'object' ? tool.parameters.properties : {};
  const envVars = new Set([...(adapter.requiredEnvVars || []), ...(Array.isArray(adapter.optionalEnvVars) ? adapter.optionalEnvVars : [])]);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value && typeof value === 'object' && hasNestedParamRef(value)) {
      errors.push(error(rule, `${at}.queryParams.${key}`, `tool "${tool.name}" nests $param references inside queryParams.${key}; the engine resolves only top-level "$param" values and would send the text "$…" literally`, `Declare one variable per parameter and build the input object inside the operation, e.g. input: { id: $id }.`, docs));
    } else if (typeof value === 'string' && /^\$[A-Za-z_]\w*$/.test(value)) {
      const name = value.slice(1);
      if (!(name in params) && !envVars.has(name)) {
        errors.push(error(rule, `${at}.queryParams.${key}`, `tool "${tool.name}" maps variable "${key}" from "${value}", which is neither a tool parameter nor an env var — it is always sent empty`, `Add "${name}" to the tool's parameters, or fix the reference.`, docs));
      }
    }
  }

  // A generic tool that takes the whole operation as input declares nothing up front.
  if (typeof em.path !== 'string' || /^\$[A-Za-z_]\w*$/.test(em.path) || em.variablesFromParam) return errors;
  const declared = graphqlVariableDefinitions(em.path);
  const declaredNames = new Set(declared.map((d) => d.name));
  for (const key of Object.keys(queryParams)) {
    if (!declaredNames.has(key)) {
      errors.push(error(rule, `${at}.queryParams.${key}`, `tool "${tool.name}" sends variable "${key}", which the operation does not declare — the server ignores it`, `Declare $${key} in the operation, or rename the queryParams key to the variable it is meant for.`, docs));
    }
  }
  for (const def of declared) {
    if (def.required && !(def.name in queryParams)) {
      errors.push(error(rule, `${at}.path`, `tool "${tool.name}" declares required variable $${def.name} but queryParams never supplies it — every call fails`, `Add "${def.name}": "$<toolParam>" to endpointMapping.queryParams.`, docs));
    }
  }
  return errors;
}

export function validateAdapter(adapter, file, region) {
  const errors = [];
  const warnings = [];
  const expectedSlug = file.replace(/\.json$/, '');

  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { errors: [error('adapter-envelope', '$', 'adapter JSON must be a JSON object', 'Wrap the adapter definition in a JSON object with the required fields.', 'adapter-envelope')], warnings };
  }

  // Required envelope fields must exist before nested validation can proceed.
  for (const key of REQUIRED_TOP_LEVEL) {
    if (adapter[key] === undefined || adapter[key] === null) {
      errors.push(error('required-field', key, `missing required field: ${key}`, `Add the ${key} field to the adapter object.`, 'adapter-fields'));
    }
  }
  if (errors.length) return { errors, warnings };

  if (adapter.slug !== expectedSlug) errors.push(error('slug', 'slug', `"${adapter.slug}" does not match filename "${expectedSlug}"`, `Rename slug to "${expectedSlug}" (or rename the file).`, 'adapter-fields'));
  // A directory can be broader than the declared adapter region, so this is informational.
  if (adapter.region !== region) warnings.push(warning('region-mismatch', 'region', `region "${adapter.region}" does not match directory "${region}"`));
  if (!ALLOWED_CONNECTOR_TYPES.has(adapter.connector?.type)) errors.push(error('connector-type', 'connector.type', `connector.type "${adapter.connector?.type}" is not supported`, `Set connector.type to one of: ${[...ALLOWED_CONNECTOR_TYPES].join(', ')}.`, 'connector'));
  if (!ALLOWED_AUTH_TYPES.has(adapter.connector?.authType)) errors.push(error('auth-type', 'connector.authType', `connector.authType "${adapter.connector?.authType}" is not supported`, 'Set connector.authType to one of the documented authentication types.', 'authentication'));

  for (const [i, envVar] of (adapter.requiredEnvVars || []).entries()) {
    if (!isPlaceholderReferenced(envVar, adapter)) warnings.push(warning('required-env-reference', `requiredEnvVars[${i}]`, `requiredEnvVars contains "${envVar}" but it's not auto-injected via {{${envVar}}} (operator must set it for documentation, agent passes it as a tool param)`));
  }
  if (adapter.optionalEnvVars !== undefined) {
    if (!Array.isArray(adapter.optionalEnvVars) || adapter.optionalEnvVars.some((v) => typeof v !== 'string')) {
      errors.push(error('optional-env-shape', 'optionalEnvVars', 'optionalEnvVars must be an array of strings', 'Use an array containing only environment-variable name strings.', 'adapter-fields'));
    } else {
      for (const [i, envVar] of adapter.optionalEnvVars.entries()) {
        if ((adapter.requiredEnvVars || []).includes(envVar)) errors.push(error('optional-env-overlap', `optionalEnvVars[${i}]`, `"${envVar}" appears in both requiredEnvVars and optionalEnvVars`, 'Keep the variable in exactly one of requiredEnvVars or optionalEnvVars.', 'adapter-fields'));
        if (!isPlaceholderReferenced(envVar, adapter)) warnings.push(warning('optional-env-reference', `optionalEnvVars[${i}]`, `optionalEnvVars contains "${envVar}" but it is not referenced via {{${envVar}}}`));
      }
    }
  }

  if (adapter.envVarAliases !== undefined) {
    const aliases = adapter.envVarAliases;
    const declared = [...(adapter.requiredEnvVars || []), ...(Array.isArray(adapter.optionalEnvVars) ? adapter.optionalEnvVars : [])];
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.values(aliases).some((v) => !Array.isArray(v) || v.some((n) => typeof n !== 'string'))) {
      errors.push(error('env-alias-shape', 'envVarAliases', 'envVarAliases must map a variable name to an array of its previous names', 'Use { "CURRENT_NAME": ["OLD_NAME"] }.', 'adapter-fields'));
    } else {
      for (const [envVar, previous] of Object.entries(aliases)) {
        if (!declared.includes(envVar)) errors.push(error('env-alias-unknown', `envVarAliases.${envVar}`, `envVarAliases names "${envVar}", which is not in requiredEnvVars or optionalEnvVars`, 'Key the alias by the current variable name.', 'adapter-fields'));
        for (const old of previous) {
          if (declared.includes(old)) errors.push(error('env-alias-current', `envVarAliases.${envVar}`, `"${old}" is a current variable and cannot also be a previous name`, 'List only names the adapter no longer uses.', 'adapter-fields'));
        }
      }
    }
  }

  const slugUnderscored = adapter.slug.replace(/-/g, '_');
  if (!Array.isArray(adapter.tools) || adapter.tools.length === 0) {
    errors.push(error('tools', 'tools', 'tools array is empty', 'Add at least one tool definition to the tools array.', 'tools'));
    return { errors, warnings };
  }
  if (!adapter.instructions || adapter.instructions.length < MIN_INSTRUCTIONS_LEN) warnings.push(warning('instructions', 'instructions', `instructions field is ${adapter.instructions?.length || 0} chars (recommend ≥ ${MIN_INSTRUCTIONS_LEN})`));
  for (const [i, tool] of adapter.tools.entries()) {
    const base = `tools[${i}]`;
    if (!tool || typeof tool !== 'object' || Array.isArray(tool) || !tool.name || typeof tool.name !== 'string') {
      errors.push(error('tool-name', `${base}.name`, 'tool has no name', 'Give the tool a string name using the adapter slug prefix.', 'tools'));
      continue;
    }
    if (!tool.name.startsWith(`${slugUnderscored}_`)) warnings.push(warning('tool-prefix', `${base}.name`, `tool "${tool.name}" not prefixed with "${slugUnderscored}_"`));
    if (!tool.description || tool.description.length < MIN_TOOL_DESCRIPTION_LEN) warnings.push(warning('tool-description', `${base}.description`, `tool "${tool.name}" description is ${tool.description?.length || 0} chars (recommend ≥ ${MIN_TOOL_DESCRIPTION_LEN})`));
    const props = tool.parameters?.properties;
    if (props && typeof props === 'object') {
      for (const [pname, pdef] of Object.entries(props)) {
        if (!pdef || typeof pdef !== 'object' || !pdef.description) warnings.push(warning('parameter-description', `${base}.parameters.properties.${pname}`, `tool "${tool.name}" parameter "${pname}" missing description`));
      }
    }
    if (adapter.connector?.type === 'GRAPHQL') errors.push(...graphqlVariableErrors(adapter, tool, base));
  }
  // Last, so existing warnings keep their order.
  collectTodoMarkers(adapter, '$', warnings);
  return { errors, warnings };
}

function detail(region, file, item) {
  const suffix = item.fix ? ` Fix: ${item.fix} See docs/tool-definition.md#${item.docs}.` : '';
  return `${region}/${file} [${item.rule}] path: ${item.path} — ${item.message}${suffix}`;
}

export function warningSummary(counts) {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, count]) => `  - ${rule}: ${count}`)
    .join('\n');
}

export function renderReport(results, showWarnings) {
  const details = [];
  const summary = [];
  const counts = {};
  let passed = 0;
  let failed = 0;
  let totalWarnings = 0;

  for (const result of results) {
    const { region, file, errors, warnings } = result;
    warnings.forEach((item) => { counts[item.rule] = (counts[item.rule] || 0) + 1; });
    totalWarnings += warnings.length;
    if (!errors.length) {
      passed++;
      if (showWarnings) warnings.forEach((item) => details.push(`⚠ ${detail(region, file, item)}`));
    } else {
      failed++;
      details.push(`✗ ${region}/${file}:`);
      errors.forEach((item) => details.push(`    - ${detail(region, file, item)}`));
      if (showWarnings) warnings.forEach((item) => details.push(`    - ⚠ ${detail(region, file, item)}`));
    }
  }

  summary.push(`Validated ${results.length} adapters: ${passed} passed, ${failed} failed${showWarnings ? `, ${totalWarnings} total warnings` : ''}.`);
  if (totalWarnings) summary.push(`Warnings by rule:\n${warningSummary(counts)}`);
  if (!showWarnings && totalWarnings) summary.push(`(${totalWarnings} non-blocking warnings hidden — re-run with --warn to see them)`);
  return { stdout: `${summary.join('\n')}\n`, stderr: details.length ? `${details.join('\n')}\n` : '', passed, failed, totalWarnings };
}

export function main() {
  const adapters = collectAdapters();
  if (!adapters.length) {
    console.error('No adapters found.');
    return 1;
  }
  const results = adapters.map(({ region, file, fullPath }) => {
    const loaded = loadAdapter(fullPath);
    return adapterResult(loaded, file, region);
  });
  const report = renderReport(results, process.argv.includes('--warn'));
  process.stdout.write(report.stdout);
  process.stderr.write(report.stderr);
  return report.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
