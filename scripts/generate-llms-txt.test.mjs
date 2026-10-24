import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { absoluteLink, cleanMarkdown, collectDocuments, EXCLUDED_DOCS, generate, rewriteLinks } from './generate-llms-txt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function createFixture(t) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'amcp-llms-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const paths = collectDocuments().flatMap(section => section.paths);
  for (const path of new Set([...paths, ...EXCLUDED_DOCS, 'package.json', 'scripts/generate-llms-txt.mjs'])) {
    mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
    cpSync(resolve(ROOT, path), resolve(fixture, path));
  }
  return fixture;
}

function assertDocsCovered(root) {
  const scan = dir => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? scan(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
  const included = collectDocuments(root).flatMap(section => section.paths).filter(path => path.startsWith('docs/'));
  assert.deepEqual([...included, ...EXCLUDED_DOCS].sort(), scan('docs').sort(),
    'Every docs/**/*.md must be included in SECTIONS or explicitly listed in EXCLUDED_DOCS');
}

test('every docs/**/*.md is included or explicitly excluded, including newly nested docs', t => {
  assertDocsCovered(ROOT);
  const fixture = createFixture(t);
  assertDocsCovered(fixture);
  mkdirSync(resolve(fixture, 'docs/future/nested'), { recursive: true });
  writeFileSync(resolve(fixture, 'docs/future/nested/new-guide.md'), '# A new guide\n');
  assert.throws(() => assertDocsCovered(fixture), /docs\/future\/nested\/new-guide\.md/);
});

test('index covers the requested files in stable order with existing raw links', () => {
  const sections = collectDocuments();
  assert.deepEqual(sections.map(s => s.title), [
    'Getting started', 'Connectors', 'AI clients', 'Operations and security', 'Reference', 'Contributing', 'Optional',
  ]);
  const paths = sections.flatMap(s => s.paths);
  assert.equal(paths.length, new Set(paths).size);
  assert.ok(paths.length > 30);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(sections.find(section => section.title === 'Reference').paths.includes('docs/memory.md'));
  for (const path of EXCLUDED_DOCS) assert.ok(!paths.includes(path), path);
  assert.ok(!paths.some(p => p.startsWith('content/') || /^README\.[^.]+\.md$/.test(p)));
  const outputs = generate();
  assert.deepEqual(outputs, generate());
  const links = [...outputs['llms.txt'].matchAll(/\]\(https:\/\/raw\.githubusercontent\.com\/HelpCode-ai\/anythingmcp\/main\/([^)]*)\)/g)];
  assert.deepEqual(links.map(m => m[1]), paths);
  for (const [, path] of links) assert.ok(existsSync(resolve(ROOT, path)), path);
  const description = JSON.parse(readFileSync(resolve(ROOT, 'package.json'))).description;
  assert.ok(outputs['llms.txt'].startsWith(`# AnythingMCP\n\n> ${description}\n`));
  let offset = 0;
  for (const path of paths) {
    const next = outputs['llms-full.txt'].indexOf(`## ${path}\n`, offset);
    assert.ok(next >= offset, path);
    offset = next + 1;
  }
  for (const content of Object.values(outputs)) assert.ok(!content.includes('\r'));
  for (const line of outputs['llms.txt'].split('\n').filter(line => line.startsWith('- ['))) {
    assert.ok(line.slice(line.indexOf('): ') + 3).length <= 160, line);
  }
});

test('full text has no images or relative inline/reference Markdown links', () => {
  const full = generate()['llms-full.txt'];
  assert.doesNotMatch(full, /<\/?(?:picture|img)\b|!\[/i);
  for (const [, url] of full.matchAll(/\]\(<?([^\s)>]+)/g)) {
    assert.match(url, /^(?:[a-z][a-z\d+.-]*:|\/\/)/i, url);
  }
  for (const [, url] of full.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)/gm)) {
    assert.match(url, /^(?:[a-z][a-z\d+.-]*:|\/\/)/i, url);
  }
  assert.match(full, /# AnythingMCP: self-hosted MCP gateway/);
  assert.match(full, /AnythingMCP is an open-source, self-hosted MCP gateway/);
  assert.match(full, /### How do I create a custom connector for Claude\?/);
  assert.match(full, /## docs\/memory\.md\n/);
  assert.doesNotMatch(full, /## docs\/operations\/(?:card-trial-offer|signup-attribution)\.md\n|&nbsp;/);
  assert.ok(full.includes('CREATE USER AMCP_READER PASSWORD "<strong password>"'));
  assert.ok(full.includes('filter=userName eq "<a random guid>"'));
  assert.ok(full.includes('<wsse:Security><!-- redacted --></wsse:Security>'));
  assert.doesNotMatch(full, /star-history\.com|badges\/banner\.png/);
});

test('retains existing fenced examples verbatim across the selected repository docs', () => {
  let examples = 0;
  for (const { paths } of collectDocuments()) {
    for (const path of paths) {
      const source = readFileSync(resolve(ROOT, path), 'utf8').replace(/\r\n?/g, '\n');
      const rendered = cleanMarkdown(source, path);
      // An independent extraction checks the real examples, in addition to
      // the synthetic delimiter edge cases below.
      for (const [block] of source.matchAll(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm)) {
        assert.ok(rendered.includes(block), `Changed code example in ${path}: ${block.slice(0, 80)}`);
        examples++;
      }
    }
  }
  assert.ok(examples > 50, `Audited ${examples} fenced examples`);
});

test('rewrites fragments, nested paths, reference links and balanced destinations', () => {
  const source = 'docs/connectors/rest.md';
  const github = 'https://github.com/HelpCode-ai/anythingmcp/blob/main/';
  assert.equal(absoluteLink('../guides.md#setup', source), `${github}docs/guides.md#setup`);
  assert.equal(absoluteLink('#auth', source), `${github}${source}#auth`);
  assert.equal(absoluteLink('/README.md', source), `${github}README.md`);
  const markdown = '[API](../api-reference.md "API docs")\n[Guide](../guide_(new).md#intro)\n[ref]: <../../README.md#setup> "README"\n[Email](mailto:test@example.com)';
  const result = rewriteLinks(markdown, source);
  assert.ok(result.includes(`[API](<${github}docs/api-reference.md> "API docs")`));
  assert.ok(result.includes(`[Guide](<${github}docs/guide_(new).md#intro>)`));
  assert.ok(result.includes(`[ref]: <${github}README.md#setup> "README"`));
  assert.ok(result.includes('[Email](<mailto:test@example.com>)'));
  const titled = rewriteLinks('[Draft](<../guide_(draft.md> "Notes (draft")', source);
  assert.equal(titled, `[Draft](<${github}docs/guide_(draft.md> "Notes (draft")`);
  assert.equal(rewriteLinks('[API](../api.md (Reference))', source), `[API](<${github}docs/api.md> (Reference))`);
});

test('removes linked/reference images and HTML blocks without losing text or placeholders', () => {
  const input = '# Heading\n\nA useful paragraph with `LOGIN_TOKEN` and `/mcp/<serverId>`.\n\n' +
    '<picture><source srcset="banner.svg"><img src="banner.png"></picture>\n' +
    '<div>HTML-only content</div>\n<img src="logo.svg" />\n' +
    '<!-- a comment --><iframe src="https://example.com">Embedded content</iframe>\n' +
    '[![badge](badge.svg)](https://example.com) ![alt][logo]\n' +
    '<details>\n<summary>More</summary>\n\nKeep this Markdown.\n</details>\n' +
    '<https://example.com> [Keep](../README.md)\n';
  const output = cleanMarkdown(input, 'docs/example.md');
  assert.doesNotMatch(output, /badge|HTML-only|Embedded content|<!--|<iframe|<picture|<img|!\[/);
  assert.ok(output.includes('Keep this Markdown.'));
  assert.ok(output.includes('### More'));
  assert.ok(output.includes('/mcp/<serverId>'));
  assert.ok(output.includes('<https://example.com>'));
});

test('preserves fenced and inline code instead of interpreting examples as HTML or links', () => {
  const samples = [
    '```html\n<p>Keep this exact code example.</p>\n\n\n<div>Still code.</div>\n```',
    '~~~markdown\n[Example](../README.md)\n[ref]: ../example.md\n~~~',
    '````markdown\n```html\n<p>Nested fence example</p>\n```\n`````',
    '```html\n<p>An unclosed fence is still a code block.</p>',
    '`handlers[index](value)` and ``a `literal` [link](../file.md)``',
    '`unmatched opener\n\n```html\n<p>Still a fenced example.</p>\n```\n\nafter`',
  ];
  for (const sample of samples) {
    assert.equal(cleanMarkdown(sample, 'docs/example.md'), sample);
    assert.equal(rewriteLinks(sample, 'docs/example.md'), sample);
  }
  const mixed = 'Use `[example](../README.md)` or [the README](../README.md).';
  const output = cleanMarkdown(mixed, 'docs/example.md');
  assert.ok(output.includes('`[example](../README.md)`'));
  assert.ok(output.includes('[the README](<https://github.com/HelpCode-ai/anythingmcp/blob/main/README.md>)'));
  assert.equal(cleanMarkdown('Before <img alt="a > b" src="logo.svg"> after', 'docs/example.md'), 'Before  after');
  assert.equal(cleanMarkdown('A&nbsp;B and `&nbsp;`\n\n```html\n&nbsp;\n```', 'docs/example.md'),
    'A B and `&nbsp;`\n\n```html\n&nbsp;\n```');
  assert.equal(cleanMarkdown('A\n\n&nbsp;\n\nB', 'docs/example.md'), 'A\n\nB');
});

test('CLI resolves its own root, detects changed or missing output, and regenerates deterministically', t => {
  const fixture = createFixture(t);
  const run = (...args) => spawnSync(process.execPath, [resolve(fixture, 'scripts/generate-llms-txt.mjs'), ...args],
    { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(run('--check').status, 1);
  assert.equal(run().status, 0);
  const first = readFileSync(resolve(fixture, 'llms-full.txt'));
  assert.equal(run().status, 0);
  assert.deepEqual(readFileSync(resolve(fixture, 'llms-full.txt')), first);
  assert.equal(run('--check').status, 0);
  const doc = resolve(fixture, 'docs/guides.md');
  writeFileSync(doc, readFileSync(doc, 'utf8') + '\nA new documentation paragraph.\n');
  const stale = run('--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /llms-full.txt is stale/);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(resolve(fixture, 'docs/connectors/aaa-new.md'), '# New connector\r\n\r\nA newly added connector guide.\r\n');
  assert.equal(run('--check').status, 1);
  assert.equal(run().status, 0);
  const expanded = readFileSync(resolve(fixture, 'llms.txt'), 'utf8');
  assert.ok(expanded.indexOf('aaa-new.md') < expanded.indexOf('docs/connectors/database.md'));
  assert.ok(expanded.includes(': A newly added connector guide.'));
  assert.equal(run('--check').status, 0);
  writeFileSync(resolve(fixture, 'docs/connectors/title.md'), '# A [label] \\path &amp;lt;iframe&gt;\n\nA title with special characters.\n');
  assert.equal(run().status, 0);
  const titled = readFileSync(resolve(fixture, 'llms.txt'), 'utf8');
  assert.ok(titled.includes('A \\[label\\] \\\\path &lt;iframe>'));
  // Byte checks also reject CRLF artifacts rather than silently accepting drift.
  const index = resolve(fixture, 'llms.txt');
  writeFileSync(index, readFileSync(index, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(run('--check').status, 1);
  assert.equal(run('--unknown').status, 1);
});

test('CLI checks and regenerates output when invoked through symlinks', t => {
  const fixture = createFixture(t);
  const alias = resolve(fixture, 'linked-scripts');
  // Junctions exercise symlinked parents on Windows without symlink privileges;
  // this also covers macOS paths such as /var -> /private/var.
  symlinkSync(resolve(fixture, 'scripts'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const entries = [resolve(alias, 'generate-llms-txt.mjs')];
  if (process.platform !== 'win32') {
    const fileAlias = resolve(fixture, 'generate-link.mjs');
    symlinkSync(resolve(fixture, 'scripts/generate-llms-txt.mjs'), fileAlias);
    entries.push(fileAlias);
  }
  for (const entry of entries) {
    const run = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: tmpdir(), encoding: 'utf8' });
    rmSync(resolve(fixture, 'llms.txt'), { force: true });
    const missing = run('--check');
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /llms\.txt is stale/);
    const generated = run();
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /Generated llms-full\.txt/);
    assert.equal(run('--check').status, 0);
    writeFileSync(resolve(fixture, 'llms-full.txt'), 'stale output');
    const stale = run('--check');
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /llms-full\.txt is stale/);
  }
});
