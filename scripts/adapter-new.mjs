#!/usr/bin/env node
/**
 * Scaffolds a new adapter: writes a valid skeleton to
 * packages/backend/src/adapters/<region>/<slug>.json, checks it with the same
 * validator CI runs, and prints what to do next.
 *
 * Run: node scripts/adapter-new.mjs <slug> --region de --auth API_KEY
 *  or: npm run adapter:new -- <slug> --region de --auth API_KEY
 *
 * The skeleton passes the hard gates out of the box. Every spot you still have
 * to fill in carries a `TODO` marker, and `validate-adapters.mjs` reports each
 * one as a `todo-marker` warning so an unfinished file is easy to spot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ALLOWED_AUTH_TYPES, REGIONS, adapterResult, loadAdapter } from './validate-adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');

// Lowercase words joined by hyphens. The first character must be a letter:
// regenerate-catalog.mjs turns the slug into a JS identifier for the import, and
// an identifier cannot start with a digit ("3m-tracker" -> `3mTracker`).
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A mistake the user can fix by changing the command line. */
export class ScaffoldError extends Error {}

const INSTRUCTIONS = [
  'TODO: describe what this connector does in two or three sentences, and which product or API it talks to.',
  '',
  '**Authentication**: TODO: say which credentials the operator has to create in the product, and where to find them.',
  '',
  '**Identifiers**: TODO: explain the ID formats the tools accept (for example an order number or a customer ID) with one real-looking example each.',
  '',
  '**Pagination and limits**: TODO: explain how to page through long lists, the default and maximum page size, and any rate limit the API enforces.',
  '',
  '**Common workflows**: TODO: list the two or three most useful sequences of tool calls, for example "search for a customer, then fetch their invoices".',
  '',
  '**Limitations**: TODO: name what this adapter does not cover, and anything that needs a different plan or permission on the vendor side.',
].join('\n');

/** Repo-relative path with forward slashes, so output reads the same on every OS. */
const display = (fullPath) => relative(REPO_ROOT, fullPath).split('\\').join('/');

const snake = (slug) => slug.replace(/-/g, '_');

/** The credentials part of `connector`, and the env vars it needs. */
function authParts(auth, slug) {
  if (auth === 'NONE') return { envVars: [], authConfig: undefined };
  if (auth === 'API_KEY') {
    const envVar = `${snake(slug).toUpperCase()}_API_KEY`;
    return {
      envVars: [envVar],
      authConfig: { headerName: 'TODO-header-name', apiKey: `{{${envVar}}}` },
    };
  }
  // Credentials differ too much between the other types to template them here.
  return {
    envVars: [],
    authConfig: { credentials: `TODO: fill in the ${auth} credentials, see docs/tool-definition.md#authentication` },
  };
}

/** Build the adapter object for `slug`. Pure: touches neither the disk nor the process. */
export function buildSkeleton({ slug, region, auth }) {
  const { envVars, authConfig } = authParts(auth, slug);
  return {
    slug,
    name: 'TODO: Product Name',
    description: 'TODO: one or two sentences on what an AI assistant can do with this connector.',
    instructions: INSTRUCTIONS,
    region,
    category: 'other',
    icon: slug,
    docsUrl: 'https://example.com/TODO-docs-url',
    requiredEnvVars: envVars,
    connector: {
      name: 'TODO: Product Name',
      type: 'REST',
      baseUrl: 'https://api.example.com/TODO-base-url',
      authType: auth,
      ...(authConfig ? { authConfig } : {}),
    },
    tools: [
      {
        name: `${snake(slug)}_example`,
        description: 'TODO: say what this tool does and what it returns, in at least one full sentence for the model.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'TODO: what this parameter identifies, and its format.' },
          },
          required: ['id'],
        },
        endpointMapping: { method: 'GET', path: '/TODO-path/{id}' },
      },
    ],
  };
}

/**
 * Write the skeleton and validate it. Throws ScaffoldError for bad input, or an
 * existing file without `force`. Returns where it wrote and what the validator said.
 */
export function scaffold({ slug, region, auth, force = false, root = DEFAULT_ADAPTERS_DIR }) {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new ScaffoldError(`slug "${slug ?? ''}" must start with a letter and be lowercase words joined by hyphens, like "my-service"`);
  }
  if (!REGIONS.includes(region)) {
    throw new ScaffoldError(`region "${region ?? ''}" is not one of: ${REGIONS.join(', ')}`);
  }
  if (!ALLOWED_AUTH_TYPES.has(auth)) {
    throw new ScaffoldError(`auth "${auth ?? ''}" is not one of: ${[...ALLOWED_AUTH_TYPES].join(', ')}`);
  }

  const file = `${slug}.json`;
  const fullPath = join(root, region, file);

  mkdirSync(dirname(fullPath), { recursive: true });
  // 'wx' creates the file or fails if it exists, in one step. Checking first
  // and writing after leaves a window in which the file can appear (CodeQL
  // js/file-system-race).
  try {
    writeFileSync(fullPath, `${JSON.stringify(buildSkeleton({ slug, region, auth }), null, 2)}\n`, {
      flag: force ? 'w' : 'wx',
    });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      throw new ScaffoldError(`${display(fullPath)} already exists; pass --force to overwrite it`);
    }
    throw e;
  }

  const result = adapterResult(loadAdapter(fullPath), file, region);
  return { fullPath, result };
}

const USAGE = `Usage: node scripts/adapter-new.mjs <slug> --region <region> --auth <type> [--force]

  <slug>      lowercase words joined by hyphens, e.g. my-service
  --region    ${REGIONS.join(', ')}
  --auth      ${[...ALLOWED_AUTH_TYPES].join(', ')}
  --force     overwrite the adapter if it already exists
`;

export function main(argv = process.argv.slice(2), { root = DEFAULT_ADAPTERS_DIR, out = console.log, err = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        region: { type: 'string' },
        auth: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !values.region || !values.auth) {
    err(`Give one slug, --region and --auth.\n\n${USAGE}`);
    return 1;
  }

  let written;
  try {
    written = scaffold({ slug: positionals[0], region: values.region, auth: values.auth, force: values.force, root });
  } catch (e) {
    if (!(e instanceof ScaffoldError)) throw e;
    err(`Error: ${e.message}`);
    return 1;
  }

  const shown = display(written.fullPath);
  const { errors, warnings } = written.result;
  if (errors.length) {
    // The skeleton is meant to be valid, so this is a bug in the scaffolder.
    err(`The generated ${shown} failed validation, which should not happen:`);
    errors.forEach((item) => err(`  - [${item.rule}] ${item.path}: ${item.message}`));
    return 1;
  }

  const todos = warnings.filter((w) => w.rule === 'todo-marker').length;
  out(`Created ${shown}`);
  out(`Validated: 0 errors, ${todos} TODO marker${todos === 1 ? '' : 's'} left to fill in.`);
  out(`
Next:
  1. node scripts/validate-adapters.mjs --warn      # replace every TODO until this is clean
  2. node scripts/regenerate-catalog.mjs             # commit the catalog.ts diff
  3. npm run dev:backend                             # start the backend and try your tools`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
