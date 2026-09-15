#!/usr/bin/env node
/**
 * Render docs/assets/banner.html to the two images the project shows publicly:
 *
 *   docs/assets/banner.png          1600x640 — top of the README
 *   docs/assets/social-preview.png  1280x640 — GitHub social preview / OG image
 *
 * The claims (licence, adapter count) live in the HTML, and the adapter count
 * is substituted from the real catalog, so the banner can never again say
 * "36+ connectors" while the catalog says 188.
 *
 *   node scripts/generate-banner.mjs
 *
 * Needs Google Chrome (headless) and network access for the webfonts.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'docs/assets');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error(
    'Google Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.',
  );
  process.exit(1);
}

// Real catalog count — same source as scripts/adapter-count.mjs.
const { adapters, keyless } = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'scripts/adapter-count.mjs')], {
    encoding: 'utf8',
  }),
);

const icon = (name) =>
  readFileSync(join(ASSETS, `icons/clients/${name}.svg`), 'utf8').trim();

const html = readFileSync(join(ASSETS, 'banner.html'), 'utf8')
  .replace(/\{\{ADAPTERS\}\}/g, String(adapters))
  .replace(/\{\{KEYLESS\}\}/g, String(keyless))
  .replace(/\{\{ICON_CLAUDE\}\}/g, icon('claude'))
  .replace(/\{\{ICON_CHATGPT\}\}/g, icon('chatgpt'))
  .replace(/\{\{ICON_COPILOT\}\}/g, icon('copilot'))
  .replace(/\{\{ICON_CURSOR\}\}/g, icon('cursor'));

const work = mkdtempSync(join(tmpdir(), 'amcp-banner-'));
const page = join(work, 'banner.html');
writeFileSync(page, html);

// Render at 2x and downscale: Chrome's --screenshot has no DPR flag, and a
// straight 1x render leaves the serif display edges ragged.
const SCALE = 2;
const shot = join(work, 'banner@2x.png');
execFileSync(
  chrome,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + SCALE,
    `--window-size=1600,500`,
    `--screenshot=${shot}`,
    '--virtual-time-budget=6000',
    'file://' + page,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const magick = (args) => execFileSync('magick', args, { stdio: 'inherit' });

// README banner: 1600x500 (3.2:1). Wider than 2.5:1 on purpose — at
// GitHub's ~830px column every 100px of banner height is 100px the demo GIF
// below it does not get.
magick([shot, '-resize', '1600x500', '-strip', join(ASSETS, 'banner.png')]);

// Social preview / OG: 1280x640 (GitHub's 2:1 slot). Scale the whole 2.5:1
// banner down and letterbox it — cropping to 2:1 would cut the headline on one
// side and the client list on the other, which is exactly what a preview card
// needs to show.
magick([
  shot,
  '-resize', '1280x400',
  '-background', '#05070f',
  '-gravity', 'center',
  '-extent', '1280x640',
  '-strip',
  join(ASSETS, 'social-preview.png'),
]);

console.log(
  `banner.png (1600x500) and social-preview.png (1280x640) written with "${adapters} connectors, ${keyless} keyless".`,
);
