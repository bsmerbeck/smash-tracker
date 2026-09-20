/**
 * Layout-oracle fixture plugin (Phase 39.1 Plan 09). A Vite dev-server
 * plugin that exists ONLY in a `guard:layout` run — registered by
 * `guardLayoutHarness.mjs` when it creates the Vite server PROGRAMMATICALLY
 * via Vite's JS API, never listed in the tracked `apps/web/vite.config.ts`.
 * Modelled on `apps/web/scripts/perfFixturePlugin.mjs` (NOT edited by this
 * plan): serves the minimal `/api/**` reads a mounted harness page needs to
 * settle, backed by an in-memory named dataset, and keeps that plugin's
 * defensive catch-all — any other `/api/**` GET gets a minimal,
 * schema-agnostic empty shape rather than a 404, because a 404 leaves a page
 * on a permanent loading state and a permanently loading page is what makes
 * an oracle measure a skeleton (T-39.1-09-06).
 *
 * Lives under `apps/web/scripts/`, NOT `apps/web/src/`, so it can never be
 * pulled into the client bundle by any import graph accident — it is
 * Node-only server code (Vite plugins run in the Vite dev server process,
 * never shipped to the browser).
 *
 * In THIS plan the only route the harness serves (`StretchedCardFixture`)
 * needs no `/api` data at all, so `scales` ships empty and every request
 * falls through to the defensive catch-all. Plan 39.1-20 adds the endpoints
 * its eight real analytics routes actually require, keyed onto named
 * datasets the same way `perfFixturePlugin.mjs`'s `scales` are, and records
 * which endpoints it had to add.
 */

/**
 * @param {object} [options]
 * @param {Record<string, { matches?: unknown[]; fighters?: unknown; aliases?: unknown }>} [options.scales] - Named fixture datasets, keyed by scale name.
 * @param {string | null} [options.initialScale] - Which key of `scales` to serve first; `null` when no route needs one.
 * @returns {import('vite').Plugin}
 */
export function createGuardLayoutFixturePlugin({ scales = {}, initialScale = null } = {}) {
  let currentScale = initialScale;

  return {
    name: 'guard-layout-fixture',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        if (req.method !== 'GET') {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        const url = req.url ?? '';
        const dataset = currentScale ? scales[currentScale] : undefined;

        if (url === '/matches' || url.startsWith('/matches?')) {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset?.matches ?? []));
          return;
        }
        if (url === '/users/me/fighters') {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset?.fighters ?? { primary: [], secondary: [] }));
          return;
        }
        if (url === '/opponents/aliases') {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset?.aliases ?? {}));
          return;
        }

        // Defensive catch-all (perfFixturePlugin.mjs's own convention): any
        // other /api/** GET the mounted page might fire gets a minimal,
        // schema-agnostic empty shape rather than a 404 that could surface a
        // permanent loading spinner.
        res.statusCode = 200;
        res.end('{}');
      });
    },
  };
}
