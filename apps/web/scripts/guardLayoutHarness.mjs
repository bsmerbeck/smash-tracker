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
import { buildSketch003Scale } from './sketch003Fixture.mjs';

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

/**
 * Plan 41-04 (TRND-03 SC4): the career dataset's registry, so the timeline's tier diamonds and the
 * Recent Events card are measured with content. ILLUSTRATIVE and deterministic (integer arithmetic on
 * the row index, no PRNG, no wall clock): 14 offline rows spaced 190 days apart inside the games'
 * span, cycling supermajor / major / minor / regional entrant counts, so 8 resolve to a major or above
 * (all estimates: no recorded or manual tier here). Rows carry no linked games — the oracle measures
 * layout, not records.
 */
const CAREER_TOURNAMENT_ENTRANTS = [1580, 640, 310, 1100, 96, 520, 205, 48];
const CAREER_TOURNAMENT_COUNT = 14;
const CAREER_TOURNAMENT_FIRST_MS = Date.UTC(2019, 5, 8, 18);

function buildCareerTournaments() {
  return Array.from({ length: CAREER_TOURNAMENT_COUNT }, (_, i) => {
    const eventId = 7_000 + i;
    const startMs = CAREER_TOURNAMENT_FIRST_MS + i * 190 * DAY_MS;
    const entrants = CAREER_TOURNAMENT_ENTRANTS[i % CAREER_TOURNAMENT_ENTRANTS.length];
    return {
      eventId,
      entryKey: String(eventId),
      eventName: 'Ultimate Singles',
      tournamentName: `Career Fixture Open ${i + 1}`,
      firstSetAt: startMs,
      lastSetAt: startMs + 2 * DAY_MS,
      setsPlayed: 4 + (i % 6),
      numEntrants: entrants,
      isOnline: false,
      source: 'startgg',
    };
  });
}

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
    tournaments: buildCareerTournaments(),
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

/** The registry key of the Dashboard recap's event; the fixture plugin answers `GET /api/prep/<key>` for it. */
export const DASHBOARD_RECAP_ENTRY_KEY = 'fixture-harbor-clash-2026';

/**
 * Plan 39.2-13 (UI-SPEC section 13 G1, section 8.3): the Dashboard oracle's dataset: the wall-clock
 * `recent` scale plus one just-finished named event, its registry entry and an open debrief, so the
 * measured page carries the 8 + 4 row with the widest recap card (tier badge and provenance, the
 * event's two-horizon chip, a four-set strip, and the debrief, games and event doors) rather than a
 * digest spanning the row.
 *
 * DELIBERATELY anchored to the wall clock like `recent`: the recap exists only for an event that
 * ended inside the last 14 days. The event's twelve games end six hours before the run, AFTER the
 * dense segment's last game (one day before it), so the card's games door (an inclusive date window)
 * holds exactly the event. The tournament name is 40 characters, the long-name stress case. Invented
 * names and integer arithmetic only; nothing is copied from an owner manifest.
 */
export function buildDashboardScale() {
  const base = buildRecentScale();
  const endMs = Date.now() - 6 * HOUR_MS;
  const gameCount = 12;
  const tournamentName = 'Harbor Clash Community Championship 2026';
  const eventGames = Array.from({ length: gameCount }, (_, i) => {
    const set = Math.floor(i / 3);
    return {
      id: `dashboard-recap-${i}`,
      fighter_id: HARNESS_FIGHTER_A_ID,
      opponent_id: i % 2 === 0 ? 1 : 10,
      time: endMs - (gameCount - 1 - i) * 25 * 60 * 1000,
      win: set === 2 ? i % 3 === 0 : i % 4 !== 3,
      matchType: 'offline-tourney',
      map: { id: 1, name: 'Battlefield' },
      opponent: `synthopp${1 + set}`,
      eventName: 'Ultimate Singles',
      tournamentName,
      externalId: `sgg:dashboard-recap-set${set}:g${(i % 3) + 1}`,
    };
  });
  const firstSetAt = eventGames[0].time;
  return {
    ...base,
    matches: [...base.matches, ...eventGames],
    tournaments: [
      {
        eventId: 9_900,
        entryKey: DASHBOARD_RECAP_ENTRY_KEY,
        eventName: 'Ultimate Singles',
        tournamentName,
        firstSetAt,
        lastSetAt: endMs,
        setsPlayed: 4,
        numEntrants: 1_583,
        placement: 3,
        isOnline: false,
        source: 'startgg',
      },
    ],
    // `GET /api/prep/<entryKey>`: activated, with the debrief moment already passed.
    prepStatuses: {
      [DASHBOARD_RECAP_ENTRY_KEY]: { activated: true, reviewAt: endMs + HOUR_MS },
    },
  };
}

/**
 * Plan 39.2-07 (UI-SPEC §13 G1, T-39.2-32): the Tournaments oracle's
 * registry fixture. ILLUSTRATIVE and deterministic — invented tournament
 * names and integer arithmetic on the row index, no PRNG, no wall clock, and
 * never a name, slug, uid or count copied from an owner manifest. Shapes the
 * table must hold: offline supermajor / major / minor / regional / local
 * rows carrying `isOnline: false` and `numEntrants`, online weeklies
 * (`isOnline: true`, so an unknown tier), a Squad Strike side event, a row
 * with no placement, one 60+ character tournament name over a long event
 * name (the truncation backstop), and undated rows ("No date").
 */
const TOURNAMENT_FIXTURE_TEMPLATES = [
  { name: 'Harbor Clash', event: 'Ultimate Singles', entrants: 1580, online: false },
  { name: 'Summit Series', event: 'Ultimate Singles', entrants: 640, online: false },
  { name: 'Riverside Regional', event: 'Ultimate Singles', entrants: 310, online: false },
  { name: 'Northgate Monthly', event: 'Ultimate Singles', entrants: 96, online: true },
  { name: 'Cedar Locals', event: 'Ultimate Singles', entrants: 48, online: false },
  { name: 'Lakeshore Weekly', event: 'Ultimate Singles', entrants: 72, online: true },
  { name: 'Lakeshore Weekly Side Bracket', event: 'Squad Strike', entrants: 24, online: false },
  { name: 'Blue Harbor Open', event: 'Ultimate Singles', entrants: 130, online: false },
  { name: 'Ironwood Invitational', event: 'Ultimate Singles', entrants: 260, online: false },
  {
    name: 'Spring Cascade Community Championship Series Grand Finals Weekend 2025 Edition',
    event: 'Ultimate Singles Main Bracket (Open Registration, Double Elimination)',
    entrants: 205,
    online: false,
  },
];

/** Which template each of the 19 rows of the default fixture uses (a fixed pattern, not a draw). */
const TOURNAMENT_FIXTURE_PATTERN_19 = [0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7, 8, 9, 0, 3, 4, 5, 2, 4];
/** The 19-row fixture's last rows are undated. */
const TOURNAMENT_FIXTURE_UNDATED_19 = 2;
const TOURNAMENT_FIXTURE_LATEST_MS = Date.UTC(2026, 7, 8, 18);

/**
 * `count` registry rows plus the games linked to them. `pattern` picks the
 * template per row; the last `undated` rows carry no dates. Every dated
 * offline row also gets a handful of linked games (so the Record cell shows a
 * real record and its confidence glyph), and the placement / seed pair varies
 * with the index so the seed delta shows all three shapes.
 */
function buildTournamentRegistry({ count, patternFor, undated, spacingDays }) {
  const tournaments = [];
  const matches = [];
  for (let i = 0; i < count; i += 1) {
    const template = TOURNAMENT_FIXTURE_TEMPLATES[patternFor(i)];
    const isSide = template.event === 'Squad Strike';
    const isUndated = i >= count - undated;
    const eventId = 9_000 + i;
    const tournamentName =
      i < TOURNAMENT_FIXTURE_PATTERN_19.length ? template.name : `${template.name} #${i}`;
    const startMs = isUndated ? 0 : TOURNAMENT_FIXTURE_LATEST_MS - i * spacingDays * DAY_MS;
    const endMs = isUndated ? 0 : startMs + (template.entrants > 500 ? 2 * DAY_MS : 0);
    const entrants = template.entrants + (i % 4) * 3;
    const placement =
      isSide || i % 6 === 5
        ? undefined
        : 1 + (((i * 37) % 100) % Math.max(2, Math.round(entrants / 4)));
    const seed =
      placement === undefined || i % 7 === 3 ? undefined : Math.max(1, placement + ((i % 5) - 2));
    tournaments.push({
      eventId,
      entryKey: String(eventId),
      eventName: template.event,
      tournamentName,
      firstSetAt: startMs,
      lastSetAt: endMs === 0 ? 0 : endMs + 6 * HOUR_MS,
      setsPlayed: 4 + (i % 6),
      numEntrants: entrants,
      ...(placement !== undefined ? { placement } : {}),
      ...(seed !== undefined ? { seed } : {}),
      isOnline: template.online,
      ...(i % 3 !== 2 ? { slug: `tournament/fixture-${eventId}` } : {}),
      source: 'startgg',
    });
    if (isUndated) continue;
    const games = 3 + (i % 6);
    for (let g = 0; g < games; g += 1) {
      matches.push({
        id: `tournaments-fixture-${eventId}-${g}`,
        fighter_id: HARNESS_FIGHTER_A_ID,
        opponent_id: g % 2 === 0 ? 1 : 10,
        time: startMs + (g + 1) * 25 * 60 * 1000,
        win: (i + g) % 3 !== 0,
        matchType: template.online ? 'online-tourney' : 'offline-tourney',
        map: { id: 1, name: 'Battlefield' },
        opponent: `synthopp${1 + ((i + g) % 12)}`,
        eventName: template.event,
        tournamentName,
      });
    }
  }
  return { tournaments, matches };
}

/**
 * Plan 39.2-07: the Tournaments oracle's two datasets — the realistic
 * account's games plus `count` registry rows and their linked games. Kept as
 * their OWN scales (selected per page via `x-guard-layout-scale`) rather than
 * folded into `realistic`, so no other route's measured input changes.
 */
export function buildTournamentsScale(count) {
  const base = buildRealisticScale();
  const registry =
    count === 19
      ? buildTournamentRegistry({
          count,
          patternFor: (i) => TOURNAMENT_FIXTURE_PATTERN_19[i],
          undated: TOURNAMENT_FIXTURE_UNDATED_19,
          spacingDays: 17,
        })
      : buildTournamentRegistry({
          count,
          patternFor: (i) =>
            TOURNAMENT_FIXTURE_PATTERN_19[i % TOURNAMENT_FIXTURE_PATTERN_19.length],
          undated: 3,
          spacingDays: 9,
        });
  return {
    ...base,
    matches: [...base.matches, ...registry.matches],
    tournaments: registry.tournaments,
  };
}

/** A small seeded PRNG (mulberry32) — the `gsp` scale's walk is identical on every run. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plan 39.1-39: the `gsp` scale (plan 39.1-49 moved this ONE definition here
 * verbatim from `captureDesignScreens.mjs` and registered it in the scale
 * map, so guard:layout's `gsp` route and capture:design read the same data) — the realistic scale's games
 * (guard:layout's own 300-game fixture, one definition) with a deterministic
 * `gsp` value on every game of the harness mains (a seeded walk between 9 and
 * 11 million per fighter: a win climbs 40-140k, a loss drops 30-120k), two
 * calibration readings per main and gsp settings with an Elite threshold,
 * so GspCurve, GspVsGlicko and GainsAnalysis all render data.
 */
function buildGspScale() {
  const base = buildRealisticScale();
  const random = seededRandom(39_139_001);
  const mains = base.fighters.primary;
  const level = new Map(mains.map((id) => [id, 9_600_000]));
  const clamp = (value) => Math.min(11_000_000, Math.max(9_000_000, value));
  const matches = [...base.matches]
    .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : 1))
    .map((match) => {
      if (!level.has(match.fighter_id)) return match;
      const step = match.win ? 40_000 + random() * 100_000 : -(30_000 + random() * 90_000);
      const next = Math.round(clamp(level.get(match.fighter_id) + step));
      level.set(match.fighter_id, next);
      return { ...match, gsp: next };
    });
  const byFighter = mains.map((id) => matches.filter((m) => m.fighter_id === id));
  const gspReadings = byFighter.flatMap((games, index) =>
    [0.33, 0.66].map((at, n) => {
      const anchor = games[Math.floor(games.length * at)];
      return {
        id: `gsp-reading-${mains[index]}-${n}`,
        fighter_id: mains[index],
        gsp: Math.round(clamp((anchor?.gsp ?? 9_800_000) + 150_000)),
        time: (anchor?.time ?? 0) + 60_000,
      };
    }),
  );
  const lastTime = matches.reduce((max, match) => Math.max(max, match.time), 0);
  return {
    ...base,
    matches,
    gspReadings,
    gspSettings: { eliteThreshold: 10_400_000, updatedAt: lastTime },
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
    // Plan 39.2-13: the Dashboard's recap row (see `buildDashboardScale`).
    dashboard: buildDashboardScale(),
    gsp: buildGspScale(),
    // Plan 39.2-07: the Tournaments oracle's 19-row and 100-row registries.
    tournaments: buildTournamentsScale(19),
    tournaments100: buildTournamentsScale(100),
    // Plan 39.1-41: sketch 003's own two pairings (Cloud vs Pyra/Mythra,
    // Pikachu vs Joker) + its matrix, ported set for set — guard:layout's
    // matchups-sketch-deep / -thin routes and capture:matchups-fidelity
    // select it per page with `x-guard-layout-scale: sketch003`.
    sketch003: buildSketch003Scale(),
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
