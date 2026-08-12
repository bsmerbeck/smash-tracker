/**
 * Post-deploy CDN warm-up and asset smoke test.
 *
 * Incident that bought this script (P1, 2026-08-12): immediately after a
 * deploy, every newly-hashed asset is a cold MISS on the Firebase Hosting
 * edge; five boot-path chunks took 26-103s to first byte and login sat on a
 * blank screen until the slowest landed. Fetching every built asset through
 * the public edge right after `firebase deploy` warms the edge PoP nearest
 * this machine AND smoke-tests that every asset actually deployed.
 *
 * Two honest limitations:
 * - Firebase Hosting caches per PoP, so this warms only the nearest edge —
 *   visitors routed elsewhere still see a cold MISS. Treat it as a smoke
 *   test with a warming side effect, not as closing the cold-edge class.
 * - The `**` -> spa.html rewrite means a MISSING asset returns HTTP 200
 *   with an HTML body, so status alone proves nothing: the content-type
 *   check below is what actually catches a broken deploy.
 *
 * Usage (after deploy):  node scripts/warm-cdn.mjs [origin]
 * Default origin: https://grandfinals.gg
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = process.argv[2] ?? 'https://grandfinals.gg';
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const assetFiles = await readdir(path.join(distDir, 'assets'), { recursive: true });
const assets = assetFiles
  .filter((f) => !f.endsWith(path.sep))
  .map((f) => `/assets/${f.split(path.sep).join('/')}`);
// Slash-less page paths: firebase.json sets trailingSlash: false, and a
// trailing-slash request only reaches the canonical URL via a 301 hop.
const pages = ['/', '/faq', '/gsp-calculator', '/spa.html'];
const targets = [...pages, ...assets];

// Two Accept-Encoding variants: the CDN caches per encoding (Vary).
const encodings = ['br, gzip', 'identity'];

const FETCH_TIMEOUT_MS = 30_000;

let failed = 0;
const CONCURRENCY = 8;
const queue = targets.flatMap((t) => encodings.map((e) => ({ t, e })));

async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const url = `${origin}${job.t}`;
    try {
      const res = await fetch(url, {
        headers: { 'accept-encoding': job.e },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const contentType = res.headers.get('content-type') ?? '';
      const isAsset = job.t.startsWith('/assets/');
      // Missing assets are rewritten to spa.html with status 200 — the
      // text/html content-type is the only reliable broken-deploy signal.
      if (!res.ok || (isAsset && contentType.includes('text/html'))) {
        failed += 1;
        console.error(`FAIL ${res.status} ${contentType} ${url}`);
        await res.arrayBuffer().catch(() => {}); // free the socket
      } else {
        await res.arrayBuffer(); // drain so the edge caches the full body
      }
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`warmed ${targets.length} paths x ${encodings.length} encodings, ${failed} failures`);
if (failed > 0) process.exit(1);
