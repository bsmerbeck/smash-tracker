import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { stagesById } from '@/data/stages';

/**
 * Phase D (docs/analytics-vision.md): tournament history inside a scouting
 * report — every start.gg-imported set played against the selected opponent,
 * grouped into per-tournament blocks with per-set score/round detail. All
 * grouping/derivation logic here is pure (no React) so it's unit-testable in
 * isolation; the UI (`TournamentHistory.tsx`) only renders these structures.
 */

// ---------------------------------------------------------------------------
// Set grouping
// ---------------------------------------------------------------------------

export interface TournamentSetGame {
  match: Match;
  /** Stage abbreviation, e.g. "BF", "FD", or "?" when the stage id is the no-selection sentinel (0). */
  stageAbbr: string;
  /** Full stage name, or "unknown" for the no-selection sentinel. */
  stageName: string;
  win: boolean;
}

export interface TournamentSet {
  /** The start.gg set id parsed from `externalId` ('sgg:{setId}:g{n}'). */
  setId: string;
  games: TournamentSetGame[];
  /** Games won by the tracked user within this set. */
  wins: number;
  /** Games won by the opponent within this set. */
  losses: number;
  /** `roundText` from the first game that has one, else `"Set {n}"` (n = 1-based position within the tournament block, chronological). */
  roundLabel: string;
  /** `bracketRound` from the first game that has one, when present. */
  bracketRound?: number;
  /** True when this set was on the losers side (`bracketRound < 0`). */
  isLosersSide: boolean;
  /** Epoch ms of the set's first game — used to order sets within a block. */
  time: number;
}

/** Parses the start.gg set id out of an imported game's `externalId` ('sgg:{setId}:g{n}'). Returns null for non-start.gg or malformed ids. */
export function parseSetId(externalId: string | undefined): string | null {
  if (!externalId) {
    return null;
  }
  const match = /^sgg:(.+):g\d+$/.exec(externalId);
  return match ? match[1]! : null;
}

/** Short (<=3 char) abbreviation for a stage name: initials of significant words, or the first letters of a single word. */
export function abbreviateStageName(name: string): string {
  const words = name
    .replace(/['’]/g, '')
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && w.toLowerCase() !== 'the' && w.toLowerCase() !== 'of');
  if (words.length === 0) {
    return '';
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function stageInfoFor(match: Match): { stageAbbr: string; stageName: string } {
  if (!match.map || match.map.id === 0) {
    return { stageAbbr: '?', stageName: 'unknown' };
  }
  const stageName = stagesById.get(match.map.id)?.name ?? match.map.name;
  return { stageAbbr: abbreviateStageName(stageName), stageName };
}

/**
 * Groups games belonging to the same start.gg set (same parsed `setId`) into
 * a `TournamentSet`, deriving the score from game wins/losses. Games are
 * grouped in the order they first appear per set, but each set's own games
 * are additionally sorted by `time` to keep the per-game chip order stable.
 * `roundLabel` falls back to `"Set {n}"` (n = 1-based, by chronological
 * position among the sets returned) when no game in the set carries
 * `roundText` — this is the pre-resync case called out in Phase D.
 */
export function groupIntoSets(matches: Match[]): TournamentSet[] {
  const bySet = new Map<string, Match[]>();
  for (const match of matches) {
    const setId = parseSetId(match.externalId);
    if (setId === null) {
      continue;
    }
    const group = bySet.get(setId);
    if (group) {
      group.push(match);
    } else {
      bySet.set(setId, [match]);
    }
  }

  const sets = [...bySet.entries()].map(([setId, games]) => {
    const sortedGames = [...games].sort((a, b) => a.time - b.time);
    const wins = sortedGames.filter((m) => m.win).length;
    const losses = sortedGames.filter((m) => !m.win).length;
    const roundTextGame = sortedGames.find((m) => m.roundText);
    const bracketRoundGame = sortedGames.find((m) => m.bracketRound !== undefined);
    const bracketRound = bracketRoundGame?.bracketRound;

    return {
      setId,
      games: sortedGames.map((match) => {
        const { stageAbbr, stageName } = stageInfoFor(match);
        return { match, stageAbbr, stageName, win: match.win };
      }),
      wins,
      losses,
      roundLabel: roundTextGame?.roundText ?? '',
      bracketRound,
      isLosersSide: bracketRound !== undefined && bracketRound < 0,
      time: sortedGames[0]!.time,
    };
  });

  sets.sort((a, b) => a.time - b.time);

  let setCounter = 0;
  return sets.map((set) => {
    if (set.roundLabel) {
      return set;
    }
    setCounter += 1;
    return { ...set, roundLabel: `Set ${setCounter}` };
  });
}

// ---------------------------------------------------------------------------
// Tournament block grouping
// ---------------------------------------------------------------------------

/**
 * Two same-named tournament groups (e.g. a recurring weekly) more than this
 * far apart in time are treated as separate blocks — chosen generously (4
 * days) to keep multi-day majors as one block without merging distinct
 * occurrences of a weekly series that shares a name.
 */
export const TOURNAMENT_PROXIMITY_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

export interface TournamentBlock {
  /** `tournamentName ?? eventName` for every match in this block. */
  displayName: string;
  eventName: string;
  tournamentName?: string;
  sets: TournamentSet[];
  startTime: number;
  endTime: number;
  wins: number;
  losses: number;
}

/**
 * Groups the opponent's start.gg-imported matches into per-tournament
 * blocks: first by `tournamentName ?? eventName`, then split into separate
 * blocks whenever consecutive sets (by time) exceed
 * `TOURNAMENT_PROXIMITY_WINDOW_MS` apart — so a recurring weekly with the
 * same name doesn't merge distant occurrences into one block. Matches
 * without `eventName` (never synced, or pre-Phase-B import) are excluded;
 * callers use an empty result to show the "no tournament sets" empty state.
 */
export function groupTournamentBlocks(
  matches: Match[],
  proximityWindowMs = TOURNAMENT_PROXIMITY_WINDOW_MS,
): TournamentBlock[] {
  const withEvent = matches.filter(
    (m): m is Match & { eventName: string } => m.eventName != null && m.eventName !== '',
  );

  const byName = new Map<string, (Match & { eventName: string })[]>();
  for (const match of withEvent) {
    const key = match.tournamentName ?? match.eventName;
    const group = byName.get(key);
    if (group) {
      group.push(match);
    } else {
      byName.set(key, [match]);
    }
  }

  const blocks: TournamentBlock[] = [];
  for (const [, group] of byName) {
    const sorted = [...group].sort((a, b) => a.time - b.time);
    let current: (Match & { eventName: string })[] = [];
    for (const match of sorted) {
      const previous = current[current.length - 1];
      if (previous && match.time - previous.time > proximityWindowMs) {
        blocks.push(buildBlock(current));
        current = [match];
      } else {
        current.push(match);
      }
    }
    if (current.length > 0) {
      blocks.push(buildBlock(current));
    }
  }

  return blocks.sort((a, b) => b.endTime - a.endTime);
}

function buildBlock(matches: (Match & { eventName: string })[]): TournamentBlock {
  const sets = groupIntoSets(matches);
  const wins = matches.filter((m) => m.win).length;
  const losses = matches.filter((m) => !m.win).length;
  const first = matches[0]!;
  return {
    displayName: first.tournamentName ?? first.eventName,
    eventName: first.eventName,
    tournamentName: first.tournamentName,
    sets,
    startTime: Math.min(...matches.map((m) => m.time)),
    endTime: Math.max(...matches.map((m) => m.time)),
    wins,
    losses,
  };
}

// ---------------------------------------------------------------------------
// Tournament registry resolution
// ---------------------------------------------------------------------------

/**
 * Slack added around a block's [startTime, endTime] span when matching
 * against a registry entry's [firstSetAt, lastSetAt] — the two are derived
 * from the same underlying start.gg sets so they should already align
 * closely, but a little slack absorbs any rounding/timezone edge cases.
 */
const REGISTRY_MATCH_SLACK_MS = 60 * 60 * 1000;

/**
 * Resolves a tournament block to a registry entry (for linking to
 * `/tournaments/:eventId`) by matching `eventName` and requiring the block's
 * time span to fall within the registry entry's [firstSetAt, lastSetAt]
 * window (plus slack). Returns null when no entry matches — the block title
 * then renders as plain text instead of a link. Pure + exported for tests.
 */
export function resolveTournamentEntry(
  block: TournamentBlock,
  entries: TournamentEntry[],
): TournamentEntry | null {
  const candidates = entries.filter((e) => e.eventName === block.eventName);
  for (const entry of candidates) {
    const withinWindow =
      block.startTime >= entry.firstSetAt - REGISTRY_MATCH_SLACK_MS &&
      block.endTime <= entry.lastSetAt + REGISTRY_MATCH_SLACK_MS;
    if (withinWindow) {
      return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Encounter context summary
// ---------------------------------------------------------------------------

export interface EncounterContext {
  tournamentCount: number;
  /** Epoch ms span across all blocks, or null when there are no blocks. */
  span: { start: number; end: number } | null;
}

/** Summarizes tournament blocks into the header's "met at N tournaments between X and Y" context line. */
export function getEncounterContext(blocks: TournamentBlock[]): EncounterContext {
  if (blocks.length === 0) {
    return { tournamentCount: 0, span: null };
  }
  const starts = blocks.map((b) => b.startTime);
  const ends = blocks.map((b) => b.endTime);
  return {
    tournamentCount: blocks.length,
    span: { start: Math.min(...starts), end: Math.max(...ends) },
  };
}
