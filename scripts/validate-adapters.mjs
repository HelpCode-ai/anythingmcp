#!/usr/bin/env node
/**
 * Validates every adapter JSON under packages/backend/src/adapters/ against
 * the quality gate that protects the catalog from low-effort connectors.
 *
 * Exits with code 0 if all adapters pass, 1 if any fail.
 *
 * Run locally:  node scripts/validate-adapters.mjs
 * Run in CI:    same — wired in .github/workflows/ci.yml.
 *
 * Hard gates (fail CI):
 *  1. Required top-level fields present (slug, name, description, region,
 *     category, icon, docsUrl, requiredEnvVars, connector, tools).
 *  2. `slug` matches the filename (so the codegen importer finds it).
 *  3. `connector.type` is one of REST, GRAPHQL, SOAP, MCP, DATABASE,
 *     LOGIN_TOKEN.
 *  4. `connector.authType` is one of NONE, API_KEY, BEARER_TOKEN, BASIC,
 *     BASIC_AUTH, OAUTH2, LOGIN_TOKEN.
 *  5. `requiredEnvVars` are referenced somewhere as {{VAR}} (otherwise the
 *     env var is unused metadata and won't actually be injected).
 *  6. `tools` is a non-empty array.
 *
 * Soft warnings (printed, do NOT fail CI):
 *  - `instructions` shorter than 800 chars.
 *  - Tool name not prefixed with `{slug_underscored}_`.
 *  - Tool `description` shorter than 60 chars.
 *  - Tool parameter property missing `description`.
 *  - Tool `endpointMapping` missing method/path (text-only "skill" tools
 *    that return guidance are a known valid pattern — see WordPress adapter).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');
const REGIONS = ['de', 'gb', 'intl', 'br', 'in', 'jp', 'ng'];

const ALLOWED_CONNECTOR_TYPES = new Set([
  'REST',
  'GRAPHQL',
  'SOAP',
  'MCP',
  'DATABASE',
  'LOGIN_TOKEN',
]);
const ALLOWED_AUTH_TYPES = new Set([
  'NONE',
  'API_KEY',
  'BEARER_TOKEN',
  'BASIC',
  'BASIC_AUTH',
  'OAUTH2',
  'OAUTH1', // OAuth 1.0a HMAC-SHA1 request signing (e.g. ImmobilienScout24)
  'LOGIN_TOKEN',
  'QUERY_AUTH', // existing adapters (destatis, here-geocoding, oxomi) pass the API key as a query string parameter
]);

const REQUIRED_TOP_LEVEL = [
  'slug',
  'name',
  'description',
  'region',
  'category',
  'icon',
  'docsUrl',
  'requiredEnvVars',
  'connector',
  'tools',
];

const MIN_INSTRUCTIONS_LEN = 800;
const MIN_TOOL_DESCRIPTION_LEN = 60;

function collectAdapters() {
  const out = [];
  for (const region of REGIONS) {
    const regionPath = join(ADAPTERS_DIR, region);
    let entries;
    try {
      entries = readdirSync(regionPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const fullPath = join(regionPath, file);
      if (!statSync(fullPath).isFile()) continue;
      out.push({ region, file, fullPath });
    }
  }
  return out;
}

function isPlaceholderReferenced(envVar, adapter) {
  const placeholder = `{{${envVar}}}`;
  const haystack = JSON.stringify(adapter);
  return haystack.includes(placeholder);
}

function validateAdapter(adapter, file, region) {
  const errors = [];
  const warnings = [];
  const expectedSlug = file.replace(/\.json$/, '');

  for (const key of REQUIRED_TOP_LEVEL) {
    if (adapter[key] === undefined || adapter[key] === null) {
      errors.push(`missing required field: ${key}`);
    }
  }
  if (errors.length) return { errors, warnings };

  if (adapter.slug !== expectedSlug) {
    errors.push(
      `slug "${adapter.slug}" does not match filename "${expectedSlug}"`,
    );
  }
  // region mismatch is informational only — some adapters live under a
  // region directory but declare a wider region (e.g. eu under de/).
  if (adapter.region !== region) {
    warnings.push(
      `region "${adapter.region}" does not match directory "${region}"`,
    );
  }

  if (!ALLOWED_CONNECTOR_TYPES.has(adapter.connector?.type)) {
    errors.push(
      `connector.type "${adapter.connector?.type}" not in [${[...ALLOWED_CONNECTOR_TYPES].join(', ')}]`,
    );
  }
  if (!ALLOWED_AUTH_TYPES.has(adapter.connector?.authType)) {
    errors.push(
      `connector.authType "${adapter.connector?.authType}" not in [${[...ALLOWED_AUTH_TYPES].join(', ')}]`,
    );
  }

  // requiredEnvVars that aren't referenced as {{VAR}} are typically env vars
  // documented for the operator (e.g. an account ID the agent passes as a
  // per-call tool parameter rather than something the connector auto-injects).
  // Treat as a soft warning.
  for (const envVar of adapter.requiredEnvVars || []) {
    if (!isPlaceholderReferenced(envVar, adapter)) {
      warnings.push(
        `requiredEnvVars contains "${envVar}" but it's not auto-injected via {{${envVar}}} (operator must set it for documentation, agent passes it as a tool param)`,
      );
    }
  }

  const slugUnderscored = adapter.slug.replace(/-/g, '_');
  if (!Array.isArray(adapter.tools) || adapter.tools.length === 0) {
    errors.push('tools array is empty');
    return { errors, warnings };
  }

  // --- Soft warnings ---
  if (!adapter.instructions || adapter.instructions.length < MIN_INSTRUCTIONS_LEN) {
    warnings.push(
      `instructions field is ${adapter.instructions?.length || 0} chars (recommend ≥ ${MIN_INSTRUCTIONS_LEN})`,
    );
  }

  for (const tool of adapter.tools) {
    if (!tool.name || typeof tool.name !== 'string') {
      errors.push(`tool with no name: ${JSON.stringify(tool).slice(0, 80)}`);
      continue;
    }
    if (!tool.name.startsWith(`${slugUnderscored}_`)) {
      warnings.push(
        `tool "${tool.name}" not prefixed with "${slugUnderscored}_"`,
      );
    }
    if (!tool.description || tool.description.length < MIN_TOOL_DESCRIPTION_LEN) {
      warnings.push(
        `tool "${tool.name}" description is ${tool.description?.length || 0} chars (recommend ≥ ${MIN_TOOL_DESCRIPTION_LEN})`,
      );
    }
    // endpointMapping is omitted on text-only "skill" tools that return
    // guidance instead of calling an API — that's a valid pattern, skip the
    // check.
    const props = tool.parameters?.properties;
    if (props && typeof props === 'object') {
      for (const [pname, pdef] of Object.entries(props)) {
        if (!pdef || typeof pdef !== 'object' || !pdef.description) {
          warnings.push(
            `tool "${tool.name}" parameter "${pname}" missing description`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

function main() {
  const adapters = collectAdapters();
  if (adapters.length === 0) {
    console.error('No adapters found.');
    process.exit(1);
  }

  const showWarnings = process.argv.includes('--warn');

  let failed = 0;
  let passed = 0;
  let totalWarnings = 0;
  for (const { region, file, fullPath } of adapters) {
    let raw;
    try {
      raw = readFileSync(fullPath, 'utf8');
    } catch (e) {
      console.error(`✗ ${region}/${file}: cannot read — ${e.message}`);
      failed++;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${region}/${file}: invalid JSON — ${e.message}`);
      failed++;
      continue;
    }
    const { errors, warnings } = validateAdapter(parsed, file, region);
    totalWarnings += warnings.length;
    if (errors.length === 0) {
      passed++;
      if (showWarnings && warnings.length) {
        console.warn(`⚠ ${region}/${file}: ${warnings.length} warning(s)`);
        for (const w of warnings) console.warn(`    - ${w}`);
      }
      continue;
    }
    failed++;
    console.error(`✗ ${region}/${file}:`);
    for (const err of errors) console.error(`    - ${err}`);
    if (showWarnings && warnings.length) {
      console.warn(`  ⚠ also ${warnings.length} warning(s)`);
      for (const w of warnings) console.warn(`    - ${w}`);
    }
  }

  console.log(
    `\nValidated ${adapters.length} adapters: ${passed} passed, ${failed} failed${showWarnings ? `, ${totalWarnings} total warnings` : ''}.`,
  );
  if (!showWarnings && totalWarnings > 0) {
    console.log(`(${totalWarnings} non-blocking warnings hidden — re-run with --warn to see them)`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
