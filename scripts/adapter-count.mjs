#!/usr/bin/env node
/**
 * Single source of truth for "how many adapters ship with AnythingMCP".
 *
 * Counts every adapter JSON under packages/backend/src/adapters/<region>/ and
 * prints the numbers. With --check it verifies that every place that quotes
 * the count (README, glama.json, CITATION.cff, server.json, package.json)
 * agrees with the real number, and exits 1 otherwise. Wired into CI so the
 * README can never drift from the catalog again.
 *
 * `.github/` is governed by the opposite rule: nothing in there may quote the
 * count at all, and --check fails if something does. Workflows read it from
 * this script at runtime instead. The reason is supply-chain rather than
 * tidiness — see the guard near the bottom of this file.
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
  // "No API key" is a promise about the cloud too, so an adapter that only
  // answers residential IPs (selfHostOnly) does not count towards it even
  // though it needs no key.
  keyless: adapters.filter((a) => a.connector?.authType === 'NONE' && !a.selfHostOnly).length,
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
  // [file, regex, expected number of matches]. The third element exists for
  // the translated READMEs: a regex that matches nothing passes silently, so a
  // translator rewording "257 fertige Adapter" would quietly remove the file
  // from this guard rather than fail it. The English files predate the count
  // and are left without one.
  const checks = [
    ['README.md', /\b(\d{2,3})\s+(?:pre-built |ready-to-use |ready )?(?:adapters|connectors)\b/g],
    ['glama.json', /\b(\d{2,3})\+?\s+pre-built adapters\b/g],
    ['CITATION.cff', /\b(\d{2,3})\s+pre-built adapters\b/g],
    ['server.json', /\b(\d{2,3})\s+(?:pre-built )?(?:adapters|connectors)\b/g],
    ['package.json', /\b(\d{2,3})\s+pre-built adapters\b/g],
    ['README.de.md', /\b(\d{2,3})\s+(?:Connectors|fertige Adapter|JSON-Definitionen|Adapter)\b/g, 4],
    ['README.zh-CN.md', /(\d{2,3})\s*个\s*(?:连接器|现成适配器|适配器|JSON 定义)/g, 4],
    ['README.ja.md', /(\d{2,3})\s*(?:のコネクター|種類の既製アダプター|個の JSON 定義|個のアダプター)/g, 4],
  ];
  // Same idea for the "no API key needed" number, which the README, the demo
  // tools and the website all quote as a selling point.
  const keylessChecks = [
    ['README.md', /\b(\d{1,3})\s+(?:of them\s+)?(?:need|needs)\s+no API key\b/g],
    ['README.md', /\b(\d{1,3})\s+adapters need no API key\b/g],
    ['README.de.md', /\b(\d{1,3})\s+(?:davon|benötigen keinen API-Schlüssel)/g, 3],
    ['README.zh-CN.md', /其中\s*(\d{1,3})\s*个/g, 3],
    ['README.ja.md', /(\d{1,3})\s*個?\s*は\s*API\s*キー/g, 3],
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
  for (const [file, re, expected] of checks) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    let seen = 0;
    for (const m of text.matchAll(re)) {
      seen++;
      if (Number(m[1]) !== N) {
        console.error(`::error file=${file}::quotes "${m[0]}" but the catalog has ${N} adapters`);
        failed = true;
      }
    }
    if (expected !== undefined && seen !== expected) {
      console.error(
        `::error file=${file}::matched the adapter count ${seen} times, expected ${expected} — reword the check, not the file`,
      );
      failed = true;
    }
  }
  for (const [file, re, expected] of keylessChecks) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    let seen = 0;
    for (const m of text.matchAll(re)) {
      seen++;
      if (Number(m[1]) !== stats.keyless) {
        console.error(
          `::error file=${file}::quotes "${m[0]}" but ${stats.keyless} adapters have authType NONE`,
        );
        failed = true;
      }
    }
    if (expected !== undefined && seen !== expected) {
      console.error(
        `::error file=${file}::matched the keyless count ${seen} times, expected ${expected} — reword the check, not the file`,
      );
      failed = true;
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

  // Inverted rule for .github/: nothing in there may quote the count.
  //
  // The sync list above used to include docker-publish.yml and the issue
  // template, which meant every adapter PR had to edit a workflow to pass CI.
  // A workflow edit arriving as routine noise on a PR whose subject is a JSON
  // file is the cheapest place in this repository to hide a malicious change,
  // and fork PRs were doing it by design. The number now comes from this
  // script at workflow runtime, and this keeps it from creeping back.
  const githubDir = join(ROOT, '.github');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const abs of walk(githubDir)) {
    if (!/\.(ya?ml|md)$/.test(abs)) continue;
    const rel = abs.slice(ROOT.length + 1);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(
      /\b(\d{2,4})\+?\s+(?:pre-built\s+)?(?:adapters?|connectors?)\b/g,
    )) {
      console.error(
        `::error file=${rel}::quotes "${m[0]}". Nothing under .github/ may carry the adapter count — ` +
          `an adapter PR must never have a reason to edit a workflow. Read it at runtime instead ` +
          `(see the "Read the catalog count" step in docker-publish.yml).`,
      );
      failed = true;
    }
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
