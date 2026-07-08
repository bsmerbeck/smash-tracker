/**
 * V12 SEO: renders the 1200×630 Open Graph card to public/og-image.png.
 *
 * One-off generator (`pnpm --filter @smash-tracker/web generate:og`) — the
 * PNG is committed, not built per-deploy, so this only needs re-running when
 * the card design changes. 1200×630 is the canonical large-card size for
 * both Open Graph and `twitter:card=summary_large_image` (the previous
 * og-image.png was a 180×180 icon, which link unfurls rendered as a tiny
 * thumbnail). Inline HTML + system fonts: no external assets to drift.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(webRoot, 'public/og-image.png');

// #18181b matches index.html's theme-color; the red accent matches the app's
// primary button color.
const html = `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; box-sizing: border-box; }
      body {
        width: 1200px;
        height: 630px;
        background: radial-gradient(ellipse 90% 70% at 20% 0%, #27272a 0%, #18181b 55%);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: #fafafa;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 96px;
        position: relative;
        overflow: hidden;
      }
      .accent-bar { position: absolute; top: 0; left: 0; right: 0; height: 10px; background: #dc2626; }
      h1 { font-size: 92px; font-weight: 800; letter-spacing: -0.03em; }
      .tagline { margin-top: 28px; font-size: 40px; font-weight: 600; color: #e4e4e7; }
      .features { margin-top: 20px; font-size: 30px; color: #a1a1aa; }
      .domain {
        position: absolute;
        left: 96px;
        bottom: 56px;
        font-size: 34px;
        font-weight: 700;
        color: #dc2626;
      }
      .free {
        position: absolute;
        right: 96px;
        bottom: 56px;
        font-size: 28px;
        font-weight: 600;
        color: #18181b;
        background: #fafafa;
        border-radius: 999px;
        padding: 10px 28px;
      }
    </style>
  </head>
  <body>
    <div class="accent-bar"></div>
    <h1>Smash Tracker</h1>
    <div class="tagline">Free Super Smash Bros. Ultimate analytics</div>
    <div class="features">GSP &amp; Elite Smash tracking · matchup stats · AI scouting</div>
    <div class="domain">grandfinals.gg</div>
    <div class="free">100% free</div>
  </body>
</html>`;

const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: outPath, type: 'png' });
  console.log(`wrote ${outPath}`);
} finally {
  await browser.close();
}
