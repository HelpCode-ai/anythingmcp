/**
 * Runs one scene.
 *
 *   npx tsx run.ts <scene>          record: real Chrome window, real cursor.
 *                                   Start Recordly, then press Ctrl+Option+G in
 *                                   the demo window to begin the take.
 *   npx tsx run.ts <scene> --dry    check: headless, synthetic input, screenshots.
 */
import { chromium, Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { Human } from './lib/human';
import { CONTENT, focusRecordingWindow, noAutocomplete, openRecordingWindow, useEnglish } from './lib/browser';
import { Scene, SceneScript } from './lib/scene';
import { hideClaudeNudges, maskCloudIdentity, signIn } from './lib/session';
import { etsyUi, openapiUi, sapUi } from './scenes/web';
import { connectClaude, etsyClaude, finaleClaude, sapClaude } from './scenes/claude';

const SCENES: Record<string, SceneScript> = {
  'etsy-ui': etsyUi,
  'sap-ui': sapUi,
  'openapi-ui': openapiUi,
  'etsy-claude': etsyClaude,
  'sap-claude': sapClaude,
  'finale-claude': finaleClaude,
  'connect-claude': connectClaude,
};

const [name, flag] = process.argv.slice(2);
const script = SCENES[name];
if (!script) {
  console.error(`Scenes: ${Object.keys(SCENES).join(', ')}`);
  process.exit(1);
}
const dry = flag === '--dry';

if (script.stage) {
  await fetch(`http://127.0.0.1:4100/__demo/stage/${script.stage}`, { method: 'POST' });
}

if (dry) {
  const out = `/tmp/lumen-dry/${name}`;
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: CONTENT, locale: 'en-US' });
  await signIn(context);
  const page = await context.newPage();
  let n = 0;
  const shot = async (label: string) => page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${label}.png` });
  page.on('framenavigated', (f) => f === page.mainFrame() && console.log('  →', f.url()));
  await page.goto(script.start, { waitUntil: 'networkidle' });
  try {
    await script.run(new Scene(page, null));
    await shot('end');
    console.log(`dry run ok, screenshots in ${out}`);
  } catch (err) {
    await shot('failed');
    console.error(`dry run failed: ${(err as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
  await browser.close();
} else {
  const { browser, page } = await openRecordingWindow(script.start);
  await useEnglish(page);
  await noAutocomplete(page);
  await signIn(page.context());
  await maskCloudIdentity(page.context());
  await hideClaudeNudges(page.context());
  // A scene with its own setup leaves the page where the take starts.
  if (script.prepare) await script.prepare(page);
  else await page.goto(script.start, { waitUntil: 'networkidle' });
  await page.bringToFront();
  const human = new Human();
  // Park the cursor in the lower right of the window while Recordly starts.
  const w = await page.evaluate(() => ({ x: screenX, y: screenY, h: outerHeight - innerHeight }));
  await human.moveTo(w.x + CONTENT.width - 120, w.y + w.h + CONTENT.height - 120);
  await waitForGo(page);
  await focusRecordingWindow(page);
  await human.pause(900, 1200);
  await script.run(new Scene(page, human));
  console.log('Take finished: stop the Recordly recording.');
  human.close();
  await browser.close(); // disconnects; the window stays open
}

/** Blocks until Ctrl+Option+G is pressed in the recording window. */
async function waitForGo(page: Page): Promise<void> {
  console.log('Start Recordly, then press Ctrl+Option+G in the demo window.');
  // A string, not a function: tsx adds esbuild's __name helper to named
  // arrow functions, and it does not exist in the page.
  await page.evaluate(`new Promise((resolve) => {
    window.addEventListener('keydown', function on(e) {
      if (e.ctrlKey && e.altKey && e.code === 'KeyG') {
        window.removeEventListener('keydown', on, true);
        e.preventDefault();
        resolve();
      }
    }, true);
  })`);
}
