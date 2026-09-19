#!/usr/bin/env node
/**
 * Validates every adapter JSON under packages/backend/src/adapters/ against
 * the quality gate that protects the catalog from low-effort connectors.
 *
 * Exits with code 0 if all adapters pass, 1 if any fail.
 *
 * Hard gates (fail CI): required fields, filename/slug agreement, supported
 * connector and authentication types, and a non-empty tools array.
 *
 * Soft warnings (printed with --warn, but do not fail CI): short instructions,
 * unprefixed tool names, short tool descriptions, and missing parameter
 * descriptions. Environment-reference checks are also informational because
 * some adapters document values supplied as tool parameters.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');
const REGIONS = [
  'de', 'gb', 'intl', 'br', 'in', 'jp', 'ng',
  'it', 'es', 'fr', 'nl', 'be', 'ch', 'se', 'dk',
];
const ALLOWED_CONNECTOR_TYPES = new Set(['REST', 'GRAPHQL', 'SOAP', 'MCP', 'DATABASE', 'LOGIN_TOKEN']);
const ALLOWED_AUTH_TYPES = new Set(['NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_AUTH', 'OAUTH2', 'OAUTH1', 'LOGIN_TOKEN', 'QUERY_AUTH', 'CONNECTION_STRING', 'HMAC']);
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

function isPlaceholderReferenced(envVar, adapter) {
  return JSON.stringify(adapter).includes(`{{${envVar}}}`);
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
  }
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
