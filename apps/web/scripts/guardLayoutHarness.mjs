/**
 * Layout-oracle Vite dev-server starter (Phase 39.1 Plan 09; fixture data
 * added by Plan 20 Task 3). The thin module `guardLayout.mjs` imports to
 * start a Vite dev server with `guard-layout.html` served (dev mode needs no
 * `build.rollupOptions.input` override — Vite's dev server serves any
 * `.html` file present in the project root by request path; only
 * `vite build` needs an explicit entry) and `guardLayoutFixturePlugin.mjs`
 * in its plugin list, bound to the loopback address — exactly as
 * `scl01BrowserBudget.mjs` starts its own harness server.
 *
 * Carries over that precedent's Vite `define` block (review finding C2-L2,
 * `apps/web/scripts/scl01BrowserBudget.mjs:71-88`), load-bearing for every
 * mounted page:
 *   - Fake `VITE_FIREBASE_*` values, so `getFirebaseAuth()` — called
 *     unconditionally by `lib/api.ts`'s `getAuthHeader()` on every request —
 *     does not throw on mount.
 *   - `VITE_API_BASE_URL` set to the empty string, so every `/api/**`
 *     request lands on the harness origin the fixture plugin answers
 *     instead of a dead default.
 * Without both, every harness page either throws on mount or never settles,
 * and the runner's own page-loaded-marker rule then turns the run into
 * UNMEASURED plus a non-zero exit.
 *
 * Plan 39.1-20 Task 3: the `realistic` scale (seeded `generateSyntheticMatches`,
 * §300 games, mains Fox(8)/Falco(22), opponent characters restricted to
 * Mario(1)/Luigi(10) so `usePersistedSelection`'s auto-picked pairing always
 * clears `ABSTENTION_FLOOR_GAMES`, and every known-stage game on Battlefield
 * so `/stages/1` has plenty of games) is what the eight real routes measure
 * against by default. A `sparse` scale (`sparseWorkspaces.ts`'s
 * `twoGameWorkspace()`) is ALSO registered — switchable via
 * `GUARD_LAYOUT_SCALE=sparse` — for the same "realistically sized vs. sparse
 * account" switchability `scl01BrowserBudget.mjs`'s own fixture plugin
 * offers, though this plan's own measurement run uses `realistic` only.
 */
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { twoGameWorkspace } from '@smash-tracker/shared/testUtils';
import { createGuardLayoutFixturePlugin } from './guardLayoutFixturePlugin.mjs';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE_CONFIG_PATH = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

/** Fox — an `EIGHT_K_FIXTURE_OPTIONS`-shaped main, guaranteed heavy coverage. */
const HARNESS_FIGHTER_A_ID = 8;
/** Falco — the second main. */
const HARNESS_FIGHTER_B_ID = 22;

/**
 * The realistically-sized fixture's own `Match[]`, plus a `/tournaments`-
 * compatible empty array and a `/users/me`-compatible profile — one place
 * building all three so they can never disagree about the same account.
 * `opponentFighterIds` restricted to Mario(1)/Luigi(10) (never the full
 * roster) — with only two possible "their character" values, the auto-
 * selected Matchups/FighterAnalysis pairing is guaranteed well above
 * `ABSTENTION_FLOOR_GAMES` (3) regardless of PRNG output. `stageIds: [1]`
 * (Battlefield) for the same reason on the stage-detail route.
 */
function buildRealisticScale() {
  // generateSyntheticMatches already assigns each row a unique, deterministic
  // `id` (`synth-<seed>-<i>`) — no re-keying needed.
  const matches = generateSyntheticMatches({
    seed: 39_120_024,
    count: 300,
    mainFighterIds: [HARNESS_FIGHTER_A_ID, HARNESS_FIGHTER_B_ID],
    opponentFighterIds: [1, 10],
    stageIds: [1],
  });
  return {
    matches,
    fighters: { primary: [HARNESS_FIGHTER_A_ID, HARNESS_FIGHTER_B_ID], secondary: [] },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

/** `twoGameWorkspace()` — the SAME sparse fixture `sparseWorkspaces.ts` names for exactly this switchability. Its own rows already carry unique ids. */
function buildSparseScale() {
  const matches = twoGameWorkspace();
  return {
    matches,
    fighters: { primary: [8], secondary: [] },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

export async function startGuardLayoutHarnessServer() {
  const scale = process.env.GUARD_LAYOUT_SCALE === 'sparse' ? 'sparse' : 'realistic';
  const scales = { realistic: buildRealisticScale(), sparse: buildSparseScale() };
  const server = await createViteServer({
    root: WEB_ROOT,
    configFile: VITE_CONFIG_PATH,
    // 'development' — the oracle measures a Vite DEV server, matching the
    // shipped perf harness's own stated rationale, not a minified
    // production bundle.
    mode: 'development',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [createGuardLayoutFixturePlugin({ scales, initialScale: scale })],
    define: {
      // Fake, syntactically-valid Firebase Web SDK config so
      // `getFirebaseAuth()` does not throw. The harness's fake AuthContext
      // value is a SEPARATE substitution (see `fakeGuardAuthContextValue.ts`)
      // — this define exists only so an unrelated, real SDK call doesn't
      // crash; no sign-in is ever attempted, so no network call to a real
      // Firebase project happens.
      'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify('guard-layout-harness-fake-key'),
      'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify(
        'guard-layout-harness.example.invalid',
      ),
      'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(
        'guard-layout-harness-fake-project',
      ),
      'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify(
        '1:0:web:0000000000000000000001',
      ),
      // Empty string (never left `undefined`, which falls back to a
      // non-harness origin): keeps every `/api/**` request relative, so it
      // lands on THIS SAME Vite dev server origin — the one origin the
      // fixture plugin above actually answers.
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    throw new Error('guard-layout harness Vite server did not bind a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}
