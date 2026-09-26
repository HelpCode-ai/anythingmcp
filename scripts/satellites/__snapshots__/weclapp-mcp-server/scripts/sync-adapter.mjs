#!/usr/bin/env node
/**
 * Pulls the adapter JSON(s) this repository is built on from the AnythingMCP
 * main branch. When one changed, it rewrites adapter/*.json, regenerates the
 * tools table and bumps the "Adapter synced" date. The workflow in
 * .github/workflows/sync-adapter.yml then opens a pull request; nothing is
 * pushed to main without review.
 *
 * "Adapter synced" is not "Last verified": a sync proves the definition is
 * current, not that the vendor API still answers the way it describes.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'satellite.json'), 'utf8'));
const RAW = `https://raw.githubusercontent.com/${manifest.mainRepo}/main/packages/backend/src/adapters`;

let changed = false;
for (const { slug, region } of manifest.adapters) {
  const res = await fetch(`${RAW}/${region}/${slug}.json`);
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const upstream = JSON.stringify(await res.json(), null, 2) + '\n';
  const path = join(root, 'adapter', `${slug}.json`);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== upstream) {
    writeFileSync(path, upstream);
    console.log(`updated adapter/${slug}.json`);
    changed = true;
  }
}

if (changed) {
  execFileSync('node', [join(root, 'scripts', 'render-tools.mjs')], { stdio: 'inherit' });
  const today = new Date().toISOString().slice(0, 10);
  const readmes = ['README.md'];
  if (existsSync(join(root, 'docs'))) {
    for (const f of readdirSync(join(root, 'docs'))) if (/^README\.[a-z]{2}\.md$/.test(f)) readmes.push(join('docs', f));
  }
  for (const f of readmes) {
    const p = join(root, f);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/(<!-- synced -->)\d{4}-\d{2}-\d{2}/g, `$1${today}`));
  }
}
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' });
console.log(changed ? 'Adapter changed.' : 'Adapter unchanged.');
