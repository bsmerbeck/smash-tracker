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
 *
 * Exported (plan 39.1-39) so capture:design's capture-only `gsp` scale is
 * built FROM this one definition (the same games plus GSP readings), never
 * a second copy of the fixture parameters.
 */
export function buildRealisticScale() {
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

/**
 * Plan 39.1-34: the ONE sparg0-shaped dataset — the career timeline's
 * oracle route (`trends-career`) selects it per page through the
 * `x-guard-layout-scale: career` request header. 8,400 games, sessions of
 * 6-28 games spaced by a fixed 135h gap, 73% wins: first game
 * 2018-12-18T18:00:00Z, last game 2026-08-22T07:51:00Z (read from a run of
 * this exact call, never guessed) — 495 sessions, 93 months with games, so
 * the engine picks the quarter rating grain (~31 closes) and month strips.
 */
const CAREER_SESSION_GAP_MS = 135 * 60 * 60 * 1000;

function buildCareerScale() {
  const matches = generateSyntheticMatches({
    seed: 39_134_001,
    count: 8_400,
    startMs: Date.UTC(2018, 11, 18, 18),
    sessionSizeRange: [6, 28],
    sessionGapMs: CAREER_SESSION_GAP_MS,
    winRate: 0.73,
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

/**
 * Plan 39.1-35: the casual account — 41 games in sessions of 2-6 spaced by a
 * fixed 156h (6.5-day) gap from 2026-07-03T19:00:00Z, so only three calendar
 * months hold games: the career timeline's THIN state (a per-session line and
 * the per-game FormStrip in place of the month strips). Selected per page by
 * the `trends-casual` route's `x-guard-layout-scale: casual` header.
 */
const CASUAL_SESSION_GAP_MS = 156 * 60 * 60 * 1000;

function buildCasualScale() {
  const matches = generateSyntheticMatches({
    seed: 39_135_001,
    count: 41,
    startMs: Date.UTC(2026, 6, 3, 19),
    sessionSizeRange: [2, 6],
    sessionGapMs: CASUAL_SESSION_GAP_MS,
    winRate: 0.56,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Shifts every row's time so the LAST row sits at `endMs`; ids are untouched. */
function shiftToEnd(matches, endMs) {
  const last = matches.reduce((max, match) => Math.max(max, match.time), -Infinity);
  const delta = endMs - last;
  return matches.map((match) => ({ ...match, time: match.time + delta }));
}

/**
 * Plan 39.1-36: the `recent` scale — two-horizon content the stale
 * `realistic` fixture (every game in 2023) cannot show. Two seeded runs with
 * the realistic scale's mains (Fox 8, Falco 22), opponent characters [1, 10]
 * and stage [1], so every harness route still resolves (/opponents/synthopp15,
 * /stages/1):
 * - an older, sparse segment: ~420 games in sessions of 3-6 spaced 10 days
 *   apart (~30 months; monthly periods hold well under 50 games per main);
 * - a dense segment: 1,300 games in sessions of 18-30 spaced 26h apart
 *   (~2 months; monthly periods hold 150+ games per main), ending one day
 *   before the harness starts.
 * The Fighter hero's period series therefore shows more than one dot-size
 * step and the D-15 scoped last-30 / last-90 windows are non-empty.
 *
 * DELIBERATELY anchored to the wall clock (dev-only): this scale exists to
 * show what a CURRENT account looks like. The harness is excluded from the
 * production build (guardHarnessProductionBuild.guard.test.ts). Plan 39.1-39
 * moved this ONE definition here from `captureDesignScreens.mjs` and
 * registered it in the scale map: guard:layout's `stage-detail-recent` route
 * selects it per page for the mark-count family, whose assertion (at most 60
 * line points) holds for any anchor date; it is never the initial scale.
 */
export function buildRecentScale() {
  const common = {
    mainFighterIds: [8, 22],
    opponentFighterIds: [1, 10],
    stageIds: [1],
  };
  const denseRaw = generateSyntheticMatches({
    ...common,
    seed: 39_136_002,
    count: 1_300,
    startMs: 0,
    sessionSizeRange: [18, 30],
    sessionGapMs: 26 * HOUR_MS,
    winRate: 0.58,
  });
  const dense = shiftToEnd(denseRaw, Date.now() - DAY_MS);
  const denseStart = dense.reduce((min, match) => Math.min(min, match.time), Infinity);
  const olderRaw = generateSyntheticMatches({
    ...common,
    seed: 39_136_001,
    count: 420,
    startMs: 0,
    sessionSizeRange: [3, 6],
    sessionGapMs: 10 * DAY_MS,
    winRate: 0.52,
  });
  const older = shiftToEnd(olderRaw, denseStart - 7 * DAY_MS);
  const matches = [...older, ...dense].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    matches,
    fighters: { primary: [8, 22], secondary: [] },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

/**
 * Plan 39.1-34: `extraScales` merges caller-supplied in-memory datasets into
 * the fixture plugin's scale map (selected per page via the
 * `x-guard-layout-scale` header) — `captureTimelineFidelity.mjs` passes the
 * owner's local export as `export`. Omitted, the server is unchanged.
 */
export async function startGuardLayoutHarnessServer({ extraScales = {} } = {}) {
  const scale = process.env.GUARD_LAYOUT_SCALE === 'sparse' ? 'sparse' : 'realistic';
  const scales = {
    realistic: buildRealisticScale(),
    sparse: buildSparseScale(),
    career: buildCareerScale(),
    casual: buildCasualScale(),
    recent: buildRecentScale(),
    ...extraScales,
  };
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
      'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify('1:0:web:0000000000000000000001'),
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
