import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
for (const c of b.contexts()) for (const p of c.pages()) console.log(p.url());
