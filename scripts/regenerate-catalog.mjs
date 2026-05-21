#!/usr/bin/env node
/**
 * Regenerates the auto-managed sections of
 * packages/backend/src/adapters/catalog.ts by scanning every *.json under
 * packages/backend/src/adapters/{de,gb,intl,br,in,jp,ng}/.
 *
 * Hand-written code OUTSIDE the AUTOGEN markers is preserved.
 *
 * Run: node scripts/regenerate-catalog.mjs
 * Wired in: npm --workspace packages/backend run prebuild (see package.json).
 *
 * Rationale: at >100 adapters, hand-editing two lists in catalog.ts on every
 * new adapter is error-prone (forgot the import, forgot the RAW_ADAPTERS
 * entry, mis-ordered them). A codegen step is deterministic, diff-friendly,
 * and runs before nest build so dist/ always has the up-to-date registration.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ADAPTERS_DIR = join(REPO_ROOT, 'packages/backend/src/adapters');
const CATALOG_PATH = join(ADAPTERS_DIR, 'catalog.ts');

const REGIONS = ['de', 'gb', 'intl', 'br', 'in', 'jp', 'ng'];

const IMPORTS_BEGIN = '// === AUTOGEN-IMPORTS-BEGIN === run scripts/regenerate-catalog.mjs ===';
const IMPORTS_END = '// === AUTOGEN-IMPORTS-END ===';
const ARRAY_BEGIN = '// === AUTOGEN-ARRAY-BEGIN === run scripts/regenerate-catalog.mjs ===';
const ARRAY_END = '// === AUTOGEN-ARRAY-END ===';

function toCamelCase(slug) {
  return slug.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
      const slug = file.replace(/\.json$/, '');
      out.push({ region, slug, file });
    }
  }
  // Stable order: by region (REGIONS order), then alphabetical by slug.
  out.sort((a, b) => {
    const r = REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region);
    if (r !== 0) return r;
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

function replaceBlock(source, begin, end, replacement) {
  const re = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);
  if (!re.test(source)) {
    throw new Error(`Markers not found:\n  ${begin}\n  ${end}\nin ${CATALOG_PATH}`);
  }
  return source.replace(re, `${begin}\n${replacement}\n${end}`);
}

function regenerate() {
  const adapters = collectAdapters();

  const importsBody = adapters
    .map((a) => `import * as ${toCamelCase(a.slug)} from './${a.region}/${a.file}';`)
    .join('\n');

  const arrayBody =
    `const RAW_ADAPTERS: AdapterDefinition[] = [\n` +
    adapters
      .map((a) => `  ${toCamelCase(a.slug)} as unknown as AdapterDefinition,`)
      .join('\n') +
    `\n];`;

  let source = readFileSync(CATALOG_PATH, 'utf8');
  source = replaceBlock(source, IMPORTS_BEGIN, IMPORTS_END, importsBody);
  source = replaceBlock(source, ARRAY_BEGIN, ARRAY_END, arrayBody);
  writeFileSync(CATALOG_PATH, source, 'utf8');

  console.log(
    `✓ Regenerated ${CATALOG_PATH}: ${adapters.length} adapters across ${new Set(adapters.map((a) => a.region)).size} regions.`,
  );
}

regenerate();
