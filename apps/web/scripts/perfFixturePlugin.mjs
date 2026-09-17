/**
 * SCL-01 perf harness fixture plugin (Phase 36 Plan 06, Task 3B). A Vite
 * dev-server plugin that exists ONLY in a measurement run — it is
 * registered by `scl01BrowserBudget.mjs` when it creates the Vite server
 * PROGRAMMATICALLY via Vite's JS API, never listed in the tracked
 * `apps/web/vite.config.ts`. Serves the minimal `/api/**` reads the real
 * Matchups page needs to settle, backed by an in-memory synthetic
 * `Match[]` array (never real account data) so the real `useMatches`/
 * `useFighters`/`useOpponentAliases` hooks fetch + JSON-parse through the
 * REAL API client — parse cost is inside the measurement, exactly as a
 * real backend response would be.
 *
 * Lives under `apps/web/scripts/`, NOT `apps/web/src/`, so it can never be
 * pulled into the client bundle by any import graph accident — it is
 * Node-only server code (Vite plugins run in the Vite dev server process,
 * never shipped to the browser).
 *
 * The dataset is MUTABLE at runtime via a harness-only admin endpoint
 * (`POST /api/__perf-harness__/set-scale`, body `{ "scale": "<key>" }`),
 * so the heap-delta measurement can swap a live server between an empty
 * baseline and the 50k fixture between two navigations of the SAME browser
 * context, without needing to restart the Vite server per sample. This
 * endpoint is unreachable from the production build for the same reason
 * every other file in this plugin is: it exists only inside a server this
 * plugin registers, and this plugin is never part of the tracked
 * `vite.config.ts`'s plugin list.
 */

/**
 * @param {object} options
 * @param {Record<string, unknown[]>} options.scales - Named match-array datasets, keyed by scale name (e.g. "8k", "empty", "50k").
 * @param {string} options.initialScale - Which key of `scales` to serve first.
 * @param {{ primary: number[]; secondary: number[] }} options.fighterSelection
 * @returns {import('vite').Plugin}
 */
export function createPerfFixturePlugin({ scales, initialScale, fighterSelection }) {
  let currentScale = initialScale;
  const fightersJson = JSON.stringify(fighterSelection);
  const emptyAliasesJson = JSON.stringify({});

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  return {
    name: 'scl01-perf-fixture',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        const url = req.url ?? '';

        if (req.method === 'POST' && url === '/__perf-harness__/set-scale') {
          readBody(req)
            .then((raw) => {
              const parsed = JSON.parse(raw || '{}');
              if (typeof parsed.scale !== 'string' || !(parsed.scale in scales)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'unknown scale', known: Object.keys(scales) }));
                return;
              }
              currentScale = parsed.scale;
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 200;
              res.end(
                JSON.stringify({ scale: currentScale, matchCount: scales[currentScale].length }),
              );
            })
            .catch((error) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(error) }));
            });
          return;
        }

        if (req.method !== 'GET') {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');

        if (url === '/matches' || url.startsWith('/matches?')) {
          res.statusCode = 200;
          res.end(JSON.stringify(scales[currentScale]));
          return;
        }
        if (url === '/users/me/fighters') {
          res.statusCode = 200;
          res.end(fightersJson);
          return;
        }
        if (url === '/opponents/aliases') {
          res.statusCode = 200;
          res.end(emptyAliasesJson);
          return;
        }

        // Defensive catch-all: any other /api/** GET the page might fire
        // gets a minimal, schema-agnostic empty shape rather than a 404
        // that could surface a permanent loading spinner. Never guessed at
        // from real endpoint shapes beyond what the Matchups page needs.
        res.statusCode = 200;
        res.end('{}');
      });
    },
  };
}
