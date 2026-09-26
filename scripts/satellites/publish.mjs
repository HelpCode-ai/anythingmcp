#!/usr/bin/env node
/**
 * Publish satellites to GitHub. Refuses anything that fails --check-publish.
 *
 *   node scripts/satellites/publish.mjs --only soap-to-mcp,weclapp-mcp-server
 *   node scripts/satellites/publish.mjs --only soap-to-mcp --dry-run
 *
 * For each repository: create it (public) if missing, push the generated
 * files as one commit on main, set About, website and topics, and allow the
 * sync workflow to open pull requests. Links to sibling satellites are only
 * written when that sibling already exists on GitHub or is in the same run.
 * Needs `gh` logged in with admin rights on every owner involved.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog, loadConfig, loadTopicCounts, loadContent, checkSatellite, buildSatellite } from './lib.mjs';

const args = process.argv.slice(2);
const only = args[args.indexOf('--only') + 1]?.split(',');
const dryRun = args.includes('--dry-run');
if (!args.includes('--only') || !only?.length) {
  console.error('usage: publish.mjs --only repo[,repo…] [--dry-run]');
  process.exit(2);
}

const config = loadConfig();
const catalog = loadCatalog();
const topicCounts = loadTopicCounts();
const date = new Date().toISOString().slice(0, 10);
const batch = config.satellites.filter((s) => only.includes(s.repo));
if (batch.length !== only.length) {
  console.error(`unknown satellite(s): ${only.filter((r) => !batch.some((s) => s.repo === r)).join(', ')}`);
  process.exit(2);
}

const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const exists = (full) => {
  try {
    sh('gh', ['api', `repos/${full}`, '--jq', '.full_name']);
    return true;
  } catch {
    return false;
  }
};
const mainSha = sh('git', ['rev-parse', '--short', 'HEAD']);

// Every check first: nothing is created unless the whole batch is publishable.
let bad = false;
for (const sat of batch) {
  const { errors, blockers } = checkSatellite(sat, { config, catalog, topicCounts, content: loadContent(sat.repo) });
  for (const e of [...errors, ...blockers]) console.error(`✗ ${sat.owner}/${sat.repo}: ${e}`);
  if (errors.length || blockers.length) bad = true;
}
if (bad) process.exit(1);

const available = new Set(batch.map((s) => `${s.owner}/${s.repo}`));
for (const s of config.satellites) {
  const full = `${s.owner}/${s.repo}`;
  if (!available.has(full) && exists(full)) available.add(full);
}

for (const sat of batch) {
  const full = `${sat.owner}/${sat.repo}`;
  const files = buildSatellite(sat, { config: { ...config, available }, catalog, content: loadContent(sat.repo), date });
  const topics = [...config.baseTopics, ...sat.topics];
  console.log(`\n${full}: ${Object.keys(files).length} files, ${topics.length} topics${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) continue;

  const created = !exists(full);
  if (created) {
    sh('gh', ['repo', 'create', full, '--public', '--description', sat.about, '--homepage', sat.website]);
    console.log('  created');
  }

  const dir = mkdtempSync(join(tmpdir(), `sat-${sat.repo}-`));
  let hasHistory = false;
  try {
    sh('git', ['clone', '--quiet', `https://github.com/${full}.git`, dir]);
    hasHistory = sh('git', ['-C', dir, 'rev-list', '--all', '--count']) !== '0';
  } catch {
    sh('git', ['init', '--quiet', dir]);
  }
  // Replace the tracked tree entirely: files the generator dropped must go.
  for (const f of readdirSync(dir)) if (f !== '.git') rmSync(join(dir, f), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    if (rel.endsWith('.sh')) chmodSync(p, 0o755);
  }
  sh('git', ['-C', dir, 'checkout', '--quiet', '-B', 'main']);
  sh('git', ['-C', dir, 'add', '-A']);
  const dirty = sh('git', ['-C', dir, 'status', '--porcelain']) !== '';
  if (dirty) {
    const msg = hasHistory
      ? `Regenerate from HelpCode-ai/anythingmcp@${mainSha}`
      : `Initial version, generated from HelpCode-ai/anythingmcp@${mainSha}`;
    sh('git', ['-C', dir, 'commit', '--quiet', '-m', msg]);
    try {
      sh('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    } catch {
      sh('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${full}.git`]);
    }
    sh('git', ['-C', dir, 'push', '--quiet', '-u', 'origin', 'main']);
    console.log(`  pushed: ${msg}`);
  } else {
    console.log('  unchanged');
  }
  rmSync(dir, { recursive: true, force: true });

  sh('gh', ['repo', 'edit', full, '--description', sat.about, '--homepage', sat.website, '--add-topic', topics.join(','), '--enable-wiki=false', '--enable-projects=false']);
  console.log('  About, website and topics set');
  if (files['.github/workflows/sync-adapter.yml']) {
    // The workflow asks for contents/pull-requests: write itself; this only
    // matters where the repository default is read-only. An organisation can
    // forbid changing it, which is its call to make, so warn and go on.
    try {
      sh('gh', ['api', '-X', 'PUT', `repos/${full}/actions/permissions/workflow`, '-f', 'default_workflow_permissions=write', '-F', 'can_approve_pull_request_reviews=true']);
      console.log('  sync workflow may open pull requests');
    } catch (e) {
      console.log(`  warning: could not change workflow permissions (${String(e.stderr || e.message).trim().split('\n').pop()})`);
    }
  }
}
