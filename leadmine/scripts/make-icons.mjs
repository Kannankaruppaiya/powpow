/**
 * Renders icons/logo.svg to the PNG sizes Chrome needs.
 *
 * Chrome only accepts raster icons. The SVG is the source of truth and the
 * PNGs are committed alongside it; this regenerates them.
 *
 * Rendering goes through Chromium rather than a hand-rolled rasteriser so the
 * mark gets real anti-aliasing, gradients and masking — the previous script
 * drew pixels by hand and could not do any of those.
 *
 * Run with: npm run icons   (needs: npm i -D playwright-core)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-') && dir !== 'chromium') continue;
      const bin = join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const { chromium } = await import('playwright-core');
const svg = readFileSync(join(OUT, 'logo.svg'), 'utf8');

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
mkdirSync(OUT, { recursive: true });

for (const size of SIZES) {
  // deviceScaleFactor would multiply the output size, not the sampling — every
  // icon came out 128px. Chromium anti-aliases SVG well at any CSS size, so
  // render at the exact size wanted.
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  const shot = await page.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `icon${size}.png`), shot);
  console.log(`wrote icons/icon${size}.png`);
  await page.close();
}

await browser.close();
