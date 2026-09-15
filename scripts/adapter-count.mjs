#!/usr/bin/env node
/**
 * Single source of truth for "how many adapters ship with AnythingMCP".
 *
 * Counts every adapter JSON under packages/backend/src/adapters/<region>/ and
 * prints the numbers. With --check it verifies that every place that quotes
 * the count (README, glama.json, CITATION.cff, issue-template config, the
 * demo tools) agrees with the real number, and exits 1 otherwise. Wired into
 * CI so the README can never drift from the catalog again.
 *
 *   node scripts/adapter-count.mjs            # prints JSON {adapters, keyless}
 *   node scripts/adapter-count.mjs --check    # verifies the quoted numbers
 *   node scripts/adapter-count.mjs --json > packages/frontend/public/catalog-stats.json
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = join(ROOT, 'packages/backend/src/adapters');

const adapters = [];
for (const region of readdirSync(ADAPTERS_DIR)) {
  const dir = join(ADAPTERS_DIR, region);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    adapters.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
}
const stats = {
  adapters: adapters.length,
  keyless: adapters.filter((a) => a.connector?.authType === 'NONE').length,
  tools: adapters.reduce((n, a) => n + (a.tools?.length ?? 0), 0),
};

const args = process.argv.slice(2);
if (args.includes('--json') || !args.includes('--check')) {
  console.log(JSON.stringify(stats));
}

if (args.includes('--check')) {
  // Each entry: file, regex that captures the quoted number. Every capture in
  // the file must equal stats.adapters.
  const N = stats.adapters;
  const checks = [
    ['README.md', /\b(\d{2,3})\s+(?:pre-built |ready-to-use |ready )?(?:adapters|connectors)\b/g],
    ['glama.json', /\b(\d{2,3})\+?\s+pre-built adapters\b/g],
    ['CITATION.cff', /\b(\d{2,3})\s+pre-built adapters\b/g],
    ['.github/ISSUE_TEMPLATE/config.yml', /\b(\d{2,3})\+?\s+adapter/g],
    ['server.json', /\b(\d{2,3})\s+(?:pre-built )?(?:adapters|connectors)\b/g],
    ['package.json', /\b(\d{2,3})\s+pre-built adapters\b/g],
    ['.github/workflows/docker-publish.yml', /\b(\d{2,3})\s+connectors\b/g],
  ];
  // Same idea for the "no API key needed" number, which the README, the demo
  // tools and the website all quote as a selling point.
  const keylessChecks = [
    ['README.md', /\b(\d{1,3})\s+(?:of them\s+)?(?:need|needs)\s+no API key\b/g],
    ['README.md', /\b(\d{1,3})\s+adapters need no API key\b/g],
  ];
  const banned = [
    // Wording that no longer describes the project. CHANGELOG/LICENSING/license-faq
    // legitimately mention the pre-AGPL history and are excluded.
    ['README.md', /source-available|BSL|non-commercial/i],
    ['glama.json', /source-available|BSL|non-commercial/i],
    ['server.json', /source-available|BSL|non-commercial/i],
    ['CITATION.cff', /source-available|BSL|non-commercial/i],
    ['docs/guides.md', /source-available|BSL-1\.1|non-commercial/i],
    ['.github/ISSUE_TEMPLATE/config.yml', /source-available|BSL|non-commercial/i],
  ];
  let failed = false;
  for (const [file, re] of checks) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(re)) {
      if (Number(m[1]) !== N) {
        console.error(`::error file=${file}::quotes "${m[0]}" but the catalog has ${N} adapters`);
        failed = true;
      }
    }
  }
  for (const [file, re] of keylessChecks) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(re)) {
      if (Number(m[1]) !== stats.keyless) {
        console.error(
          `::error file=${file}::quotes "${m[0]}" but ${stats.keyless} adapters have authType NONE`,
        );
        failed = true;
      }
    }
  }
  // The MCP registry rejects a server.json description over 100 characters with
  // a 422, which is invisible until someone actually runs mcp-publisher. Ours
  // sat at 158 for a while, so every publish silently failed and the registry
  // kept serving a description from an older release.
  const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
  if ((serverJson.description ?? '').length > 100) {
    console.error(
      `::error file=server.json::description is ${serverJson.description.length} characters; the MCP registry rejects anything over 100`,
    );
    failed = true;
  }

  for (const [file, re] of banned) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const m = text.match(re);
    if (m) {
      console.error(`::error file=${file}::contains outdated wording "${m[0]}"`);
      failed = true;
    }
  }
  if (failed) {
    console.error(`Fix the numbers/wording above (real count: ${N} adapters, ${stats.keyless} keyless, ${stats.tools} tools).`);
    process.exit(1);
  }
  console.log(`OK: every quoted count equals ${N} adapters (${stats.keyless} keyless, ${stats.tools} tools).`);
}
