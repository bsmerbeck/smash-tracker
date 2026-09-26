/**
 * Layout-oracle fixture plugin (Phase 39.1 Plan 09, endpoints added by Plan
 * 20 Task 3). A Vite dev-server plugin that exists ONLY in a `guard:layout`
 * run — registered by `guardLayoutHarness.mjs` when it creates the Vite
 * server PROGRAMMATICALLY via Vite's JS API, never listed in the tracked
 * `apps/web/vite.config.ts`. Modelled on `apps/web/scripts/perfFixturePlugin.mjs`:
 * serves the minimal `/api/**` reads a mounted harness page needs to settle,
 * backed by an in-memory named dataset, and keeps that plugin's defensive
 * catch-all — any other `/api/**` GET gets a minimal, schema-agnostic empty
 * shape rather than a 404, because a 404 leaves a page on a permanent
 * loading state and a permanently loading page is what makes an oracle
 * measure a skeleton (T-39.1-09-06).
 *
 * Lives under `apps/web/scripts/`, NOT `apps/web/src/`, so it can never be
 * pulled into the client bundle by any import graph accident — it is
 * Node-only server code (Vite plugins run in the Vite dev server process,
 * never shipped to the browser).
 *
 * Plan 39.1-20 Task 3 added the four endpoints the eight real analytics
 * routes need beyond the three plan 39.1-09 already served: `/opponent-notes`
 * (a record map, `{}` is already valid — no real data needed for any of the
 * eight routes to settle), `/tournaments` (an ARRAY-schema endpoint —
 * `historicalTournamentEntryListSchema` rejects the catch-all's bare `{}`,
 * so this needed its own explicit `[]` handler rather than falling through),
 * and `/users/me` (`userProfileSchema` requires `uid`/`email`/`fighters`/etc.
 * — the catch-all's `{}` fails that schema too; served from the SAME
 * `fighters` shape as `/users/me/fighters` so the two never disagree).
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
        // Plan 39.1-34 (T-39.1-34-01): a request may name one of the
        // IN-MEMORY fixture scales via `x-guard-layout-scale` (guardLayout's
        // `trends-career` route sends `career`). The header only ever
        // selects an existing key of `scales` on this loopback-only dev
        // server; an unknown or absent value falls back to the server's
        // initial scale — unchanged behaviour for every other route.
        const requestedScale = req.headers['x-guard-layout-scale'];
        const scaleName =
          typeof requestedScale === 'string' && Object.hasOwn(scales, requestedScale)
            ? requestedScale
            : currentScale;
        const dataset = scaleName ? scales[scaleName] : undefined;

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
        if (url === '/opponent-notes') {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset?.opponentNotes ?? {}));
          return;
        }
        if (url === '/tournaments') {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset?.tournaments ?? []));
          return;
        }
        if (url === '/users/me') {
          res.statusCode = 200;
          res.end(
            JSON.stringify(
              dataset?.profile ?? {
                uid: 'guard-layout-harness-user',
                email: 'guard-layout-harness@example.invalid',
                fighters: dataset?.fighters ?? { primary: [], secondary: [] },
                coachingModeEnabled: false,
                onboardingIntent: null,
                isDemoAccount: false,
              },
            ),
          );
          return;
        }

        // Plan 39.1-39: the GSP page's reads, answered ONLY when the active
        // dataset carries them (capture:design's capture-only `gsp` scale).
        // Every other scale falls through to the catch-all below exactly as
        // before, so the eight measured routes' responses are byte-unchanged.
        if (url === '/gsp-readings' && dataset?.gspReadings !== undefined) {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset.gspReadings));
          return;
        }
        if (url === '/gsp-settings' && dataset?.gspSettings !== undefined) {
          res.statusCode = 200;
          res.end(JSON.stringify(dataset.gspSettings));
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
