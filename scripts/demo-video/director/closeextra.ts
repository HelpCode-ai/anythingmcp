/** Leaves exactly one window of the recording profile open (the demo page). */
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const pages = browser.contexts()[0].pages().filter((p) => !p.url().startsWith('devtools://'));
const keep = pages.find((p) => /\/connectors\/cmc_|claude\.ai/.test(p.url())) ?? pages[0];
for (const p of pages) if (p !== keep) { console.log('closing', p.url()); await p.close(); }
process.exit(0);
