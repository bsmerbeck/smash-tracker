import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type LedgerModule = typeof import('./opponentLedger');

/**
 * Plan 39.1-45 (sketch 003 C `renderC` ledger rows; PD-45-1 / PD-45-2): the
 * builder is loaded inside each test body so a missing export fails the case,
 * not the file (the `rivalry-ledger` RED).
 */
async function loadLedger(): Promise<LedgerModule> {
  const mod = (await import('./opponentLedger')) as Partial<LedgerModule>;
  expect(typeof mod.buildOpponentLedger, 'buildOpponentLedger is exported').toBe('function');
  return mod as LedgerModule;
}

type Sketch003Fixture = {
  buildSketch003Scale: () => { matches: Match[] };
  SKETCH_003_PAIRINGS: { deep: readonly [number, number]; thin: readonly [number, number] };
  SKETCH_003_AS_OF_MS: number;
};

async function loadFixture(): Promise<Sketch003Fixture> {
  const url = pathToFileURL(path.resolve(__dirname, '../../../../scripts/sketch003Fixture.mjs'));
  return (await import(/* @vite-ignore */ url.href)) as Sketch003Fixture;
}

async function deepPairing(): Promise<{ matches: Match[]; nowMs: number }> {
  const { buildSketch003Scale, SKETCH_003_PAIRINGS, SKETCH_003_AS_OF_MS } = await loadFixture();
  const [fighterId, opponentId] = SKETCH_003_PAIRINGS.deep;
  return {
    matches: buildSketch003Scale().matches.filter(
      (m) => m.fighter_id === fighterId && m.opponent_id === opponentId,
    ),
    nowMs: SKETCH_003_AS_OF_MS,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** A start.gg-shaped game of set `setId` (a parsed set id keeps its own set). */
function setGame(setId: string, game: number, time: number, win: boolean, opponent = 'rival') {
  return makeMatch({
    id: `${setId}-g${game}`,
    externalId: `sgg:${setId}:g${game}`,
    source: 'startgg',
    time,
    win,
    opponent,
  });
}

describe('buildOpponentLedger — the sketch deep pairing (rivalry-ledger)', () => {
  it('returns 11 rows, most games first, tag ascending on ties', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const { matches, nowMs } = await deepPairing();
    const rows = buildOpponentLedger({ matches, nowMs });
    expect(rows.map((row) => row.tag)).toEqual([
      'mkleo',
      'shuton',
      'cosmos',
      'あcola',
      'jin',
      'Dabuz',
      'Kurama',
      'Riddles',
      'Tea',
      'Yoshidora',
      'Light',
    ]);
  });

  it('mkleo is 14-16 with sets 3-5 and eight set entries, oldest first; shuton is 16-4 with sets 7-0', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const { matches, nowMs } = await deepPairing();
    const rows = buildOpponentLedger({ matches, nowMs });
    const mkleo = rows.find((row) => row.tag === 'mkleo')!;
    expect(mkleo.record).toMatchObject({ wins: 14, losses: 16, total: 30 });
    expect(mkleo.setsWon).toBe(3);
    expect(mkleo.setsLost).toBe(5);
    expect(mkleo.setsTotal).toBe(8);
    expect(mkleo.sets).toHaveLength(8);
    const times = mkleo.sets.map((set) => set.lastGameMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(mkleo.sets.filter((set) => set.won)).toHaveLength(3);
    const shuton = rows.find((row) => row.tag === 'shuton')!;
    expect(shuton.record).toMatchObject({ wins: 16, losses: 4 });
    expect(shuton.setsWon).toBe(7);
    expect(shuton.setsLost).toBe(0);
  });

  it("carries the first and last game instants, and Light's single set", async () => {
    const { buildOpponentLedger } = await loadLedger();
    const { matches, nowMs } = await deepPairing();
    const rows = buildOpponentLedger({ matches, nowMs });
    const mkleo = rows.find((row) => row.tag === 'mkleo')!;
    const mkleoGames = matches.filter((m) => m.opponent === 'mkleo');
    expect(mkleo.firstMs).toBe(Math.min(...mkleoGames.map((m) => m.time)));
    expect(mkleo.lastMs).toBe(Math.max(...mkleoGames.map((m) => m.time)));
    const light = rows.find((row) => row.tag === 'Light')!;
    expect(light.record).toMatchObject({ wins: 1, losses: 0, total: 1 });
    expect(light.setsTotal).toBe(1);
    expect(light.firstMs).toBe(light.lastMs);
  });

  it("recent is the D-15 window over THAT opponent's games at the sketch's as-of: mkleo 2, jin 5, every other 0", async () => {
    const { buildOpponentLedger } = await loadLedger();
    const { matches, nowMs } = await deepPairing();
    const rows = buildOpponentLedger({ matches, nowMs });
    const recentTotals = Object.fromEntries(rows.map((row) => [row.tag, row.recent.total]));
    expect(recentTotals).toEqual({
      mkleo: 2,
      shuton: 0,
      cosmos: 0,
      あcola: 0,
      jin: 5,
      Dabuz: 0,
      Kurama: 0,
      Riddles: 0,
      Tea: 0,
      Yoshidora: 0,
      Light: 0,
    });
  });

  it("classifies the recent window against THAT opponent's all-time record (scoped, no new thresholds)", async () => {
    const { buildOpponentLedger } = await loadLedger();
    const { matches, nowMs } = await deepPairing();
    const rows = buildOpponentLedger({ matches, nowMs });
    // 2 recent games is below the 3-game abstention floor.
    expect(rows.find((row) => row.tag === 'mkleo')!.classification.state).toBe('locked');
    // jin's 5 games are ALL of his games but a scoped window below 8 games is thin.
    const jin = rows.find((row) => row.tag === 'jin')!;
    expect(jin.classification.state).toBe('thinRecent');
    expect(jin.classification.deltaPoints).toBeNull();
  });
});

describe('buildOpponentLedger — sets, windows and bounds', () => {
  const NOW = 1_800_000_000_000;

  it('a set is won when its wins exceed its losses; a 1-1 set is not won', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const matches = [
      setGame('s1', 1, NOW - 9 * DAY_MS, true),
      setGame('s1', 2, NOW - 9 * DAY_MS + 600_000, true),
      setGame('s1', 3, NOW - 9 * DAY_MS + 1_200_000, false),
      setGame('s2', 1, NOW - 5 * DAY_MS, true),
      setGame('s2', 2, NOW - 5 * DAY_MS + 600_000, false),
      setGame('s3', 1, NOW - 2 * DAY_MS, false),
    ];
    const [row] = buildOpponentLedger({ matches, nowMs: NOW });
    expect(row!.sets.map((set) => [set.won, set.wins, set.losses])).toEqual([
      [true, 2, 1],
      [false, 1, 1],
      [false, 0, 1],
    ]);
    expect(row!.setsWon).toBe(1);
    expect(row!.setsLost).toBe(2);
  });

  it('manual games in one 3-hour play session are one set (buildFormStripSetKeys); a later session is another', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const matches = [
      makeMatch({ id: 'a', time: NOW - 10 * DAY_MS, win: true }),
      makeMatch({ id: 'b', time: NOW - 10 * DAY_MS + HOUR_MS, win: true }),
      makeMatch({ id: 'c', time: NOW - 10 * DAY_MS + 2 * HOUR_MS, win: false }),
      makeMatch({ id: 'd', time: NOW - 3 * DAY_MS, win: false }),
    ];
    const [row] = buildOpponentLedger({ matches, nowMs: NOW });
    expect(row!.setsTotal).toBe(2);
    expect(row!.sets.map((set) => set.won)).toEqual([true, false]);
  });

  it('games without an opponent tag make no row (getOpponentRecords rule)', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const matches = [
      makeMatch({ id: 'a', opponent: undefined }),
      makeMatch({ id: 'b', opponent: '' }),
      makeMatch({ id: 'c', opponent: 'named' }),
    ];
    expect(buildOpponentLedger({ matches, nowMs: NOW }).map((row) => row.tag)).toEqual(['named']);
  });

  it('with more than 30 sets keeps the newest 30 (oldest first) and reports the total', async () => {
    const { buildOpponentLedger, LEDGER_MAX_SETS } = await loadLedger();
    expect(LEDGER_MAX_SETS).toBe(30);
    const matches = Array.from({ length: 35 }, (_, i) =>
      setGame(`s${i}`, 1, NOW - (400 - i) * DAY_MS, i % 2 === 0),
    );
    const [row] = buildOpponentLedger({ matches, nowMs: NOW });
    expect(row!.setsTotal).toBe(35);
    expect(row!.sets).toHaveLength(30);
    // The five oldest sets (s0..s4) are the ones dropped.
    expect(row!.sets[0]!.key).toBe('s5');
    expect(row!.sets[29]!.key).toBe('s34');
    // Totals describe ALL 35 sets (18 even indexes won).
    expect(row!.setsWon).toBe(18);
    expect(row!.setsLost).toBe(17);
    expect(row!.firstMs).toBe(NOW - 400 * DAY_MS);
  });

  it('the recent window never reaches past 12 months: only games inside it count', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const matches = [
      setGame('old', 1, NOW - 500 * DAY_MS, true),
      setGame('old2', 1, NOW - 400 * DAY_MS, true),
      setGame('new', 1, NOW - 30 * DAY_MS, false),
    ];
    const [row] = buildOpponentLedger({ matches, nowMs: NOW });
    expect(row!.recent).toMatchObject({ wins: 0, losses: 1, total: 1 });
    expect(row!.record.total).toBe(3);
  });

  it('is pure: the input array is not mutated and two calls agree', async () => {
    const { buildOpponentLedger } = await loadLedger();
    const matches = [
      setGame('b', 1, NOW - 2 * DAY_MS, true),
      setGame('a', 1, NOW - 9 * DAY_MS, false),
    ];
    const snapshot = matches.map((m) => m.id);
    const first = buildOpponentLedger({ matches, nowMs: NOW });
    const second = buildOpponentLedger({ matches, nowMs: NOW });
    expect(matches.map((m) => m.id)).toEqual(snapshot);
    expect(second).toEqual(first);
  });
});
