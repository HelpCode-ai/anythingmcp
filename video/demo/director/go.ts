/** Starts a waiting take from outside the window (same as Ctrl+Option+G in it). */
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://localhost') || p.url().startsWith('https://claude.ai'))!;
await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, altKey: true, code: 'KeyG', key: 'g' }))`);
process.exit(0);
