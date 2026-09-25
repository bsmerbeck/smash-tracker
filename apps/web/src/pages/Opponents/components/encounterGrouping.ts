import type { Match, SetGame } from '@smash-tracker/shared';
import { buildSetTimeline, splitIntoSessions, stageBucketId } from '@smash-tracker/shared';

/**
 * Phase 39.1 Plan 18 (UIX-08/D-10, UI-SPEC §8.6): turns an already-scoped,
 * already-alias-resolved match array into the event-header/set-grouped
 * structure `RecentEncounters.tsx` renders (owner note 10: "could click and
 * go to the match, see a set from the matches").
 *
 * Calls the shared set-timeline builder (`buildSetTimeline`) DIRECTLY on the
 * full array — never pre-split by tournament registry entry (RESEARCH.md
 * Pattern 3/Pitfall 4). The builder's parsed sets (grouped purely by parsed
 * `externalId` set identifier) are bucketed here by the event/tournament
 * name carried on their first game — the ONLY new grouping logic this module
 * adds. The builder's unparsable remainder (manual entries with no set
 * identifier) is routed through the existing session splitter
 * (`splitIntoSessions`), one pseudo-set per game.
 *
 * This module localises nothing and renders nothing (Track B/host-owns-i18n
 * discipline) — every printable label a caller needs is either raw source
 * data (an event name) or left entirely to the component (session/date
 * labels, for which `label` is the empty string on a `'session'` group).
 */

export interface EncounterSet {
  /** The parsed set id (an `'event'` group's sets) or a synthetic `game:<matchId>` key (a `'session'` group's pseudo-sets) — never a display string. */
  key: string;
  won: boolean;
  gamesWon: number;
  gamesLost: number;
  /** The tracked user's fighter id(s) across this set's games, first-seen order. */
  userFighterIds: number[];
  /** The opponent's fighter id(s) across this set's games, first-seen order. */
  opponentFighterIds: number[];
  /** One stage bucket id per game, in game order (`UNKNOWN_STAGE_ID` for an absent/no-selection map). */
  stageIds: number[];
  games: SetGame[];
  /** This set's newest game's time — the sort key. */
  dateMs: number;
}

export interface EncounterGroup {
  kind: 'event' | 'session';
  key: string;
  /** Raw event/tournament name for an `'event'` group; empty for a `'session'` group (the component composes the session's own label from `dateMs`). */
  label: string;
  /** The group's newest game's time — the sort key. */
  dateMs: number;
  sets: EncounterSet[];
}

/** Newest-first by `dateMs`; ties break ascending by `key` so the order is stable across renders (never a re-derived timestamp comparison). */
function byDateThenKeyDesc(
  a: { dateMs: number; key: string },
  b: { dateMs: number; key: string },
): number {
  if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

/** UI-SPEC §8.6 / `MatchupChart.tsx`'s `buildFormStripEvents` precedent: event name preferred over tournament name. */
function eventLabelFor(match: Match): string {
  const raw = match.eventName ?? match.tournamentName;
  return raw?.trim() ?? '';
}

function toEncounterSet(
  games: SetGame[],
  key: string,
  won: boolean,
  gamesWon: number,
  gamesLost: number,
  userFighterIds: number[],
  opponentFighterIds: number[],
): EncounterSet {
  let dateMs = -Infinity;
  for (const game of games) {
    if (game.match.time > dateMs) dateMs = game.match.time;
  }
  return {
    key,
    won,
    gamesWon,
    gamesLost,
    userFighterIds,
    opponentFighterIds,
    stageIds: games.map((game) => stageBucketId(game.match)),
    games,
    dateMs,
  };
}

/** A manual/unparseable game becomes its own one-game pseudo-set — never a session-level aggregate. */
function singleGameSet(match: Match): EncounterSet {
  const game: SetGame = { match, gameNumber: 1 };
  return toEncounterSet(
    [game],
    `game:${match.id}`,
    match.win,
    match.win ? 1 : 0,
    match.win ? 0 : 1,
    [match.fighter_id],
    [match.opponent_id],
  );
}

/**
 * Turns an already-scoped, already-alias-resolved match array into ordered
 * event/session groups of sets. `sessionGapMs` forwards to
 * `splitIntoSessions` for the manual remainder only — omitted uses that
 * function's own default gap.
 */
export function groupEncounters({
  matches,
  sessionGapMs,
}: {
  matches: Match[];
  sessionGapMs?: number;
}): EncounterGroup[] {
  const { sets, otherMatches } = buildSetTimeline(matches);

  const byEvent = new Map<string, { label: string; sets: EncounterSet[] }>();
  for (const set of sets) {
    const firstMatch = set.games[0]?.match;
    if (!firstMatch) continue;
    const label = eventLabelFor(firstMatch);
    const key = `event:${label}`;
    const encounterSet = toEncounterSet(
      set.games,
      set.setId,
      set.won,
      set.gamesWon,
      set.gamesLost,
      set.userFighterIds,
      set.opponentFighterIds,
    );
    const existing = byEvent.get(key);
    if (existing) {
      existing.sets.push(encounterSet);
    } else {
      byEvent.set(key, { label, sets: [encounterSet] });
    }
  }

  const eventGroups: EncounterGroup[] = [...byEvent.entries()].map(
    ([key, { label, sets: encounterSets }]) => {
      const ordered = [...encounterSets].sort(byDateThenKeyDesc);
      let dateMs = -Infinity;
      for (const encounterSet of ordered) {
        if (encounterSet.dateMs > dateMs) dateMs = encounterSet.dateMs;
      }
      return { kind: 'event' as const, key, label, dateMs, sets: ordered };
    },
  );

  const sessions =
    otherMatches.length > 0
      ? sessionGapMs != null
        ? splitIntoSessions(otherMatches, sessionGapMs)
        : splitIntoSessions(otherMatches)
      : [];

  const sessionGroups: EncounterGroup[] = sessions.map((sessionMatches) => {
    const ordered = sessionMatches.map(singleGameSet).sort(byDateThenKeyDesc);
    let dateMs = -Infinity;
    let oldestMs = Infinity;
    for (const match of sessionMatches) {
      if (match.time > dateMs) dateMs = match.time;
      if (match.time < oldestMs) oldestMs = match.time;
    }
    return {
      kind: 'session' as const,
      key: `session:${oldestMs}`,
      label: '',
      dateMs,
      sets: ordered,
    };
  });

  return [...eventGroups, ...sessionGroups].sort(byDateThenKeyDesc);
}
