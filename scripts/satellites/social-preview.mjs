#!/usr/bin/env node
/**
 * Social preview images (1280x640) for satellite repositories, in the same
 * visual language as docs/assets/banner.html. GitHub has no API to set them:
 * upload each file under Settings → Social preview.
 *
 *   node scripts/satellites/social-preview.mjs --only weclapp-mcp-server,soap-to-mcp
 *
 * Writes scripts/satellites/out/social/<repo>.png. Needs Google Chrome and
 * ImageMagick, like scripts/generate-banner.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE, ROOT, loadConfig, loadCatalog } from './lib.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const config = loadConfig();
const catalog = loadCatalog();
const sats = config.satellites.filter((s) => !only || only.includes(s.repo));

const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!chrome) throw new Error('Google Chrome not found; set CHROME_PATH');

const icon = (n) => readFileSync(join(ROOT, 'docs/assets/icons/clients', `${n}.svg`), 'utf8').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const MAINTAINER = { 'HelpCode-ai': 'helpcode.ai', kochfreiburg: 'KOCH Freiburg GmbH', keysersoft: '@keysersoft' };
const GENERIC_SUB = {
  soap: 'Any SOAP/WSDL service as MCP tools. No code.',
  sql: 'PostgreSQL, MySQL, SQL Server, Oracle, MongoDB. Read-only by default.',
  openapi: 'Every OpenAPI operation becomes an MCP tool. No code.',
  graphql: 'GraphQL queries and mutations as MCP tools. No code.',
  postman: 'Every request in a collection becomes an MCP tool.',
};

function content(sat) {
  const adapters = (sat.adapters ?? []).map((s) => catalog.get(s)?.adapter).filter(Boolean);
  const tools = adapters.reduce((n, a) => n + a.tools.length, 0);
  if (sat.type === 'generic') return { title: `<em>${esc(sat.system)}</em> to MCP`, sub: GENERIC_SUB[sat.kind] ?? '' };
  if (sat.type === 'umbrella') return { title: `<em>${esc(sat.system)}</em> MCP Server`, sub: `${adapters.length} systems, ${tools} tools, one MCP endpoint.` };
  return { title: `<em>${esc(sat.system)}</em> MCP Server`, sub: `${tools} tools for Claude, ChatGPT, Copilot and Cursor.` };
}

const page = (sat) => {
  const { title, sub } = content(sat);
  const long = sat.system.length > 14;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;1,9..144,500&family=Geist+Mono:wght@500&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;width:1280px;height:640px;background:#05070f;color:#f2f5fa;font-family:Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .b{position:relative;width:1280px;height:640px;box-sizing:border-box;padding:84px 96px;
     background:radial-gradient(1100px 520px at 12% 8%,rgba(33,89,224,.28),transparent 60%),linear-gradient(160deg,#0b1220 42%,#05070f 100%)}
  .k{font-family:"Geist Mono",monospace;font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:rgba(226,232,240,.68);display:flex;align-items:center;gap:14px}
  .dot{width:11px;height:11px;border-radius:50%;background:#34d399;box-shadow:0 0 14px #34d399}
  h1{font-family:Fraunces,Georgia,serif;font-weight:400;font-size:${long ? 84 : 100}px;line-height:1.02;margin:44px 0 26px;letter-spacing:-.02em}
  h1 em{font-style:italic;font-weight:500;background:linear-gradient(90deg,#60a5fa,#a5b4fc);-webkit-background-clip:text;color:transparent}
  .s{font-size:34px;color:rgba(226,232,240,.72);max-width:1000px;line-height:1.3}
  .foot{position:absolute;left:96px;right:96px;bottom:72px;display:flex;align-items:center;justify-content:space-between}
  .w{display:flex;align-items:center;gap:16px;font-size:30px;font-weight:600}
  .w svg{width:46px;height:46px}
  .w small{font-weight:400;color:rgba(226,232,240,.6);font-size:24px;margin-right:4px}
  .c{display:flex;gap:18px}
  .c span{width:58px;height:58px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center}
  .c svg{width:32px;height:32px}
</style></head><body><div class="b">
  <div class="k"><span class="dot"></span>Open source · AGPL-3.0 · ${esc(MAINTAINER[sat.owner] ?? sat.owner)}</div>
  <h1>${title}</h1>
  <div class="s">${esc(sub)}</div>
  <div class="foot">
    <div class="w"><small>Powered by</small><svg viewBox="0 0 52 52" fill="none"><line x1="26" y1="26" x2="26" y2="9" stroke="#60a5fa" stroke-width="1.5" opacity=".55"/><line x1="26" y1="26" x2="10" y2="40" stroke="#60a5fa" stroke-width="1.5" opacity=".55"/><line x1="26" y1="26" x2="42" y2="40" stroke="#60a5fa" stroke-width="1.5" opacity=".55"/><circle cx="26" cy="9" r="5" fill="#60a5fa" opacity=".65"/><circle cx="10" cy="40" r="5" fill="#60a5fa" opacity=".65"/><circle cx="42" cy="40" r="5" fill="#60a5fa" opacity=".65"/><circle cx="26" cy="26" r="10" fill="#60a5fa"/><circle cx="26" cy="26" r="5.5" fill="#05070f"/></svg>AnythingMCP</div>
    <div class="c"><span>${icon('claude')}</span><span>${icon('chatgpt')}</span><span>${icon('copilot')}</span><span>${icon('cursor')}</span></div>
  </div>
</div></body></html>`;
};

const out = join(HERE, 'out', 'social');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'sat-social-'));
for (const sat of sats) {
  const html = join(work, `${sat.repo}.html`);
  const shot = join(work, `${sat.repo}@2x.png`);
  writeFileSync(html, page(sat));
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1280,640', `--screenshot=${shot}`, '--virtual-time-budget=6000', `file://${html}`], { stdio: 'ignore' });
  execFileSync('magick', [shot, '-resize', '1280x640', '-strip', join(out, `${sat.repo}.png`)]);
  console.log(`out/social/${sat.repo}.png`);
}
