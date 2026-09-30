/**
 * The recording browser: the installed Google Chrome, started with a
 * dedicated profile (so no bookmarks, extensions or other logins show up) in
 * app mode (no tabs or address bar), at a fixed 16:9 content size, with a
 * DevTools port so the director can read element positions.
 *
 * Chrome is launched normally, not by Playwright, so it carries no
 * "controlled by automated software" bar and no navigator.webdriver flag.
 */
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium, Browser, Page, Locator } from 'playwright-core';
import type { Box } from './human';

export const CONTENT = { width: 1600, height: 900 };
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.homedir(), '.lumen-demo-chrome');
const PORT = 9333;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openRecordingWindow(url: string): Promise<{ browser: Browser; page: Page }> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch {
    spawn(
      CHROME,
      [
        `--user-data-dir=${PROFILE}`,
        `--remote-debugging-port=${PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,AutofillServerCommunication',
        '--hide-crash-restore-bubble',
        `--window-position=40,60`,
        `--window-size=${CONTENT.width},${CONTENT.height + 40}`,
        `--app=${url}`,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
    for (let i = 0; i < 40 && !browser; i++) {
      await sleep(250);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
    }
    if (!browser) throw new Error('Chrome did not open its DevTools port.');
  }
  const context = browser.contexts()[0];
  // Chrome sometimes opens a regular new-tab window next to the app window;
  // only the demo page may be on screen.
  const origin = new URL(url).origin;
  const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
  let page = pages.find((p) => p.url().startsWith(origin)) ?? pages[0] ?? (await context.newPage());
  // Exactly one window on screen: a leftover from an earlier take would sit
  // behind or in front of the recording.
  for (const p of pages) if (p !== page) await p.close().catch(() => {});
  if (!page.url().startsWith(url.split('?')[0].replace(/\/$/, ''))) await page.goto(url);
  await moveToRetina(page);
  await fitContent(page);
  return { browser, page };
}

/**
 * Serve the page in US English whatever the Mac's language: claude.ai picks
 * its UI language from the browser locale. Holds for as long as the director
 * stays connected, which covers the whole take.
 */
export async function useEnglish(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: (await page.evaluate('navigator.userAgent')) as string,
    acceptLanguage: 'en-US,en',
    platform: 'MacIntel',
  });
  await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
  // Otherwise claude.ai puts a "Want to be notified when Claude responds?"
  // banner over the composer while an answer is running.
  await cdp.send('Browser.setPermission', {
    permission: { name: 'notifications' },
    setting: 'denied',
    origin: 'https://claude.ai',
  });
}

/**
 * No autocomplete dropdowns: Chrome's suggestion list opens under a field
 * being typed into and swallows the real click on the field below it.
 */
export async function noAutocomplete(page: Page): Promise<void> {
  await page.context().addInitScript(`(() => {
    const off = (root) => root.querySelectorAll && root.querySelectorAll('input, textarea').forEach((i) => {
      if (i.getAttribute('autocomplete') !== 'off') i.setAttribute('autocomplete', 'off');
    });
    new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(off)))
      .observe(document, { subtree: true, childList: true });
    document.addEventListener('DOMContentLoaded', () => off(document));
  })();`);
}

/**
 * Put the window on a 2x (Retina) display, so recordings come out at twice
 * CONTENT. With an external 1x monitor as the main display, Chrome would
 * otherwise open there and every take would be 1600×900.
 */
async function moveToRetina(page: Page): Promise<void> {
  const js = `ObjC.import("AppKit");
    const s = $.NSScreen.screens; const mainH = s.objectAtIndex(0).frame.size.height; let r = "";
    for (let i = 0; i < s.count; i++) { const sc = s.objectAtIndex(i); const f = sc.frame;
      if (sc.backingScaleFactor >= 2) { r = [f.origin.x, mainH - f.origin.y - f.size.height].join(" "); break; } }
    r`;
  const found = execSync(`osascript -l JavaScript -e '${js}'`).toString().trim();
  if (!found) return; // no Retina display attached: stay where we are
  const [left, top] = found.split(' ').map(Number);
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: left + 40, top: top + 60 } });
  await cdp.detach();
  await sleep(500);
}

/** Resize the window so the page content is exactly CONTENT, whatever the title bar. */
async function fitContent(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (let i = 0; i < 3; i++) {
    const m = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight }));
    if (m.iw === CONTENT.width && m.ih === CONTENT.height) break;
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: CONTENT.width + (m.ow - m.iw), height: CONTENT.height + (m.oh - m.ih) },
    });
    await sleep(300);
  }
  await cdp.detach();
}

/** A locator's box in global screen points, for the real cursor. */
export async function screenBox(page: Page, target: Locator): Promise<Box> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`Not visible: ${target}`);
  const w = await page.evaluate(() => ({
    sx: screenX,
    sy: screenY,
    chromeX: (outerWidth - innerWidth) / 2,
    chromeY: outerHeight - innerHeight,
  }));
  return { x: w.sx + w.chromeX + box.x, y: w.sy + w.chromeY + box.y, width: box.width, height: box.height };
}

/**
 * Make the recording window the frontmost window. A click on a window of an
 * app in the background only activates it, so without this the first click
 * of a take (with Recordly in front) would be lost. Activating Chrome can
 * also make it open a fresh new-tab window on top (macOS "reopen"), so stray
 * windows are closed afterwards and the demo page is raised.
 */
export async function focusRecordingWindow(page: Page): Promise<void> {
  const pid = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`).toString().trim().split('\n')[0];
  execSync(
    `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`,
  );
  await sleep(600);
  const origin = new URL(page.url()).origin;
  for (const p of page.context().pages()) {
    if (p !== page && !p.url().startsWith(origin) && !p.url().startsWith('devtools://')) await p.close().catch(() => {});
  }
  await page.bringToFront();
  await sleep(400);
}
