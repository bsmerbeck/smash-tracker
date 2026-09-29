/**
 * Plan 39.1-49: the Scout page's `POST /api/scout` answer for guard:layout and
 * capture:design (dev-only, Node-only — imported by
 * `guardLayoutFixturePlugin.mjs`, never by anything under `src/`).
 *
 * `buildScoutGuardReport(matches)` turns one harness dataset (the synthetic
 * `Match[]` guard:layout already serves from `/api/matches`) into a
 * deterministic, `scoutReportDataSchema`-valid `ScoutReportData`, so the real
 * ScoutPage renders every card — Full analysis included — from realistic
 * volumes: games mapped one-to-one, characters and stages aggregated by
 * games, the ten most-played opponents by set count, and up to ten recent
 * events with realistic-length names. A "set" is the run of games against
 * one opponent tag inside one session (games at most two hours apart).
 * Pure: the same input always yields a deep-equal report.
 */

const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 10;
const MAX_COMMON_OPPONENTS = 10;
const FALLBACK_TAG = 'guard-scout';

const EVENT_SERIES = [
  'Guard Harness Weekly Ultimate Singles',
  'Loopback Legends Monthly Ultimate Singles',
  'Fixture Plugin Invitational Ultimate Singles',
];
const TOURNAMENT_SERIES = [
  'Guard Harness Community Weekly Series',
  'Loopback Legends Regional Monthly Circuit',
  'Fixture Plugin Invitational Championship Tour',
];

function byCountThenKey(a, b) {
  if (b.count !== a.count) return b.count - a.count;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Splits time-sorted matches into sessions (games at most two hours apart). */
function toSessions(sorted) {
  const sessions = [];
  let current = null;
  for (const match of sorted) {
    if (!current || match.time - current.lastTime > SESSION_GAP_MS) {
      current = { matches: [], lastTime: match.time };
      sessions.push(current);
    }
    current.matches.push(match);
    current.lastTime = match.time;
  }
  return sessions;
}

/**
 * @param {Array<{ id: string; time: number; win: boolean; fighter_id: number; opponent_id?: number; opponent?: string; map?: { id: number; name: string } }>} matches
 */
export function buildScoutGuardReport(matches = []) {
  const sorted = [...matches].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sessions = toSessions(sorted);
  const eventCount = Math.min(MAX_RECENT_EVENTS, sessions.length);
  const eventSessions = sessions.slice(sessions.length - eventCount);

  // One synthetic event per recent session, numbered oldest to newest.
  const eventBySession = new Map();
  eventSessions.forEach((session, index) => {
    const series = index % EVENT_SERIES.length;
    const number = sessions.length - eventCount + index + 1;
    const eventName = `${EVENT_SERIES[series]} #${number}`;
    const tournamentName = `${TOURNAMENT_SERIES[series]} ${number}`;
    const entrants = 24 + ((number * 37) % 200);
    eventBySession.set(session, {
      eventName,
      tournamentName,
      placement: 1 + ((number * 13) % Math.max(1, Math.floor(entrants / 3))),
      numEntrants: entrants,
      lastSetAt: session.lastTime,
      slug: `tournament/${slugify(tournamentName)}/event/ultimate-singles`,
      source: 'startgg',
    });
  });

  const games = [];
  const characters = new Map();
  const stages = new Map();
  const setsByTag = new Map();
  let sampledSets = 0;
  for (const session of sessions) {
    const event = eventBySession.get(session);
    let previousTag = null;
    for (const match of session.matches) {
      const opponentTag =
        typeof match.opponent === 'string' && match.opponent.trim().length > 0
          ? match.opponent
          : 'Anonymous';
      if (opponentTag !== previousTag) {
        sampledSets += 1;
        setsByTag.set(opponentTag, (setsByTag.get(opponentTag) ?? 0) + 1);
        previousTag = opponentTag;
      }
      games.push({
        time: match.time,
        win: Boolean(match.win),
        fighterId: match.fighter_id,
        opponentFighterId: match.opponent_id ?? 0,
        ...(match.map ? { stageId: match.map.id, stageName: match.map.name } : {}),
        opponentTag,
        ...(event ? { eventName: event.eventName } : {}),
      });
      const character = characters.get(match.fighter_id) ?? { games: 0, wins: 0 };
      character.games += 1;
      character.wins += match.win ? 1 : 0;
      characters.set(match.fighter_id, character);
      if (match.map) {
        const stage = stages.get(match.map.id) ?? { games: 0, wins: 0 };
        stage.games += 1;
        stage.wins += match.win ? 1 : 0;
        stages.set(match.map.id, stage);
      }
    }
  }

  const gamesByTag = new Map();
  for (const game of games) {
    gamesByTag.set(game.opponentTag, (gamesByTag.get(game.opponentTag) ?? 0) + 1);
  }
  const topTag = [...gamesByTag.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort(byCountThenKey)[0]?.key;

  return {
    player: { id: 1, gamerTag: topTag ?? FALLBACK_TAG, source: 'startgg' },
    sampledSets,
    sampledGames: games.length,
    characters: [...characters.entries()]
      .map(([fighterId, value]) => ({ key: fighterId, count: value.games, value }))
      .sort((a, b) => b.count - a.count || a.key - b.key)
      .map(({ key, value }) => ({ fighterId: key, games: value.games, wins: value.wins })),
    stages: [...stages.entries()]
      .map(([stageId, value]) => ({ key: stageId, count: value.games, value }))
      .sort((a, b) => b.count - a.count || a.key - b.key)
      .map(({ key, value }) => ({ stageId: key, games: value.games, wins: value.wins })),
    recentEvents: [...eventBySession.values()].sort((a, b) => b.lastSetAt - a.lastSetAt),
    commonOpponents: [...setsByTag.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort(byCountThenKey)
      .slice(0, MAX_COMMON_OPPONENTS)
      .map(({ key, count }) => ({ gamerTag: key, sets: count })),
    games,
  };
}
