/**
 * V12 SEO: post-build prerender of the public routes.
 *
 * Serves the built `dist/` with vite preview, loads each public route in
 * headless Chrome, waits for the route's content to mount (which also means
 * `useSeo` has already rewritten title/meta/canonical), and writes the
 * resulting DOM back into `dist/` as static per-route HTML. Firebase Hosting
 * serves static files before rewrites, so crawlers and SEO analyzers get full
 * HTML without executing any JS, while `/spa.html` (copied from the pristine
 * shell during `build`, BEFORE this script overwrites `dist/index.html`)
 * remains the rewrite fallback for auth-gated client-side routes.
 *
 * Deliberately NOT part of `build`: CI has no need to download Chromium.
 * Run via `pnpm --filter @smash-tracker/web prerender` after `build`, before
 * `firebase deploy` (see README deploy runbook).
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(webRoot, 'dist');

/**
 * `readySelector` gates the snapshot on the route's real content having
 * mounted; `mustInclude`/`expectTitle` then assert the snapshot is the page
 * we think it is (title proves useSeo ran), so a silent rendering regression
 * fails the deploy pipeline here instead of shipping empty shells to Google.
 */
const ROUTES = [
  {
    path: '/',
    out: 'index.html',
    readySelector: '#features-heading',
    mustInclude: 'Everything a competitive Smash Ultimate player needs',
    expectTitle: 'grandfinals.gg — Free Super Smash Bros. Ultimate Analytics & GSP Tracker',
  },
  {
    path: '/faq',
    out: 'faq/index.html',
    readySelector: 'h1',
    mustInclude: 'Frequently asked questions',
    expectTitle: 'Frequently Asked Questions | grandfinals.gg',
  },
  {
    path: '/gsp-calculator',
    out: 'gsp-calculator/index.html',
    readySelector: 'h1',
    mustInclude: 'Elite Smash GSP Calculator',
    expectTitle: 'Elite Smash GSP Calculator — GSP to MMR & Road to Elite',
  },
];

async function main() {
  // spa.html is the un-prerendered shell `build` copies aside; refusing to run
  // without it means a stale/partial dist can't produce a deploy where
  // auth-gated routes 404.
  await access(resolve(dist, 'spa.html')).catch(() => {
    throw new Error('dist/spa.html missing — run `pnpm --filter @smash-tracker/web build` first');
  });

  const server = await preview({ root: webRoot, preview: { port: 0 } });
  const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
  if (!origin) {
    throw new Error('vite preview did not report a local URL');
  }

  const browser = await puppeteer.launch();
  try {
    for (const route of ROUTES) {
      const page = await browser.newPage();
      await page.goto(`${origin}${route.path}`, { waitUntil: 'networkidle2', timeout: 60_000 });
      await page.waitForSelector(route.readySelector, { timeout: 30_000 });

      const title = await page.title();
      if (title !== route.expectTitle) {
        throw new Error(`${route.path}: title "${title}" != expected "${route.expectTitle}"`);
      }
      const html = `<!doctype html>\n${await page.evaluate(() => document.documentElement.outerHTML)}`;
      if (!html.includes(route.mustInclude)) {
        throw new Error(`${route.path}: snapshot missing expected content "${route.mustInclude}"`);
      }
      const canonical = await page.evaluate(
        () => document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      );
      const expectedCanonical = `https://grandfinals.gg${route.path === '/' ? '/' : route.path}`;
      if (canonical !== expectedCanonical) {
        throw new Error(`${route.path}: canonical "${canonical}" != "${expectedCanonical}"`);
      }

      const outPath = resolve(dist, route.out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, html);
      console.log(`prerendered ${route.path} -> ${route.out} (${html.length} bytes)`);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((done) => server.httpServer.close(done));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
