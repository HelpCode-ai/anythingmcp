#!/usr/bin/env node
/**
 * Generate satellite repositories locally. Nothing is pushed: publishing is a
 * separate, explicit step once a satellite passes --check-publish.
 *
 *   node scripts/satellites/generate.mjs --only soap-to-mcp,weclapp-mcp-server
 *   node scripts/satellites/generate.mjs --check              # §3.12.6 checks, every satellite
 *   node scripts/satellites/generate.mjs --check --online     # … plus HTTP 200 on each website
 *   node scripts/satellites/generate.mjs --check-publish --only weclapp-mcp-server
 *
 * Options: --out <dir> (default scripts/satellites/out, git-ignored),
 *          --date YYYY-MM-DD (the "Adapter synced" date; default today).
 * Also writes <out>/apply-metadata.sh with the `gh repo edit` commands.
 */
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  HERE,
  loadCatalog,
  loadConfig,
  loadTopicCounts,
  loadContent,
  checkSatellite,
  buildSatellite,
  applyMetadataScript,
} from './lib.mjs';
import { introWordCount } from './readme.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(name);

const config = loadConfig();
const catalog = loadCatalog();
const topicCounts = loadTopicCounts();
const date = opt('--date') ?? new Date().toISOString().slice(0, 10);
const out = opt('--out') ?? join(HERE, 'out');
const only = opt('--only')?.split(',');
const selected = only ? config.satellites.filter((s) => only.includes(s.repo)) : config.satellites;
if (only && selected.length !== only.length) {
  console.error(`unknown satellite(s): ${only.filter((r) => !config.satellites.some((s) => s.repo === r)).join(', ')}`);
  process.exit(2);
}

const checking = flag('--check') || flag('--check-publish');
let failed = false;

for (const sat of selected) {
  const content = loadContent(sat.repo);
  const { errors, warnings, blockers } = checkSatellite(sat, { config, catalog, topicCounts, content });
  if (flag('--online')) {
    try {
      const res = await fetch(sat.website, { redirect: 'manual' });
      if (res.status !== 200) errors.push(`website ${sat.website} answers ${res.status}`);
    } catch (e) {
      errors.push(`website ${sat.website}: ${e.message}`);
    }
  }
  let files;
  if (!checking || errors.length === 0) {
    try {
      files = buildSatellite(sat, { config, catalog, content, date });
      const words = introWordCount(files['README.md'] ?? '');
      if (words < 40 || words > 60) errors.push(`README intro is ${words} words (40–60)`);
    } catch (e) {
      (checking ? errors : warnings).push(e.message);
    }
  }
  const bad = errors.length > 0 || (flag('--check-publish') && blockers.length > 0);
  if (bad) failed = true;
  if (checking || errors.length || warnings.length || blockers.length) {
    console.log(`${bad ? '✗' : '✓'} ${sat.owner}/${sat.repo}`);
    for (const e of errors) console.log(`    error:   ${e}`);
    for (const b of blockers) console.log(`    blocker: ${b}`);
    for (const w of warnings) console.log(`    warning: ${w}`);
  }
  if (!checking && files) {
    const dir = join(out, sat.owner, sat.repo);
    rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      if (rel.endsWith('.sh')) chmodSync(path, 0o755);
    }
    console.log(`wrote ${Object.keys(files).length} files to ${dir}`);
  }
}

if (!checking) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'apply-metadata.sh'), applyMetadataScript(selected, config), { mode: 0o755 });
  console.log(`wrote ${join(out, 'apply-metadata.sh')}`);
}
process.exit(failed ? 1 : 0);
