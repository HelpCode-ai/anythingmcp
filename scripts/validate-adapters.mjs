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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');
export const REGIONS = [
  'de', 'gb', 'intl', 'br', 'in', 'jp', 'ng',
  'it', 'es', 'fr', 'nl', 'be', 'ch', 'se', 'dk',
  'no', 'fi', 'cz', 'pl', 'ro', 'eg',
];
const ALLOWED_CONNECTOR_TYPES = new Set(['REST', 'GRAPHQL', 'SOAP', 'MCP', 'DATABASE', 'ODATA', 'EMAIL', 'LOGIN_TOKEN', 'FILE_SEARCH']);
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

/** The variables the user enters: required and optional. */
function declaredVars(adapter) {
  return [...(adapter.requiredEnvVars || []), ...(Array.isArray(adapter.optionalEnvVars) ? adapter.optionalEnvVars : [])];
}

// `{{VAR}}` is resolved into auth/base URL/headers; `${VAR}` inside a tool's
// mapping reads the same connector variable at call time (and leaves an
// endpoint header out when it is empty, which is how an optional key works).
function isPlaceholderReferenced(envVar, adapter) {
  const json = JSON.stringify(adapter);
  if (json.includes(`{{${envVar}}}`) || json.includes(`\${${envVar}}`)) return true;
  // A bearer-token renewal names its optional variables instead of using
  // placeholders (see bearer-token-renewal.service.ts); configIdVar is the
  // Meta Unified Login configuration the sign-in reads (meta-login.util.ts).
  const renewal = adapter.connector?.authConfig?.tokenRenewal;
  return !!renewal && [renewal.appIdVar, renewal.appSecretVar, renewal.pageIdVar, renewal.configIdVar].includes(envVar);
}

/**
 * LOGIN_TOKEN logins that take HTTP Basic credentials (Wazuh) set
 * loginBasicAuth: true. LoginTokenService builds the header itself and refuses
 * the same combinations, so a bad adapter fails here instead of at sign-in.
 */
export function loginBasicAuthProblems(connector) {
  const cfg = connector?.authConfig;
  if (!cfg || typeof cfg !== 'object' || cfg.loginBasicAuth === undefined) return [];
  if (connector.authType !== 'LOGIN_TOKEN') return ['loginBasicAuth only applies to LOGIN_TOKEN authentication'];
  if (typeof cfg.loginBasicAuth !== 'boolean') return ['loginBasicAuth must be true or false'];
  if (!cfg.loginBasicAuth) return [];
  const problems = [];
  for (const field of ['username', 'password']) {
    if (typeof cfg[field] !== 'string' || !cfg[field].trim()) problems.push(`loginBasicAuth needs authConfig.${field}`);
  }
  if (cfg.signedJwt !== undefined) problems.push('loginBasicAuth cannot be combined with signedJwt');
  if (cfg.passwordHashing && cfg.passwordHashing.scheme !== 'none') problems.push('loginBasicAuth sends the password as is and cannot be combined with passwordHashing');
  const headers = cfg.loginHeaders && typeof cfg.loginHeaders === 'object' ? Object.keys(cfg.loginHeaders) : [];
  if (headers.some((h) => h.toLowerCase() === 'authorization')) problems.push('loginBasicAuth sets the login Authorization header itself; remove Authorization from loginHeaders');
  const outputParam = cfg.passwordHashing?.outputParam || 'passwordHashed';
  const body = JSON.stringify([cfg.loginBody ?? null, cfg.loginBodyTemplate ?? null, cfg.loginHeaders ?? null]);
  for (const name of new Set(['password', 'passwordHashed', outputParam])) {
    if (body.includes(`${'$'}{${name}}`)) problems.push(`loginBasicAuth sends the password in the header only; remove ${'$'}{${name}} from the login body and headers`);
  }
  return problems;
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

/**
 * Problems with `connector.config.errorWhen`, the rules that turn an error
 * reported inside a 2xx body into a failed call. Mirrors
 * describeErrorWhenProblems in packages/backend/src/connectors/engines/response-error.util.ts.
 */
export function errorWhenProblems(value) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const known = new Set(['path', 'equals', 'in', 'matches', 'messagePath', 'messageMatches', 'status']);
  const problems = [];
  list.forEach((rule, i) => {
    const at = Array.isArray(value) ? `errorWhen[${i}]` : 'errorWhen';
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { problems.push(`${at} must be an object`); return; }
    if (typeof rule.path !== 'string' || !rule.path) problems.push(`${at}.path must be a non-empty string`);
    if (rule.in !== undefined && !Array.isArray(rule.in)) problems.push(`${at}.in must be an array`);
    for (const key of ['matches', 'messageMatches']) {
      if (rule[key] === undefined) continue;
      try { new RegExp(String(rule[key]), 'i'); } catch { problems.push(`${at}.${key} is not a valid regular expression`); }
    }
    if (rule.status !== undefined && !(Number.isInteger(rule.status) && rule.status >= 400 && rule.status <= 599)) {
      problems.push(`${at}.status must be an HTTP error status (400-599)`);
    }
    for (const key of Object.keys(rule)) if (!known.has(key)) problems.push(`${at}.${key} is not a known field`);
  });
  return problems;
}

const SETUP_EFFORTS = new Set(['none', 'one_click', 'api_key', 'own_app', 'admin_needed']);
const GUIDE_FIELDS = new Set(['effort', 'minutes', 'examples', 'needs', 'why', 'steps']);
const STEP_FIELDS = new Set(['id', 'title', 'body', 'action', 'values', 'image', 'fields', 'problems', 'confirm', 'saveAndCheck', 'waitForProvider']);
const FRONTEND_PUBLIC = join(REPO_ROOT, 'packages/frontend/public');
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * The step-by-step setup (setup-guide.ts). Every variable the user must enter
 * is asked for in exactly one step, links open the provider over https, and a
 * screenshot is a real file: the guide is the only setup the page shows, so a
 * gap in it is a setup nobody can finish.
 */
export function validateSetupGuide(adapter, publicDir = FRONTEND_PUBLIC) {
  const errors = [];
  const g = adapter.setupGuide;
  const bad = (rule, path, message, fix) => errors.push(error(rule, path, message, fix, 'setup-guide'));
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    bad('setup-guide-shape', 'setupGuide', 'setupGuide must be an object', 'Use { "effort": "api_key", "minutes": 2, "steps": [...] }.');
    return errors;
  }
  for (const k of Object.keys(g)) if (!GUIDE_FIELDS.has(k)) bad('setup-guide-field', `setupGuide.${k}`, `Unknown setupGuide field "${k}"`, `Use one of: ${[...GUIDE_FIELDS].join(', ')}.`);
  if (!SETUP_EFFORTS.has(g.effort)) bad('setup-guide-effort', 'setupGuide.effort', `effort must be one of ${[...SETUP_EFFORTS].join(', ')}`, 'Pick what the setup asks of the user.');
  if (!Number.isInteger(g.minutes) || g.minutes < 1 || g.minutes > 120) bad('setup-guide-minutes', 'setupGuide.minutes', 'minutes must be a whole number from 1 to 120', 'Say about how long the setup takes.');
  for (const key of ['examples', 'needs']) {
    if (g[key] !== undefined && (!Array.isArray(g[key]) || g[key].length === 0 || !g[key].every(nonEmpty))) {
      bad('setup-guide-list', `setupGuide.${key}`, `${key} must be a non-empty array of strings`, 'List short lines, or remove the field.');
    }
  }
  if (g.why !== undefined && !nonEmpty(g.why)) bad('setup-guide-why', 'setupGuide.why', 'why must be a non-empty string', 'Explain in a few sentences, or remove the field.');
  if (!Array.isArray(g.steps) || g.steps.length === 0) {
    bad('setup-guide-steps', 'setupGuide.steps', 'steps must be a non-empty array', 'Add at least one step.');
    return errors;
  }

  const declared = [...(adapter.requiredEnvVars || []), ...(Array.isArray(adapter.optionalEnvVars) ? adapter.optionalEnvVars : [])];
  const asked = new Map();
  const ids = new Set();
  const titles = new Set();
  g.steps.forEach((step, i) => {
    const at = `setupGuide.steps[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) { bad('setup-guide-step', at, 'Each step must be an object', 'Use { "id": "…", "title": "…" }.'); return; }
    for (const k of Object.keys(step)) if (!STEP_FIELDS.has(k)) bad('setup-guide-field', `${at}.${k}`, `Unknown step field "${k}"`, `Use one of: ${[...STEP_FIELDS].join(', ')}.`);
    if (typeof step.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(step.id)) bad('setup-guide-step-id', `${at}.id`, 'id must be kebab-case', 'Use a short id like "create-app".');
    else if (ids.has(step.id)) bad('setup-guide-step-id', `${at}.id`, `id "${step.id}" is used twice`, 'Give every step its own id.');
    else ids.add(step.id);
    if (!nonEmpty(step.title)) bad('setup-guide-step-title', `${at}.title`, 'title must be a non-empty string', 'Say what the step does.');
    else if (titles.has(step.title.trim().toLowerCase())) bad('setup-guide-step-title', `${at}.title`, `title "${step.title}" is used twice`, 'Give every step its own title.');
    else titles.add(step.title.trim().toLowerCase());
    if (step.body !== undefined && !nonEmpty(step.body)) bad('setup-guide-step-body', `${at}.body`, 'body must be a non-empty string', 'Write the step, or remove the field.');
    if (step.action !== undefined) {
      // A link into the user's own instance starts with a variable asked for
      // in an earlier step whose pattern makes it an https address.
      const url = String(step.action?.url ?? '');
      const lead = /^\{\{([A-Z0-9_]+)\}\}\/\S*$/.exec(url);
      const leadOk = lead && asked.has(lead[1]) && /^\^https:/.test(String(adapter.envVarMeta?.[lead[1]]?.pattern ?? ''));
      if (!step.action || !nonEmpty(step.action.label) || !(/^https:\/\/\S+$/.test(url) || leadOk) || /\{\{/.test(url.replace(/^\{\{[A-Z0-9_]+\}\}/, ''))) {
        bad('setup-guide-action', `${at}.action`, 'action needs a label and an https url (or one starting with an https address asked for in an earlier step)', 'Link the provider page this step happens on.');
      }
    }
    if (step.values !== undefined) {
      if (!Array.isArray(step.values) || step.values.length === 0) bad('setup-guide-values', `${at}.values`, 'values must be a non-empty array', 'List what to enter on the provider page, or remove the field.');
      else step.values.forEach((v, j) => {
        if (!v || !nonEmpty(v.label) || !nonEmpty(v.value)) bad('setup-guide-values', `${at}.values[${j}]`, 'Each value needs a label and a value', 'Use { "label": "Name", "value": "AnythingMCP" }.');
        else if (/\{\{(?!redirectUri\}\})/.test(v.value)) bad('setup-guide-values', `${at}.values[${j}].value`, 'Only {{redirectUri}} can be filled in', 'Write the value out.');
      });
    }
    if (step.image !== undefined) {
      const img = step.image;
      // Only a file under packages/frontend/public: `//host/x.png` would load
      // from another site.
      if (!img || typeof img.src !== 'string' || !/^\/(?!\/)[\w./-]+$/.test(img.src) || img.src.includes('..') || !nonEmpty(img.alt) || !/^\d{4}-\d{2}-\d{2}$/.test(String(img.capturedAt))) {
        bad('setup-guide-image', `${at}.image`, 'image needs a src under /, an alt text and capturedAt (YYYY-MM-DD)', 'Use { "src": "/setup-guides/etsy/app-form.png", "alt": "…", "capturedAt": "2026-10-22" }.');
      } else if (!existsSync(join(publicDir, img.src))) {
        bad('setup-guide-image', `${at}.image.src`, `${img.src} is not in packages/frontend/public`, 'Add the screenshot, or remove the image.');
      }
    }
    if (step.fields !== undefined) {
      if (!Array.isArray(step.fields) || step.fields.length === 0) bad('setup-guide-fields', `${at}.fields`, 'fields must be a non-empty array of variable names', 'List the variables entered in this step, or remove the field.');
      else for (const f of step.fields) {
        if (!declared.includes(f)) bad('setup-guide-fields', `${at}.fields`, `"${f}" is not in requiredEnvVars or optionalEnvVars`, 'Ask only for variables the adapter declares.');
        else if (asked.has(f)) bad('setup-guide-fields', `${at}.fields`, `"${f}" is already asked for in step ${asked.get(f) + 1}`, 'Ask for each variable in one step.');
        else asked.set(f, i);
      }
    }
    if (step.problems !== undefined && (!Array.isArray(step.problems) || step.problems.length === 0 || step.problems.some((p) => !p || !nonEmpty(p.q) || !nonEmpty(p.a)))) {
      bad('setup-guide-problems', `${at}.problems`, 'problems must be a non-empty array of { q, a }', 'Write the question and its answer, or remove the field.');
    }
    if (step.confirm !== undefined && !nonEmpty(step.confirm)) bad('setup-guide-confirm', `${at}.confirm`, 'confirm must be a non-empty string', 'Say what the user confirms, or remove the field.');
    // Saving the keys mid-guide only helps when the provider can be asked
    // about them; the wait step needs keys saved by the step before it.
    if (step.saveAndCheck !== undefined) {
      if (step.saveAndCheck !== true) bad('setup-guide-save-and-check', `${at}.saveAndCheck`, 'saveAndCheck must be true', 'Remove the field, or set it to true.');
      else if (!Array.isArray(step.fields) || step.fields.length === 0) bad('setup-guide-save-and-check', `${at}.saveAndCheck`, 'A saveAndCheck step needs fields', 'Ask for the keys in this step.');
      else if (!adapter.checkBeforeAuthorization) bad('setup-guide-save-and-check', `${at}.saveAndCheck`, 'saveAndCheck needs the adapter to have checkBeforeAuthorization', 'Add checkBeforeAuthorization, or remove saveAndCheck.');
      else if (i === g.steps.length - 1) bad('setup-guide-save-and-check', `${at}.saveAndCheck`, 'The last step already checks the keys', 'Remove saveAndCheck from the last step.');
    }
    if (step.waitForProvider !== undefined) {
      if (step.waitForProvider !== true) bad('setup-guide-wait', `${at}.waitForProvider`, 'waitForProvider must be true', 'Remove the field, or set it to true.');
      else if (g.steps[i - 1]?.saveAndCheck !== true) bad('setup-guide-wait', `${at}.waitForProvider`, 'A waitForProvider step must follow a saveAndCheck step', 'Put it right after the step that saves the keys.');
      else if (step.fields !== undefined || step.confirm !== undefined) bad('setup-guide-wait', `${at}.waitForProvider`, 'A waitForProvider step cannot have fields or confirm', 'It moves on by itself once the provider accepts the keys.');
      else if (i === g.steps.length - 1) bad('setup-guide-wait', `${at}.waitForProvider`, 'A waitForProvider step cannot be the last step', 'Add the step that follows the approval.');
    }
  });
  // A required variable the guide never asks for blocks the last step.
  // Advanced ones (a token the sign-in fills in) stay out of the steps.
  const meta = adapter.envVarMeta && typeof adapter.envVarMeta === 'object' ? adapter.envVarMeta : {};
  for (const v of adapter.requiredEnvVars || []) {
    if (!asked.has(v) && !meta[v]?.advanced) bad('setup-guide-missing-field', 'setupGuide.steps', `The required variable "${v}" is not asked for in any step`, `Add "${v}" to the fields of the step where the user finds it.`);
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

  if (adapter.envVarMeta !== undefined) {
    const meta = adapter.envVarMeta;
    const declared = [...(adapter.requiredEnvVars || []), ...(Array.isArray(adapter.optionalEnvVars) ? adapter.optionalEnvVars : [])];
    const KINDS = new Set(['address', 'credential', 'setting']);
    const FIELDS = new Set(['label', 'kind', 'secret', 'help', 'example', 'pattern', 'patternMessage', 'link', 'advanced']);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      errors.push(error('env-meta-shape', 'envVarMeta', 'envVarMeta must map a variable name to its description', 'Use { "MY_VAR": { "label": "…", "help": "…" } }.', 'adapter-fields'));
    } else {
      for (const [envVar, m] of Object.entries(meta)) {
        const path = `envVarMeta.${envVar}`;
        if (!declared.includes(envVar)) errors.push(error('env-meta-unknown', path, `envVarMeta describes "${envVar}", which is not in requiredEnvVars or optionalEnvVars`, 'Describe only variables the adapter declares.', 'adapter-fields'));
        if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push(error('env-meta-shape', path, 'Each envVarMeta entry must be an object', 'Use { "label": "…" }.', 'adapter-fields')); continue; }
        for (const k of Object.keys(m)) if (!FIELDS.has(k)) errors.push(error('env-meta-field', `${path}.${k}`, `Unknown envVarMeta field "${k}"`, `Use one of: ${[...FIELDS].join(', ')}.`, 'adapter-fields'));
        if (m.kind !== undefined && !KINDS.has(m.kind)) errors.push(error('env-meta-kind', `${path}.kind`, `kind must be address, credential or setting, not "${m.kind}"`, 'Pick the kind that matches what the value is.', 'adapter-fields'));
        if (m.pattern !== undefined) { try { new RegExp(m.pattern); } catch { errors.push(error('env-meta-pattern', `${path}.pattern`, 'pattern is not a valid regular expression', 'Fix or remove the pattern.', 'adapter-fields')); } }
        if (m.link !== undefined && !/^https:\/\//.test(String(m.link))) errors.push(error('env-meta-link', `${path}.link`, 'link must be an https URL', 'Use the provider page where the value is created.', 'adapter-fields'));
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

  if (adapter.prerequisites !== undefined && (typeof adapter.prerequisites !== 'string' || !adapter.prerequisites.trim())) {
    errors.push(error('prerequisites', 'prerequisites', 'prerequisites must be a non-empty string', 'Say in a sentence or two what the user needs before starting, or remove the field.', 'adapter-fields'));
  }
  if (adapter.appRegistrationUrl !== undefined && !/^https:\/\/\S+$/.test(String(adapter.appRegistrationUrl))) {
    errors.push(error('app-registration-url', 'appRegistrationUrl', 'appRegistrationUrl must be an https URL', 'Link the provider page where the user creates the app, or remove the field.', 'adapter-fields'));
  }
  if (adapter.requiresIpAllowlist !== undefined && typeof adapter.requiresIpAllowlist !== 'boolean') {
    errors.push(error('requires-ip-allowlist', 'requiresIpAllowlist', 'requiresIpAllowlist must be true or false', 'Set it to true when the provider refuses calls from unregistered IP addresses, or remove the field.', 'adapter-fields'));
  }
  if (adapter.setupGuide !== undefined) errors.push(...validateSetupGuide(adapter));
  if (adapter.previousOAuthScopes !== undefined && (!Array.isArray(adapter.previousOAuthScopes) || adapter.previousOAuthScopes.some((v) => typeof v !== 'string' || !v.trim()))) {
    errors.push(error('previous-oauth-scopes', 'previousOAuthScopes', 'previousOAuthScopes must be an array of scope strings', 'List the scope strings earlier versions of this adapter asked for.', 'adapter-fields'));
  }
  if (adapter.aliases !== undefined) {
    // Other names the catalog search matches (a former name, a translation, a
    // short form). Matched like the name, so each must be a short name.
    if (!Array.isArray(adapter.aliases) || adapter.aliases.some((v) => typeof v !== 'string' || !v.trim() || v.trim().length > 40)) {
      errors.push(error('aliases-shape', 'aliases', 'aliases must be an array of names of up to 40 characters', 'List other names people search the app by, e.g. ["lexoffice"], or remove the field.', 'adapter-fields'));
    } else {
      const seen = new Set();
      const own = new Set([adapter.slug, adapter.name].map((v) => String(v).toLowerCase()));
      for (const [i, alias] of adapter.aliases.entries()) {
        const key = alias.trim().toLowerCase();
        if (seen.has(key)) errors.push(error('aliases-duplicate', `aliases[${i}]`, `alias "${alias}" is listed twice`, 'Keep each alias once.', 'adapter-fields'));
        else if (own.has(key)) warnings.push(warning('aliases-redundant', `aliases[${i}]`, `alias "${alias}" repeats the slug or name, which the search matches anyway`));
        seen.add(key);
      }
    }
  }
  if (adapter.verifyHints !== undefined) {
    const hints = adapter.verifyHints;
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
      errors.push(error('verify-hints-shape', 'verifyHints', 'verifyHints must map a status or failure kind to a hint', 'Use { "404": "…" } or { "404": { "hint": "…", "suggest": "other-adapter" } }.', 'adapter-fields'));
    } else {
      for (const [key, h] of Object.entries(hints)) {
        const ok = typeof h === 'string' ? h.trim() : h && typeof h === 'object' && typeof h.hint === 'string' && h.hint.trim() && (h.suggest === undefined || typeof h.suggest === 'string');
        if (!ok) errors.push(error('verify-hints-shape', `verifyHints.${key}`, 'each hint is a string or { hint, suggest? }', 'Write the hint as text; suggest is another adapter slug.', 'adapter-fields'));
        if (!/^(\d{3}|[a-z_]+)$/.test(key)) errors.push(error('verify-hints-key', `verifyHints.${key}`, `"${key}" is neither an HTTP status nor a failure kind`, 'Key by "401", "404", … or by a kind such as "auth_failed".', 'adapter-fields'));
        if (h && typeof h === 'object' && h.field !== undefined && !declaredVars(adapter).includes(h.field)) errors.push(error('verify-hints-field', `verifyHints.${key}.field`, `field "${h.field}" is not a declared variable`, 'Name the variable the hint belongs under.', 'adapter-fields'));
      }
    }
  }

  if (adapter.probe?.failWhen !== undefined) {
    const rules = adapter.probe.failWhen;
    if (!Array.isArray(rules)) {
      errors.push(error('probe-fail-when', 'probe.failWhen', 'probe.failWhen must be a list of rules', 'Use [{ "matches": "…", "hint": "…" }].', 'adapter-fields'));
    } else {
      rules.forEach((r, i) => {
        const at = `probe.failWhen[${i}]`;
        let validRe = false;
        try { new RegExp(r?.matches, 'i'); validRe = typeof r?.matches === 'string' && r.matches.trim() !== ''; } catch { /* reported below */ }
        if (!validRe || typeof r?.hint !== 'string' || !r.hint.trim()) errors.push(error('probe-fail-when', at, 'each rule needs a valid regular expression in matches and a hint', 'Use { "matches": "…", "hint": "…" }.', 'adapter-fields'));
        if (r?.field !== undefined && !declaredVars(adapter).includes(r.field)) errors.push(error('probe-fail-when', `${at}.field`, `field "${r.field}" is not a declared variable`, 'Name the variable the hint belongs under.', 'adapter-fields'));
      });
    }
  }

  if (adapter.derivedEnvVars !== undefined) {
    const derived = adapter.derivedEnvVars;
    if (!derived || typeof derived !== 'object' || Array.isArray(derived)) {
      errors.push(error('derived-env-vars', 'derivedEnvVars', 'derivedEnvVars must map a variable name to its lookup', 'Use { "X_ID": { "fromHost": "X_SITE", "url": "https://{{X_SITE}}/…", "path": "id", "error": "…" } }.', 'adapter-fields'));
    } else {
      for (const [name, d] of Object.entries(derived)) {
        const at = `derivedEnvVars.${name}`;
        if (declaredVars(adapter).includes(name)) errors.push(error('derived-env-vars', at, `"${name}" is looked up, so it must not be a variable the user enters`, 'Remove it from requiredEnvVars and optionalEnvVars.', 'adapter-fields'));
        const ok = d && typeof d === 'object' && declaredVars(adapter).includes(d.fromHost) && typeof d.url === 'string' && d.url.startsWith(`https://{{${d.fromHost}}}/`) && typeof d.path === 'string' && d.path && typeof d.error === 'string' && d.error.trim();
        if (!ok) errors.push(error('derived-env-vars', at, 'a derived variable needs a declared fromHost, an https url starting with {{fromHost}}, a path and an error', 'See docs/tool-definition.md.', 'adapter-fields'));
      }
    }
  }

  if (adapter.instructionFacts !== undefined) {
    const facts = adapter.instructionFacts;
    const known = new Set([...declaredVars(adapter), ...Object.keys(adapter.derivedEnvVars ?? {})]);
    if (!Array.isArray(facts) || facts.some((f) => typeof f !== 'string' || !f.trim())) {
      errors.push(error('instruction-facts', 'instructionFacts', 'instructionFacts must be a list of sentences', 'Use ["This workspace\'s site is {{X_SITE}}."].', 'adapter-fields'));
    } else {
      facts.forEach((f, i) => {
        for (const [, name] of f.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
          const secret = adapter.envVarMeta?.[name]?.secret === true || adapter.envVarMeta?.[name]?.kind === 'credential';
          if (!known.has(name) || secret) errors.push(error('instruction-facts', `instructionFacts[${i}]`, `"${name}" is not a non-secret variable of this adapter`, 'Name only settings the adapter declares or looks up; secrets are never rendered.', 'adapter-fields'));
        }
      });
    }
  }

  for (const problem of loginBasicAuthProblems(adapter.connector)) {
    errors.push(error('login-basic-auth', 'connector.authConfig.loginBasicAuth', problem, 'With loginBasicAuth: true the engine sends Authorization: Basic base64(username:password) on the login request; give username and password, and keep the password out of loginBody and loginHeaders.', 'authentication'));
  }

  if (adapter.checkBeforeAuthorization !== undefined) {
    const check = adapter.checkBeforeAuthorization;
    const okPath = check && typeof check === 'object' && typeof check.path === 'string' && check.path.trim() && !/^https?:/i.test(check.path);
    const okHeaders = check?.headers === undefined || (check.headers && typeof check.headers === 'object' && Object.values(check.headers).every((v) => typeof v === 'string'));
    if (!okPath || !okHeaders) errors.push(error('check-before-authorization', 'checkBeforeAuthorization', 'checkBeforeAuthorization needs a path relative to the base URL and string headers', 'Use { "path": "/ping", "headers": { "x-api-key": "{{KEY}}" } }.', 'adapter-fields'));
    if (adapter.connector?.authType !== 'OAUTH2') errors.push(error('check-before-authorization', 'checkBeforeAuthorization', 'checkBeforeAuthorization only runs for adapters signed in through the browser (OAUTH2)', 'Remove it, or use probe for other adapters.', 'adapter-fields'));
  }

  for (const problem of errorWhenProblems(adapter.connector?.config?.errorWhen)) {
    errors.push(error('error-when', 'connector.config.errorWhen', problem, 'Each rule needs a path and may set equals, in, matches, messagePath, messageMatches and an error status (400-599).', 'errors-inside-a-200-response'));
  }

  const slugUnderscored = adapter.slug.replace(/-/g, '_');
  // File Search entries are set up by the File Search wizard; their tools are
  // the fixed built-ins the catalog adds (catalog.ts withFileSearchBuiltins).
  if (adapter.connector?.type === 'FILE_SEARCH') {
    if (!Array.isArray(adapter.tools)) errors.push(error('tools', 'tools', 'tools must be an array (empty for File Search)', 'Use "tools": [].', 'tools'));
    if (!adapter.connector?.config?.fileSearch?.protocol) errors.push(error('file-search', 'connector.config.fileSearch.protocol', 'File Search adapters name their protocol', 'Set connector.config.fileSearch.protocol (sftp, ftps, webdav, local, s3).', 'adapter-fields'));
    return { errors, warnings };
  }
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
