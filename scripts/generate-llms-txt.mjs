#!/usr/bin/env node
// Repository documentation for AI clients. No runtime or website output.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/';
const GITHUB = 'https://github.com/HelpCode-ai/anythingmcp/blob/main/';
// Contributor credits and Cloud operator internals are not product guides.
export const EXCLUDED_DOCS = [
  'docs/AUTHORS.md',
  'docs/operations/card-trial-offer.md',
  'docs/operations/signup-attribution.md',
];
const SECTIONS = [
  ['Getting started', ['README.md', 'docs/deployment.md', 'docs/guides.md']],
  ['Connectors', ['docs/connectors/*.md', 'docs/tool-definition.md']],
  ['AI clients', ['docs/integrations/*.md']],
  ['Operations and security', ['docs/operations/*.md', 'docs/sso.md', 'docs/scim-entra-setup.md', 'docs/license-faq.md']],
  ['Reference', ['docs/api-reference.md', 'docs/mcp-resources.md', 'docs/knowledge-graph.md', 'docs/memory.md']],
  ['Contributing', ['.github/CONTRIBUTING.md', 'AGENTS.md']],
  ['Optional', ['docs/guides/*.md', 'docs/ROADMAP.md', 'docs/ADOPTERS.md']],
];
const DESCRIPTIONS = {
  'README.md': 'Run AnythingMCP locally, connect an AI client, and discover ready-made connectors.',
  'docs/deployment.md': 'Deploy AnythingMCP with Docker and configure authentication, networking, and production settings.',
  'docs/connectors/login-token-auth.md': 'Build connectors that exchange credentials for cached bearer tokens with automatic refresh and re-login.',
  'docs/api-reference.md': 'REST API reference for authentication, connectors, tools, MCP servers, and administration.',
  'docs/tool-definition.md': 'Define MCP tool parameters, endpoint mappings, response transforms, and adapter metadata.',
  'docs/operations/observability.md': 'Configure structured logging, Sentry error reporting, and Prometheus metrics for your deployment.',
  'docs/ROADMAP.md': 'Review current development priorities, planned features, and contribution opportunities.',
  'docs/guides/connect-sorare-to-chatgpt.md': 'Connect Sorare fantasy football tools to ChatGPT through AnythingMCP.',
  'docs/guides/connect-sorare-to-claude.md': 'Connect Sorare fantasy football tools to Claude Desktop and Claude Code.',
  'docs/guides/connect-sorare-to-cloud.md': 'Use AnythingMCP Cloud to connect the Sorare GraphQL API without a local server.',
  'docs/guides/connect-sorare-to-copilot.md': 'Use Sorare tools in GitHub Copilot Chat through an AnythingMCP MCP endpoint.',
  'docs/guides/connect-sorare-to-openclaw.md': 'Connect Sorare tools to the self-hosted OpenClaw AI assistant.',
  'docs/guides/sorare-to-mcp.md': 'Expose the Sorare GraphQL API as MCP tools for compatible AI clients.',
  'docs/license-faq.md': 'Understand the AGPL license, the commercial EE boundary, and contributor licensing.',
  '.github/CONTRIBUTING.md': 'Set up development, test changes, and submit a contribution.',
  'AGENTS.md': 'Repository instructions, setup commands, tests, and contribution boundaries for coding agents.',
};

// Hide code while rendering prose, then restore it verbatim. This keeps HTML
// snippets, Markdown examples, and significant blank lines out of the renderer.
function protectCode(markdown) {
  let prefix = '\u0000AMCP_CODE_';
  while (markdown.includes(prefix)) prefix += '_';
  const snippets = [];
  const save = text => `${prefix}${snippets.push(text) - 1}\u0000`;
  let text = '';
  let cursor = 0;
  let offset = 0;
  let fence;
  for (const line of markdown.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '');
    if (fence) {
      const close = content.match(/^[ \t]*(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        text += markdown.slice(cursor, fence.start) + save(markdown.slice(fence.start, offset + line.length));
        cursor = offset + line.length;
        fence = undefined;
      }
    } else {
      const open = content.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
        fence = { marker: open[1][0], length: open[1].length, start: offset };
      }
    }
    offset += line.length;
  }
  text += fence ? markdown.slice(cursor, fence.start) + save(markdown.slice(fence.start)) : markdown.slice(cursor);
  const runs = /`+/g;
  let output = '';
  cursor = 0;
  let open;
  while ((open = runs.exec(text))) {
    if (escapedAt(text, open.index)) continue;
    const closingRuns = /`+/g;
    closingRuns.lastIndex = runs.lastIndex;
    let close;
    while ((close = closingRuns.exec(text)) && close[0].length !== open[0].length) { /* exact delimiter size */ }
    if (!close) continue;
    // Inline spans cannot cross a fenced block's boundary.
    if (text.slice(open.index, closingRuns.lastIndex).includes(prefix)) continue;
    output += text.slice(cursor, open.index) + save(text.slice(open.index, closingRuns.lastIndex));
    cursor = closingRuns.lastIndex;
    runs.lastIndex = cursor;
  }
  output += text.slice(cursor);
  return {
    text: output,
    restore: rendered => rendered.replace(new RegExp(`${prefix}(\\d+)\u0000`, 'g'), (_, index) => snippets[Number(index)]),
  };
}

function escapedAt(text, index) {
  let backslashes = 0;
  while (index > 0 && text[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

// Render the HTML used by our Markdown docs without treating literal MCP
// placeholders or URL autolinks as tags. Block contents are intentionally
// omitted; details/summary wrappers retain the useful FAQ text.
function renderHtml(text, inline = false) {
  const blocks = new Set(['picture', 'p', 'div', 'table', 'iframe', 'script', 'style']);
  const tags = new Set(['a', 'strong', 'em', 'b', 'i', 'code', 'pre', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'source', 'img', 'details', 'summary']);
  const stack = [];
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(/<!--[\s\S]*?-->|<\/?[a-z](?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (!stack.length) output += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!--')) continue;
    const tag = match[0].match(/^<(\/?)([a-z][a-z\d]*)(?=[\s/>])/i);
    if (!tag) { if (!stack.length) output += match[0]; continue; }
    const name = tag[2].toLowerCase();
    if (blocks.has(name)) {
      if (!inline && !tag[1] && !match[0].endsWith('/>')) stack.push(name);
      else if (stack.at(-1) === name) stack.pop();
      continue;
    }
    if (stack.length) continue;
    if (!tags.has(name)) { output += match[0]; continue; }
    if (!inline && name === 'summary') output += tag[1] ? '\n' : '### ';
  }
  if (!stack.length) output += text.slice(cursor);
  return output;
}

function plain(text) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
  return renderHtml(text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), true)
    .replace(/[*`]/g, '').replace(/&(?:amp|lt|gt|nbsp);/g, entity => entities[entity])
    .replace(/\s+/g, ' ').trim();
}

// The repository root may have an OS alias (/var on macOS), but inputs below
// it must be ordinary files/directories, never links to local private content.
function repositoryPath(root, path, kind = 'file', allowMissing = false) {
  const base = realpathSync(root);
  const target = resolve(base, path);
  const prefix = base + sep;
  if (!target.startsWith(prefix)) throw new Error(`Refusing path outside the repository: ${path}`);
  let current = base;
  let stat;
  for (const part of relative(base, target).split(sep)) {
    current = resolve(current, part);
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (allowMissing && current === target && error.code === 'ENOENT') return target;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in repository path: ${path}`);
  }
  const canonical = realpathSync(target);
  if (!canonical.startsWith(prefix)) throw new Error(`Refusing path outside the repository: ${path}`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Expected a regular ${kind} in repository path: ${path}`);
  }
  return canonical;
}

export function collectDocuments(root = ROOT) {
  return SECTIONS.map(([title, patterns]) => ({
    title,
    paths: patterns.flatMap(pattern => {
      if (!pattern.includes('*')) {
        repositoryPath(root, pattern);
        return [pattern];
      }
      const dir = posix.dirname(pattern);
      const paths = [];
      for (const entry of readdirSync(repositoryPath(root, dir, 'directory'), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        repositoryPath(root, path, entry.isDirectory() ? 'directory' : 'file');
        if (entry.isFile() && entry.name.endsWith('.md')) paths.push(path);
      }
      return paths.sort();
    }).filter(path => !EXCLUDED_DOCS.includes(path)),
  }));
}

export function absoluteLink(target, source) {
  if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return target;
  const resolved = new URL(target, GITHUB + source);
  // A leading slash denotes a repository-root path in these Markdown docs.
  if (target.startsWith('/')) return GITHUB + target.slice(1);
  return resolved.href;
}

// Scan balanced labels/destinations, including linked badges and URLs with
// parentheses. Keep optional link titles and reference-link definitions.
export function rewriteLinks(markdown, source) {
  const code = protectCode(markdown);
  return code.restore(rewriteProseLinks(code.text, source));
}

function rewriteProseLinks(markdown, source) {
  const text = markdown.replace(/^( {0,3}\[[^\]\n]+\]:\s*)(<[^>]+>|\S+)(.*)$/gm,
    (_, prefix, url, suffix) => `${prefix}<${absoluteLink(url.replace(/^<|>$/g, ''), source)}>${suffix}`);
  let output = '';
  for (let i = 0; i < text.length;) {
    const image = text[i] === '!' && text[i + 1] === '[';
    const start = i + (image ? 1 : 0);
    if (text[start] !== '[' || escapedAt(text, i)) { output += text[i++]; continue; }
    let end = start + 1;
    let depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '[') depth++;
      if (text[end] === ']') depth--;
    }
    if (depth) { output += text[i++]; continue; }
    const label = text.slice(start + 1, end - 1);
    if (text[end] === '(') {
      let close = end + 1;
      depth = 1;
      let quote;
      let angle = false;
      for (; close < text.length && depth; close++) {
        if (text[close] === '\\') { close++; continue; }
        if (angle) { if (text[close] === '>') angle = false; continue; }
        if (quote) { if (text[close] === quote) quote = undefined; continue; }
        if (text[close] === '<' && depth === 1) { angle = true; continue; }
        if ((text[close] === '"' || text[close] === "'") && depth === 1 && /\s/.test(text[close - 1])) {
          quote = text[close]; continue;
        }
        if (text[close] === '(') depth++;
        if (text[close] === ')') depth--;
      }
      if (depth) { output += text[i++]; continue; }
      const destination = text.slice(end + 1, close - 1).match(/^\s*(<[^>]*>|\S+?)(\s+(?:"[\s\S]*"|'[\s\S]*'|\([\s\S]*\)))?\s*$/);
      if (!destination) { output += text[i++]; continue; }
      const cleanedLabel = rewriteProseLinks(label, source);
      if (!image && cleanedLabel.trim()) {
        const url = absoluteLink(destination[1].replace(/^<|>$/g, ''), source);
        output += `[${cleanedLabel}](<${url}>${destination[2] || ''})`;
      }
      i = close;
    } else if (image) {
      const reference = text.slice(end).match(/^\[[^\]\n]*\]/);
      i = end + (reference?.[0].length || 0);
    } else { output += text.slice(i, end); i = end; }
  }
  return output;
}

export function cleanMarkdown(markdown, source) {
  const code = protectCode(markdown.replace(/\r\n?/g, '\n'));
  let text = code.text;
  if (source === 'README.md') {
    text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, title) => `# ${plain(title)}\n`)
      .replace(/<p\b[^>]*>\s*<strong>(AnythingMCP[\s\S]*?)<\/strong>[\s\S]*?<\/p>/i,
        (_, summary) => `${plain(summary)}\n`);
  }
  text = renderHtml(text).replace(/&nbsp;/g, ' ');
  return code.restore(rewriteProseLinks(text, source).replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim());
}

function metadata(content, path) {
  const title = plain(content.match(/^#\s+(.+)$/m)?.[1] || posix.basename(path, '.md'));
  const paragraph = content.split(/\n\s*\n/).find(block => {
    const line = block.trim();
    return line && !/^(?:#|>|[-*]|\d+\.|\||```|~~~|\[)/.test(line);
  }) || title;
  const sentence = plain(paragraph).split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  const description = DESCRIPTIONS[path] || (sentence.length > 160
    ? sentence.slice(0, 157).replace(/\s+\S*$/, '') + '...' : sentence);
  return { title: title.replace(/[\\[\]]/g, char => `\\${char}`), description };
}

export function generate(root = ROOT) {
  const summary = JSON.parse(readFileSync(repositoryPath(root, 'package.json'), 'utf8')).description;
  const header = `# AnythingMCP\n\n> ${summary}\n`;
  let index = header;
  let full = header;
  for (const section of collectDocuments(root)) {
    index += `\n## ${section.title}\n\n`;
    for (const path of section.paths) {
      const content = cleanMarkdown(readFileSync(repositoryPath(root, path), 'utf8'), path);
      const { title, description } = metadata(content, path);
      index += `- [${title}](${RAW}${path}): ${description}\n`;
      full += `\n---\n\n## ${path}\n\nSource: ${RAW}${path}\n\n${content}\n`;
    }
  }
  return { 'llms.txt': index, 'llms-full.txt': full };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/generate-llms-txt.mjs [--check]');
    const check = process.argv.includes('--check');
    const outputs = Object.entries(generate()).map(([name, content]) =>
      [name, content, repositoryPath(ROOT, name, 'file', true)]);
    for (const [name, content, path] of outputs) {
      if (check) {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
          console.error(`${name} is stale. Run node scripts/generate-llms-txt.mjs and commit the result.`);
          process.exitCode = 1;
        }
      } else { writeFileSync(path, content, 'utf8'); console.log(`Generated ${name}`); }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
