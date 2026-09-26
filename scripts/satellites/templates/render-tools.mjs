#!/usr/bin/env node
/**
 * Renders the "Tools" table of a satellite README from the adapter JSON.
 *
 * This file is copied verbatim into every satellite repository as
 * scripts/render-tools.mjs, where the daily sync workflow runs it after
 * pulling a newer adapter JSON. The generator in the main repository imports
 * the same function, so the table a satellite ships with and the table its
 * sync job writes can never disagree.
 *
 *   node scripts/render-tools.mjs            # rewrite README.md (and docs/README.*.md)
 *   node scripts/render-tools.mjs --check    # exit 1 if a table is out of date
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const START = '<!-- tools:start (generated from adapter/*.json, do not edit) -->';
export const END = '<!-- tools:end -->';

const HEADINGS = {
  en: { tool: 'Tool', what: 'What it does', access: 'Access', read: 'read', write: 'write', depends: 'as the DB user allows' },
  de: { tool: 'Tool', what: 'Funktion', access: 'Zugriff', read: 'lesen', write: 'schreiben', depends: 'je nach DB-Rechten' },
  it: { tool: 'Tool', what: 'Cosa fa', access: 'Accesso', read: 'lettura', write: 'scrittura', depends: 'secondo i permessi del DB' },
  nl: { tool: 'Tool', what: 'Wat het doet', access: 'Toegang', read: 'lezen', write: 'schrijven', depends: 'volgens de DB-rechten' },
};

/** First sentence of a tool description, trimmed for a table cell. */
export function summarize(description = '') {
  const flat = description.replace(/\s+/g, ' ').trim();
  const cut = flat.match(/^(.+?[.!?])(\s|$)/);
  let s = cut ? cut[1] : flat;
  if (s.length > 160) s = `${s.slice(0, 157).replace(/\s+\S*$/, '')}…`;
  return s.replace(/\|/g, '\\|');
}

const READ_NAME = /(^|_)(list|get|search|find|read|count|describe|fields|schema|examples|matching|suggest|ids|participations|status|me|privileges)(_|$)/;
const WRITE_NAME = /(^|_)(create|update|delete|write|cancel|submit|set|batch|call|send|upload|approve|workflow|remove|add)(_|$)/;

/**
 * 'read' or 'write' for one tool. An explicit readOnlyHint wins.
 * Otherwise the protocol decides where it can (HTTP GET, GraphQL query, static
 * payload); a POST-based read API such as Odoo's JSON-2 or Shopware's Store
 * API falls back to the tool name. A database tool that runs SQL written by
 * the model is 'read': the engine only runs a single SELECT unless the
 * connector is switched to read-write.
 */
export function access(tool, connectorType = 'REST') {
  const hint = tool.annotations?.readOnlyHint;
  if (typeof hint === 'boolean') return hint ? 'read' : 'write';
  const type = String(connectorType).toUpperCase();
  const raw = String(tool.endpointMapping?.method ?? '');
  const method = raw.toUpperCase();
  if (raw === 'static') return 'read';
  if (type === 'DATABASE') {
    // Database connectors are read-only unless switched off per connector:
    // the engine runs a single SELECT and blocks writes, so SQL supplied at
    // call time reads too. A fixed statement that writes is a write tool.
    const sql = String(tool.endpointMapping?.path ?? '').replace(/--[^\n]*/g, ' ');
    if (/^\s*\$\{\w+\}\s*$/.test(sql)) return 'read';
    if (/\b(insert|update|delete|drop|truncate|alter|create|merge|grant|revoke)\b/i.test(sql)) return 'write';
    return 'read';
  }
  if (type === 'GRAPHQL') return method === 'MUTATION' ? 'write' : 'read';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  if (['PUT', 'PATCH', 'DELETE'].includes(method)) return 'write';
  if (WRITE_NAME.test(tool.name)) return 'write';
  return READ_NAME.test(tool.name) ? 'read' : 'write';
}

export function renderToolsTable(adapters, lang = 'en') {
  const h = HEADINGS[lang] ?? HEADINGS.en;
  const multi = adapters.length > 1;
  const blocks = adapters.map((a) => {
    const rows = a.tools.map(
      (t) => `| \`${t.name}\` | ${summarize(t.description)} | ${h[access(t, a.connector?.type)]} |`,
    );
    const table = [`| ${h.tool} | ${h.what} | ${h.access} |`, '|---|---|---|', ...rows].join('\n');
    return multi ? `#### ${a.name} (${a.tools.length})\n\n${table}` : table;
  });
  return `${START}\n${blocks.join('\n\n')}\n${END}`;
}

export function replaceBetweenMarkers(text, rendered) {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s) throw new Error('tools markers not found');
  return text.slice(0, s) + rendered + text.slice(e + END.length);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const adapterDir = join(root, 'adapter');
  const manifest = JSON.parse(readFileSync(join(root, 'satellite.json'), 'utf8'));
  const adapters = manifest.adapters.map((a) =>
    JSON.parse(readFileSync(join(adapterDir, `${a.slug}.json`), 'utf8')),
  );
  const files = [['README.md', 'en']];
  if (existsSync(join(root, 'docs'))) {
    for (const f of readdirSync(join(root, 'docs'))) {
      const m = f.match(/^README\.([a-z]{2})\.md$/);
      if (m) files.push([join('docs', f), m[1]]);
    }
  }
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [file, lang] of files) {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    if (!before.includes(START)) continue;
    const after = replaceBetweenMarkers(before, renderToolsTable(adapters, lang));
    if (after !== before) {
      stale = true;
      if (!check) writeFileSync(path, after);
      console.log(`${check ? 'stale' : 'updated'}: ${file}`);
    }
  }
  if (check && stale) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
