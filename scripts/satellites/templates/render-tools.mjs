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
  // "e.g." and "i.e." do not end a sentence.
  const cut = flat.match(/^(.+?(?<!\b(?:e\.g|i\.e))[.!?])(\s|$)/);
  let s = cut ? cut[1] : flat;
  if (s.length > 160) s = `${s.slice(0, 157).replace(/\s+\S*$/, '')}…`;
  // Escape backslashes first, then pipes, so a description can't end a cell early.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
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

/**
 * The five generic OData tools AnythingMCP adds when it installs an ODATA
 * adapter, or a REST adapter with `connector.config.odata`. They are not in
 * the adapter JSON, so they are listed here to keep the table and the tool
 * count equal to what the connector store shows. Names follow the product:
 * `config.odata.toolPrefix`, else the slug plus `_odata`.
 */
export function odataBuiltins(adapter) {
  const type = String(adapter.connector?.type ?? '').toUpperCase();
  const odata = adapter.connector?.config?.odata;
  if (type !== 'ODATA' && !(type === 'REST' && odata && typeof odata === 'object')) return [];
  let prefix = odata?.toolPrefix;
  if (!/^[a-z][a-z0-9_]*$/.test(prefix ?? '')) {
    const base = String(adapter.slug ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('_') || 'odata';
    prefix = base.includes('odata') ? base : `${base}_odata`;
  }
  const sap = odata?.sap === true || !!odata?.sapClient;
  const listed = Array.isArray(odata?.services) && odata.services.length > 0;
  const tool = (suffix, description) => ({ name: `${prefix}_${suffix}`, description, annotations: { readOnlyHint: true } });
  return [
    tool(
      'list_services',
      sap
        ? 'List the OData services published by the SAP Gateway (V2 and V4 catalog), filtered by words in their name, title or description.'
        : listed
          ? 'List the OData services this connector reaches.'
          : 'Where the OData service lives.',
    ),
    tool('describe_service', 'The entity sets of an OData service with their business labels, keys and whether they are analytical or parameterised.'),
    tool('describe_entity', 'The fields of one entity set: labels, types, keys, the currency or unit field of each amount, dimensions and measures, and required filters.'),
    tool('query', 'Read rows from an entity set, with field names checked against the service model and server paging followed.'),
    tool('get_entity', 'Read one entity by its key, optionally with related entities.'),
  ];
}

/** Every tool the installed connector has: the OData built-ins first, as in the product, then the adapter's own. */
export function allTools(adapter) {
  const own = new Set(adapter.tools.map((t) => t.name));
  return [...odataBuiltins(adapter).filter((t) => !own.has(t.name)), ...adapter.tools];
}

export function renderToolsTable(adapters, lang = 'en') {
  const h = HEADINGS[lang] ?? HEADINGS.en;
  const multi = adapters.length > 1;
  const blocks = adapters.map((a) => {
    const tools = allTools(a);
    const rows = tools.map(
      (t) => `| \`${t.name}\` | ${summarize(t.description)} | ${h[access(t, a.connector?.type)]} |`,
    );
    const table = [`| ${h.tool} | ${h.what} | ${h.access} |`, '|---|---|---|', ...rows].join('\n');
    return multi ? `#### ${a.name} (${tools.length})\n\n${table}` : table;
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
