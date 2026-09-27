#!/usr/bin/env node
/**
 * Render docs/assets/banner.html to the two images the project shows publicly:
 *
 *   banner.png          1600x500 — top of the README
 *   social-preview.png  1280x640 — GitHub social preview / OG image
 *   social-preview.json          — the counts printed on the social preview
 *
 * The claims (licence, adapter count) live in the HTML, and the counts are
 * substituted from the real catalog, so the banner can never again say
 * "36+ connectors" while the catalog says 188.
 *
 * The README banner shows the exact count. The social preview shows it rounded
 * down ("260+ connectors", "20+ of them need no API key"): GitHub has no API to
 * set a repository's social preview, so it is uploaded by hand, and a rounded
 * number stays true until the catalog crosses the next ten. The catalog-badges
 * workflow renders both on every catalog change, publishes them on the
 * `badges` branch (which the README reads) and opens an issue when the rounded
 * numbers change and a new social preview needs uploading.
 *
 *   node scripts/generate-banner.mjs [--out <dir>]   # default: docs/assets
 *
 * Needs Google Chrome (headless), ImageMagick and network access for the
 * webfonts.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'docs/assets');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : ASSETS;
mkdirSync(OUT, { recursive: true });

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

// Social preview: rounded down, so the uploaded image stays true for a while.
const socialAdapters = `${Math.floor(adapters / 10) * 10}+`;
const socialKeyless = `${Math.floor(keyless / 5) * 5}+`;

const work = mkdtempSync(join(tmpdir(), 'amcp-banner-'));
const template = readFileSync(join(ASSETS, 'banner.html'), 'utf8');

/** Render the banner HTML with these counts; returns the 2x screenshot path. */
function render(name, adapterLabel, keylessLabel) {
  const html = template
    .replace(/\{\{ADAPTERS\}\}/g, String(adapterLabel))
    .replace(/\{\{KEYLESS\}\}/g, String(keylessLabel))
    .replace(/\{\{ICON_CLAUDE\}\}/g, icon('claude'))
    .replace(/\{\{ICON_CHATGPT\}\}/g, icon('chatgpt'))
    .replace(/\{\{ICON_COPILOT\}\}/g, icon('copilot'))
    .replace(/\{\{ICON_CURSOR\}\}/g, icon('cursor'));
  const page = join(work, `${name}.html`);
  writeFileSync(page, html);
  // Render at 2x and downscale: Chrome's --screenshot has no DPR flag, and a
  // straight 1x render leaves the serif display edges ragged.
  const shot = join(work, `${name}@2x.png`);
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=1600,500`,
      `--screenshot=${shot}`,
      '--virtual-time-budget=6000',
      'file://' + page,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return shot;
}

// ImageMagick 7 ships `magick`; the 6.x on Ubuntu runners only has `convert`.
const imagemagick = (() => {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return 'magick';
  } catch {
    return 'convert';
  }
})();
const magick = (args) => execFileSync(imagemagick, args, { stdio: 'inherit' });

// README banner: 1600x500 (3.2:1). Wider than 2.5:1 on purpose — at
// GitHub's ~830px column every 100px of banner height is 100px the demo GIF
// below it does not get.
magick([render('banner', adapters, keyless), '-resize', '1600x500', '-strip', join(OUT, 'banner.png')]);

// Social preview / OG: 1280x640 (GitHub's 2:1 slot). Scale the whole 2.5:1
// banner down and letterbox it — cropping to 2:1 would cut the headline on one
// side and the client list on the other, which is exactly what a preview card
// needs to show.
magick([
  render('social', socialAdapters, socialKeyless),
  '-resize', '1280x400',
  '-background', '#05070f',
  '-gravity', 'center',
  '-extent', '1280x640',
  '-strip',
  join(OUT, 'social-preview.png'),
]);
writeFileSync(
  join(OUT, 'social-preview.json'),
  JSON.stringify({ adapters: socialAdapters, keyless: socialKeyless }) + '\n',
);

console.log(
  `${OUT}: banner.png with "${adapters} connectors, ${keyless} keyless", ` +
    `social-preview.png with "${socialAdapters} connectors, ${socialKeyless} keyless".`,
);
