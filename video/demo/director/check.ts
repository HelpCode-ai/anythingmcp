/**
 * Headless smoke check of the simulated web app: visits every page the scenes
 * use and writes screenshots, so layout or unmocked calls show up before a
 * recording session.   npx tsx check.ts <outDir>
 */
import { chromium } from 'playwright-core';
import { APP, signIn } from './lib/session';

const out = process.argv[2] ?? '/tmp/lumen-check';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await signIn(context);
const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text().slice(0, 200)));
await fetch('http://127.0.0.1:4100/__demo/stage/all', { method: 'POST' });
for (const p of ['/connectors', '/connectors/store', '/connectors/new', '/connectors/cmc_etsy', '/mcp-server', '/mcp-server/srv_lumen']) {
  await page.goto(APP + p, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const name = p.replace(/\//g, '_').replace(/^_/, '') || 'root';
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('ok', p, '→', page.url());
}
await browser.close();
