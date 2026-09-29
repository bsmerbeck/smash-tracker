/**
 * Plan 39.1-41 (node:test): the sketch-003 fixture reproduces the sketch's
 * OWN derivation (`39.1-MATCHUPS-SKETCH003-BRIEF.md` section 4 — the facts
 * `derive()` prints as of 2026-09-25; never re-derived here). The module is
 * imported dynamically inside each test so a missing module fails the test,
 * not the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE_URL = new URL('./sketch003Fixture.mjs', import.meta.url);

async function load() {
  return import(FIXTURE_URL.href);
}

function pairingGames(scale, [fighterId, opponentId]) {
  return scale.matches.filter((m) => m.fighter_id === fighterId && m.opponent_id === opponentId);
}

function record(games) {
  const wins = games.filter((m) => m.win).length;
  return `${wins}-${games.length - wins}`;
}

function setKeys(games) {
  return new Set(games.map((m) => /^sgg:([^:]+):g\d+$/.exec(m.externalId ?? '')?.[1] ?? null));
}

test('sketch003-fixture: deep is 102 games, 64 wins, 34 set keys, 11 opponent tags', async () => {
  const { buildSketch003Scale, SKETCH_003_PAIRINGS } = await load();
  const deep = pairingGames(buildSketch003Scale(), SKETCH_003_PAIRINGS.deep);
  assert.equal(deep.length, 102);
  assert.equal(deep.filter((m) => m.win).length, 64);
  const keys = setKeys(deep);
  assert.equal(keys.has(null), false);
  assert.equal(keys.size, 34);
  assert.equal(new Set(deep.map((m) => m.opponent)).size, 11);
});

test("sketch003-fixture: deep per-stage records equal the brief's, with 30 games without a stage", async () => {
  const { buildSketch003Scale, SKETCH_003_PAIRINGS } = await load();
  const deep = pairingGames(buildSketch003Scale(), SKETCH_003_PAIRINGS.deep);
  const byStage = new Map();
  let unstaged = 0;
  for (const game of deep) {
    if (!game.map) {
      unstaged += 1;
      continue;
    }
    const list = byStage.get(game.map.name) ?? [];
    list.push(game);
    byStage.set(game.map.name, list);
  }
  assert.equal(unstaged, 30);
  const records = Object.fromEntries([...byStage].map(([name, games]) => [name, record(games)]));
  assert.deepEqual(records, {
    Battlefield: '12-6',
    'Pokémon Stadium 2': '11-4',
    'Town and City': '9-6',
    'Final Destination': '5-3',
    'Small Battlefield': '3-5',
    Smashville: '4-1',
    'Hollow Bastion': '2-1',
  });
});

test('sketch003-fixture: deep match types are offline-tourney 55-34 and online-tourney 9-4', async () => {
  const { buildSketch003Scale, SKETCH_003_PAIRINGS } = await load();
  const deep = pairingGames(buildSketch003Scale(), SKETCH_003_PAIRINGS.deep);
  assert.equal(record(deep.filter((m) => m.matchType === 'offline-tourney')), '55-34');
  assert.equal(record(deep.filter((m) => m.matchType === 'online-tourney')), '9-4');
});

test('sketch003-fixture: the stage deal consumes both pools exactly (the sketch dealLeft check)', async () => {
  const { sketch003DealLeft } = await load();
  assert.equal(sketch003DealLeft(), 0);
});

test('sketch003-fixture: thin is 11 games, 3 wins, 5 set keys and 2 games without a stage', async () => {
  const { buildSketch003Scale, SKETCH_003_PAIRINGS } = await load();
  const thin = pairingGames(buildSketch003Scale(), SKETCH_003_PAIRINGS.thin);
  assert.equal(thin.length, 11);
  assert.equal(thin.filter((m) => m.win).length, 3);
  assert.equal(setKeys(thin).size, 5);
  assert.equal(thin.filter((m) => !m.map).length, 2);
});

test('sketch003-fixture: the matrix cells produce exactly the brief records as manual games', async () => {
  const { buildSketch003Scale, SKETCH_003_FIGHTER_IDS: F } = await load();
  const scale = buildSketch003Scale();
  const expected = [
    [F.cloud, F.joker, '40-35'],
    [F.cloud, F.steve, '22-30'],
    [F.cloud, F.sonic, '31-19'],
    [F.cloud, F.snake, '2-0'],
    [F.pikachu, F.pyraMythra, '9-12'],
    [F.pikachu, F.steve, '5-5'],
    [F.pikachu, F.sonic, '7-4'],
    [F.pikachu, F.snake, '1-1'],
  ];
  for (const [fighterId, opponentId, want] of expected) {
    const games = pairingGames(scale, [fighterId, opponentId]);
    assert.equal(record(games), want, `${fighterId} vs ${opponentId}`);
    for (const game of games) {
      assert.equal(game.source, undefined);
      assert.equal(game.externalId, undefined);
      assert.equal(game.opponent, undefined);
      assert.equal(game.map, undefined);
    }
  }
  const days = pairingGames(scale, [F.cloud, F.joker])
    .map((m) => m.time)
    .sort((a, b) => a - b);
  assert.equal(days[0], Date.UTC(2022, 0, 3, 18));
  assert.equal(days[1] - days[0], 24 * 60 * 60 * 1000);
});

test('sketch003-fixture: ids are unique and the scale is identical across two builds', async () => {
  const { buildSketch003Scale } = await load();
  const a = buildSketch003Scale();
  const b = buildSketch003Scale();
  assert.equal(new Set(a.matches.map((m) => m.id)).size, a.matches.length);
  assert.deepEqual(a, b);
  assert.deepEqual(a.fighters, { primary: [65, 9], secondary: [] });
});

test('sketch003-fixture: every row passes the shared matchSchema', async () => {
  const { buildSketch003Scale } = await load();
  const { matchSchema } = await import('@smash-tracker/shared');
  for (const match of buildSketch003Scale().matches) {
    const parsed = matchSchema.safeParse(match);
    assert.equal(
      parsed.success,
      true,
      `${match.id}: ${parsed.success ? '' : parsed.error.message}`,
    );
  }
});

test('sketch003-fixture: a set game carries the sketch set identity (id, externalId, time, names)', async () => {
  const { buildSketch003Scale } = await load();
  const game = buildSketch003Scale().matches.find((m) => m.id === 'sk003-deep-8-g3');
  assert.ok(game);
  assert.equal(game.externalId, 'sgg:sk003-deep-8:g3');
  assert.equal(game.time, Date.UTC(2022, 0, 15, 18) + 2 * 10 * 60 * 1000);
  assert.equal(game.tournamentName, "Let's Make Big Moves 2022");
  assert.equal(game.eventName, 'Ultimate Singles');
  assert.equal(game.roundText, 'Winners SF');
  assert.equal(game.opponent, 'mkleo');
  assert.equal(game.source, 'startgg');
  assert.equal(game.win, false);
});
