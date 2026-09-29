/**
 * Plan 39.1-41 (sketch 003 tracer, brief `39.1-MATCHUPS-SKETCH003-BRIEF.md`
 * sections 3-4): the approved Matchups sketch's OWN datasets, ported set for
 * set into a harness-only fixture scale (`sketch003`), so the real Matchups
 * page, guard:layout's `matchups-sketch-deep` / `matchups-sketch-thin` routes
 * and `capture:matchups-fidelity` all read exactly the numbers the owner
 * approved (`.planning/sketches/003-matchups-pairing-view/index.html`,
 * SETS_THIN / SETS_DEEP / SRC.stageDeal / MATRIX, lines 494-553).
 *
 * Plain ESM, JSDoc-typed, dev-only: imported by `guardLayoutHarness.mjs`
 * (never by `src/`), so it never reaches a production bundle.
 *
 * Port rules (plan 39.1-41 Task 1 step 4):
 * - every set game: id `sk003-<ds>-<setIndex>-g<gameIndex+1>`, the set date at
 *   18:00 UTC plus 10 minutes per game index, `source: 'startgg'`,
 *   `externalId: 'sgg:sk003-<ds>-<setIndex>:g<n>'`, the full tournament name,
 *   `eventName: 'Ultimate Singles'`, the round as `roundText`, the opponent
 *   tag as written and the match type from `ty`;
 * - stages resolve by name from the shared stage list ("Town & City" is the
 *   app's "Town and City"); a null stage writes no `map`;
 * - the deep pairing's stages are dealt exactly as the sketch deals them:
 *   mulberry32(7), a Fisher-Yates shuffle of the win pool then the loss pool,
 *   popped in chronological game order; games before the 2022-07-01 cutoff
 *   and the Riptide 2023 set carry no stage;
 * - MATRIX placeholder cells become manual games (no source / externalId /
 *   opponent / map), one per day from 2022-01-03 18:00 UTC in cell order,
 *   wins first.
 */
import { StageList } from '@smash-tracker/shared';

/** The sketch's snapshot date (`SRC.*.asOf`) — every "recent" window in the sketch is measured from it. */
export const SKETCH_003_AS_OF = '2026-09-25';
export const SKETCH_003_AS_OF_MS = Date.UTC(2026, 8, 25);

/** The sketch's fighters, by the app's SpriteList ids. */
export const SKETCH_003_FIGHTER_IDS = Object.freeze({
  cloud: 65,
  pyraMythra: 84,
  pikachu: 9,
  joker: 76,
  steve: 82,
  sonic: 41,
  snake: 36,
});

/** The two sketched pairings: `[yourFighterId, theirFighterId]`. */
export const SKETCH_003_PAIRINGS = Object.freeze({
  deep: Object.freeze([SKETCH_003_FIGHTER_IDS.cloud, SKETCH_003_FIGHTER_IDS.pyraMythra]),
  thin: Object.freeze([SKETCH_003_FIGHTER_IDS.pikachu, SKETCH_003_FIGHTER_IDS.joker]),
});

/* thin — Pikachu vs Joker · 11 games · 3–8 · Jun 2020 – Jan 2021 (online era) */
// prettier-ignore -- a verbatim port of the sketch table
const SETS_THIN = [
  {
    d: '2020-06-17',
    t: 'The Quarantine Series: Minor 3',
    s: 'TQS Minor 3',
    ty: 'online-tourney',
    o: 'Ned',
    r: 'Winners R2',
    g: 'LL',
    st: ['Pokémon Stadium 2', 'Battlefield'],
  },
  {
    d: '2020-07-27',
    t: 'Frame Perfect Series 4 Online',
    s: 'FPS 4',
    ty: 'online-tourney',
    o: 'Kola',
    r: 'Losers R3',
    g: 'WLL',
    st: ['Town & City', 'Small Battlefield', 'Final Destination'],
  },
  {
    d: '2020-08-15',
    t: 'WiFi Warrior Ranked #12',
    s: 'WWR #12',
    ty: 'online-tourney',
    o: 'Sinji',
    r: 'Winners QF',
    g: 'WLW',
    st: ['Smashville', 'Battlefield', 'Pokémon Stadium 2'],
  },
  {
    d: '2020-10-01',
    t: 'The Box 2: Online',
    s: 'The Box 2',
    ty: 'online-tourney',
    o: 'Ned',
    r: 'Losers R5',
    g: 'LL',
    st: [null, null],
  },
  {
    d: '2021-01-13',
    t: 'Get Clipped #7',
    s: 'Get Clipped #7',
    ty: 'online-tourney',
    o: 'Kola',
    r: 'Winners R1',
    g: 'L',
    st: ['Small Battlefield'],
  },
];

/* deep — Cloud vs Pyra/Mythra · 102 games · 64–38 · Mar 2021 – Jun 2026 · 11 players */
// prettier-ignore -- a verbatim port of the sketch table
const SETS_DEEP = [
  {
    d: '2021-03-13',
    t: 'The Quarantine Series: Minor 4',
    s: 'TQS Minor 4',
    ty: 'online-tourney',
    o: 'Yoshidora',
    r: 'Winners R3',
    g: 'WW',
  },
  {
    d: '2021-04-10',
    t: 'Frame Perfect Series 5 Online',
    s: 'FPS 5',
    ty: 'online-tourney',
    o: 'mkleo',
    r: 'Winners QF',
    g: 'LL',
  },
  {
    d: '2021-05-08',
    t: 'The Quarantine Series: Minor 5',
    s: 'TQS Minor 5',
    ty: 'online-tourney',
    o: 'Tea',
    r: 'Losers R4',
    g: 'WW',
  },
  {
    d: '2021-06-05',
    t: 'The Quarantine Series: Minor 6',
    s: 'TQS Minor 6',
    ty: 'online-tourney',
    o: 'cosmos',
    r: 'Winners SF',
    g: 'WLL',
  },
  {
    d: '2021-07-10',
    t: 'Frame Perfect Series 6 Online',
    s: 'FPS 6',
    ty: 'online-tourney',
    o: 'Dabuz',
    r: 'Winners R2',
    g: 'WW',
  },
  {
    d: '2021-08-21',
    t: 'Glitch 8.5: Konami Code',
    s: 'Glitch 8.5',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Winners QF',
    g: 'WLL',
  },
  {
    d: '2021-09-25',
    t: 'Sumabato SP 24 Online',
    s: 'Sumabato 24',
    ty: 'online-tourney',
    o: 'Kurama',
    r: 'Winners R1',
    g: 'WW',
  },
  {
    d: '2021-11-13',
    t: 'Mainstage 2021',
    s: 'Mainstage 2021',
    ty: 'offline-tourney',
    o: 'cosmos',
    r: 'Losers R6',
    g: 'WLW',
  },
  {
    d: '2022-01-15',
    t: "Let's Make Big Moves 2022",
    s: 'LMBM 2022',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Winners SF',
    g: 'WWLLL',
  },
  {
    d: '2022-04-16',
    t: 'Genesis 8',
    s: 'Genesis 8',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners R4',
    g: 'WW',
  },
  {
    d: '2022-06-11',
    t: 'Battle of BC 4',
    s: 'BoBC 4',
    ty: 'offline-tourney',
    o: 'cosmos',
    r: 'Losers R7',
    g: 'LL',
  },
  {
    d: '2022-07-16',
    t: 'Get On My Level 2022',
    s: 'GOML 2022',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Winners QF',
    g: 'WLW',
  },
  {
    d: '2022-08-12',
    t: 'Super Smash Con 2022',
    s: 'SSC 2022',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Losers QF',
    g: 'WLWW',
  },
  {
    d: '2022-10-22',
    t: 'The Big House 10',
    s: 'TBH 10',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners SF',
    g: 'WWLW',
  },
  {
    d: '2023-01-21',
    t: 'Genesis 9',
    s: 'Genesis 9',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Winners Final',
    g: 'LWWLW',
  },
  {
    d: '2023-03-18',
    t: 'Collision 2023',
    s: 'Collision 2023',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners QF',
    g: 'WLW',
  },
  {
    d: '2023-05-20',
    t: 'Battle of BC 5',
    s: 'BoBC 5',
    ty: 'offline-tourney',
    o: 'cosmos',
    r: 'Losers SF',
    g: 'WLWLL',
  },
  {
    d: '2023-07-15',
    t: 'Smash Factor X',
    s: 'Smash Factor X',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Grand Final',
    g: 'WWLW',
  },
  {
    d: '2023-08-11',
    t: 'Super Smash Con 2023',
    s: 'SSC 2023',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners SF',
    g: 'WWW',
  },
  {
    d: '2023-08-26',
    t: 'Shine 2023',
    s: 'Shine 2023',
    ty: 'offline-tourney',
    o: 'Light',
    r: 'Winners R3',
    g: 'W',
    note: 'only game 1 was logged',
  },
  {
    d: '2023-09-09',
    t: 'Riptide 2023',
    s: 'Riptide 2023',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Winners QF',
    g: 'WW',
  },
  {
    d: '2023-10-21',
    t: 'The Big House 11',
    s: 'TBH 11',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Losers Final',
    g: 'LWWLL',
  },
  {
    d: '2024-02-17',
    t: 'Genesis X',
    s: 'Genesis X',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners R5',
    g: 'WW',
  },
  {
    d: '2024-03-16',
    t: 'Collision 2024',
    s: 'Collision 2024',
    ty: 'offline-tourney',
    o: 'cosmos',
    r: 'Winners QF',
    g: 'WW',
  },
  {
    d: '2024-05-18',
    t: 'Battle of BC 6',
    s: 'BoBC 6',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Winners SF',
    g: 'LWL',
  },
  {
    d: '2024-07-13',
    t: 'Get On My Level X',
    s: 'GOML X',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Grand Final',
    g: 'WLWW',
  },
  {
    d: '2024-08-09',
    t: 'Super Smash Con 2024',
    s: 'SSC 2024',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Losers QF',
    g: 'LWW',
  },
  {
    d: '2024-10-19',
    t: 'The Big House 12',
    s: 'TBH 12',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Winners QF',
    g: 'WLW',
  },
  {
    d: '2025-03-15',
    t: 'Collision 2025',
    s: 'Collision 2025',
    ty: 'offline-tourney',
    o: 'cosmos',
    r: 'Losers R8',
    g: 'LWL',
  },
  {
    d: '2025-05-17',
    t: 'Battle of BC 7',
    s: 'BoBC 7',
    ty: 'offline-tourney',
    o: 'Riddles',
    r: 'Winners R4',
    g: 'WW',
  },
  {
    d: '2025-07-19',
    t: 'Supernova 2025',
    s: 'Supernova 2025',
    ty: 'offline-tourney',
    o: 'shuton',
    r: 'Winners SF',
    g: 'LWW',
  },
  {
    d: '2025-08-08',
    t: 'Super Smash Con 2025',
    s: 'SSC 2025',
    ty: 'offline-tourney',
    o: 'あcola',
    r: 'Losers SF',
    g: 'WWL',
  },
  {
    d: '2026-03-14',
    t: 'Collision 2026',
    s: 'Collision 2026',
    ty: 'offline-tourney',
    o: 'jin',
    r: 'Winners QF',
    g: 'WLWLW',
  },
  {
    d: '2026-06-20',
    t: 'Battle of BC 8',
    s: 'BoBC 8',
    ty: 'offline-tourney',
    o: 'mkleo',
    r: 'Losers R7',
    g: 'LL',
  },
];

/* SRC.deep.stageDeal, verbatim. */
// prettier-ignore -- a verbatim port of the sketch table
const DEEP_STAGE_DEAL = {
  seed: 7,
  cutoff: '2022-07-01',
  nullSets: ['Riptide 2023'],
  W: {
    Smashville: 4,
    'Small Battlefield': 3,
    Battlefield: 12,
    'Pokémon Stadium 2': 11,
    'Town & City': 9,
    'Final Destination': 5,
    'Hollow Bastion': 2,
  },
  L: {
    Smashville: 1,
    'Small Battlefield': 5,
    Battlefield: 6,
    'Pokémon Stadium 2': 4,
    'Town & City': 6,
    'Final Destination': 3,
    'Hollow Bastion': 1,
  },
};

/* MATRIX, verbatim. Only the two sketched cells are derived from the sets; the rest are placeholders. */
// prettier-ignore -- a verbatim port of the sketch table
const MATRIX = {
  rows: ['Cloud', 'Pikachu'],
  cols: ['Pyra/Mythra', 'Joker', 'Steve', 'Sonic', 'Snake'],
  cells: {
    'Cloud|Joker': [40, 35],
    'Cloud|Steve': [22, 30],
    'Cloud|Sonic': [31, 19],
    'Cloud|Snake': [2, 0],
    'Pikachu|Pyra/Mythra': [9, 12],
    'Pikachu|Steve': [5, 5],
    'Pikachu|Sonic': [7, 4],
    'Pikachu|Snake': [1, 1],
  },
};

/** The sketch's fighter names, as the MATRIX writes them, to SpriteList ids. */
const FIGHTER_ID_BY_SKETCH_NAME = {
  Cloud: SKETCH_003_FIGHTER_IDS.cloud,
  Pikachu: SKETCH_003_FIGHTER_IDS.pikachu,
  'Pyra/Mythra': SKETCH_003_FIGHTER_IDS.pyraMythra,
  Joker: SKETCH_003_FIGHTER_IDS.joker,
  Steve: SKETCH_003_FIGHTER_IDS.steve,
  Sonic: SKETCH_003_FIGHTER_IDS.sonic,
  Snake: SKETCH_003_FIGHTER_IDS.snake,
};

/** The sketch's stage names that differ from the app's shared stage list. */
const SKETCH_STAGE_NAME_TO_APP = { 'Town & City': 'Town and City' };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GAME_SPACING_MS = 10 * MINUTE_MS;
const MATRIX_START_MS = Date.UTC(2022, 0, 3, 18);

/** The sketch's own seeded PRNG, ported verbatim (index.html `mulberry32`). */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {string} sketchName
 * @returns {{ id: number, name: string }}
 */
function stageByName(sketchName) {
  const appName = SKETCH_STAGE_NAME_TO_APP[sketchName] ?? sketchName;
  const stage = StageList.find((candidate) => candidate.name === appName);
  if (!stage) {
    throw new Error(`sketch003Fixture: no shared stage named "${appName}"`);
  }
  return { id: stage.id, name: stage.name };
}

/** `YYYY-MM-DD` at 18:00 UTC, as epoch ms. */
function setStartMs(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 18);
}

/**
 * The sketch's `derive()` stage deal for the deep pairing: one stage name (or
 * null) per game, in chronological game order.
 *
 * @returns {{ stages: (string | null)[], dealLeft: number }}
 */
function dealDeepStages() {
  const deal = DEEP_STAGE_DEAL;
  const rnd = mulberry32(deal.seed);
  const expand = (pool) => Object.keys(pool).flatMap((key) => Array(pool[key]).fill(key));
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pool = { W: shuffle(expand(deal.W)), L: shuffle(expand(deal.L)) };
  const stages = [];
  for (const set of SETS_DEEP) {
    for (const c of set.g) {
      const win = c === 'W';
      if (set.d < deal.cutoff || deal.nullSets.includes(set.t)) {
        stages.push(null);
      } else {
        stages.push(pool[win ? 'W' : 'L'].pop() || null);
      }
    }
  }
  return { stages, dealLeft: pool.W.length + pool.L.length };
}

/**
 * @param {'thin' | 'deep'} ds
 * @param {typeof SETS_DEEP} sets
 * @param {[number, number]} pairing
 * @param {(setIndex: number, gameIndex: number, flatIndex: number) => string | null} stageOf
 */
function setGames(ds, sets, pairing, stageOf) {
  const [fighterId, opponentId] = pairing;
  const matches = [];
  let flatIndex = 0;
  sets.forEach((set, setIndex) => {
    const startMs = setStartMs(set.d);
    [...set.g].forEach((c, gameIndex) => {
      const stageName = stageOf(setIndex, gameIndex, flatIndex);
      flatIndex += 1;
      matches.push({
        id: `sk003-${ds}-${setIndex}-g${gameIndex + 1}`,
        fighter_id: fighterId,
        opponent_id: opponentId,
        time: startMs + gameIndex * GAME_SPACING_MS,
        win: c === 'W',
        opponent: set.o,
        matchType: set.ty,
        source: 'startgg',
        externalId: `sgg:sk003-${ds}-${setIndex}:g${gameIndex + 1}`,
        tournamentName: set.t,
        eventName: 'Ultimate Singles',
        roundText: set.r,
        ...(stageName ? { map: stageByName(stageName) } : {}),
      });
    });
  });
  return matches;
}

/** MATRIX placeholder cells -> manual games, one per day from 2022-01-03 18:00 UTC, in cell order, wins first. */
function matrixGames() {
  const matches = [];
  let day = 0;
  Object.entries(MATRIX.cells).forEach(([cell, [wins, losses]], cellIndex) => {
    const [row, col] = cell.split('|');
    const fighterId = FIGHTER_ID_BY_SKETCH_NAME[row];
    const opponentId = FIGHTER_ID_BY_SKETCH_NAME[col];
    for (let i = 0; i < wins + losses; i++) {
      matches.push({
        id: `sk003-matrix-${cellIndex}-${i}`,
        fighter_id: fighterId,
        opponent_id: opponentId,
        time: MATRIX_START_MS + day * DAY_MS,
        win: i < wins,
      });
      day += 1;
    }
  });
  return matches;
}

/**
 * The sketch-003 fixture scale for the guard-layout harness — the same shape
 * as every other scale (`guardLayoutHarness.mjs`). Deterministic: two calls
 * return equal data.
 */
export function buildSketch003Scale() {
  const { stages: deepStages } = dealDeepStages();
  const deep = setGames(
    'deep',
    SETS_DEEP,
    SKETCH_003_PAIRINGS.deep,
    (_s, _g, flat) => deepStages[flat],
  );
  const thin = setGames('thin', SETS_THIN, SKETCH_003_PAIRINGS.thin, (setIndex, gameIndex) => {
    const st = SETS_THIN[setIndex].st;
    return st ? (st[gameIndex] ?? null) : null;
  });
  const matches = [...thin, ...deep, ...matrixGames()].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    matches,
    fighters: {
      primary: [SKETCH_003_FIGHTER_IDS.cloud, SKETCH_003_FIGHTER_IDS.pikachu],
      secondary: [],
    },
    aliases: {},
    opponentNotes: {},
    tournaments: [],
  };
}

/** How many dealt stages the deep deal left undealt — 0 when the port is exact (the sketch's own `dealLeft` check). */
export function sketch003DealLeft() {
  return dealDeepStages().dealLeft;
}
