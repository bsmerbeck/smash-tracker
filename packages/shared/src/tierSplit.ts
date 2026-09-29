import { ABSTENTION_FLOOR_GAMES } from './evidence/policy.js';
import { toRateValue } from './insight/horizon.js';
import type { Match } from './match.js';
import type { TournamentEntry } from './startgg.js';
import { matchesForEntry } from './tournamentAggregation.js';
import {
  resolveTournamentTier,
  type KnownTierWord,
  type TierEntryFields,
  type TierResolution,
  type TierWord,
} from './tournamentTier.js';

/**
 * The entry fields the split needs. Both `TournamentEntry` and
 * `TournamentRegistryRow` satisfy it structurally, so the caller can pass the
 * `GET /api/tournaments` union straight in.
 */
export interface TierSplitEntry extends TierEntryFields {
  entryKey?: string | null;
  eventId?: number | null;
  tournamentName?: string | null;
  firstSetAt: number;
  lastSetAt: number;
}

/** One entry with its resolved tier and the matches assigned to it (each match belongs to at most one entry). */
export interface ResolvedTierEntry {
  entry: TierSplitEntry;
  entryKey: string;
  resolution: TierResolution;
  matches: Match[];
}

/** One by-tier row (or the Unknown bucket): counts of events by basis plus the pooled win/loss record. */
export interface TierSplitRow {
  tier: TierWord;
  events: number;
  estimatedEvents: number;
  recordedEvents: number;
  manualEvents: number;
  wins: number;
  losses: number;
  total: number;
  /** `null` below `ABSTENTION_FLOOR_GAMES` — never a misleading rate off a tiny sample. */
  rate: number | null;
  /** Games still needed to reach the floor; 0 once reached. */
  gamesNeeded: number;
}

/**
 * Coverage over ALL entries. `sideExcluded` are side events left out of the
 * split (always 0 when `includeSideEvents`); `known + unknown + sideExcluded`
 * equals `total`. `recorded + manual + estimated` equals `known`. Zero values
 * are kept so a reader can say "0 recorded".
 */
export interface TierSplitCoverage {
  total: number;
  known: number;
  recorded: number;
  manual: number;
  estimated: number;
  unknown: number;
  sideExcluded: number;
}

/** DD-11 cohorts: A = supermajor + major games, B = minor + regional + local games. Unknown never enters either. */
export interface TierSplitCohorts {
  a: Match[];
  b: Match[];
  aEvents: number;
  bEvents: number;
  /** Known events in A or B whose basis is `estimated`. */
  estimatedEvents: number;
}

export interface TierSplitStats {
  rows: TierSplitRow[];
  unknown: TierSplitRow | null;
  coverage: TierSplitCoverage;
  cohorts: TierSplitCohorts;
}

const COHORT_A_TIERS: readonly TierWord[] = ['supermajor', 'major'];
const COHORT_B_TIERS: readonly TierWord[] = ['minor', 'regional', 'local'];
/** `TIER_WORDS` without `unknown`, in the same order (a literal, so this module evaluates nothing at import). */
const KNOWN_TIER_WORDS: readonly KnownTierWord[] = [
  'supermajor',
  'major',
  'minor',
  'regional',
  'local',
];

function entryKeyOf(entry: TierSplitEntry): string {
  return entry.entryKey ?? (entry.eventId != null ? String(entry.eventId) : entry.eventName);
}

/** Adapts a split entry to the shape `matchesForEntry` reads; only the attribution fields matter. */
function asAttributionEntry(entry: TierSplitEntry): TournamentEntry {
  return {
    eventName: entry.eventName,
    ...(entry.tournamentName != null ? { tournamentName: entry.tournamentName } : {}),
    firstSetAt: entry.firstSetAt,
    lastSetAt: entry.lastSetAt,
    setsPlayed: 0,
  };
}

/**
 * The evidence the resolver needs for an entry with no stored `isOnline`
 * (F2): true when any of the entry's OWN linked matches was played online.
 * `quickplay` counts as online exactly as `settingGap`'s partition treats it.
 * `matches` must be the entry's OWN assigned matches (see `assignMatchesToEntries`);
 * `entry` is accepted so a future evidence source can key off it.
 */
export function observedOnlineFor(entry: TierSplitEntry, matches: Match[]): boolean {
  return matches.some(
    (match) => match.matchType === 'online-tourney' || match.matchType === 'quickplay',
  );
}

function distanceToWindow(time: number, entry: TierSplitEntry): number {
  if (time < entry.firstSetAt) {
    return entry.firstSetAt - time;
  }
  if (time > entry.lastSetAt) {
    return time - entry.lastSetAt;
  }
  return 0;
}

/**
 * Assigns every match to AT MOST ONE entry (RESEARCH Pattern 5). Candidates
 * come from `matchesForEntry`, whose padded window can attribute one match to
 * two same-named events; the match then goes to the entry whose
 * `[firstSetAt, lastSetAt]` contains it, else the nearest, ties by
 * `entryKey` ascending. Every entry gets a (possibly empty) list.
 */
export function assignMatchesToEntries(
  entries: TierSplitEntry[],
  matches: Match[],
): Map<string, Match[]> {
  const keyed = entries
    .map((entry) => ({ entry, key: entryKeyOf(entry) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const assigned = new Map<string, Match[]>(keyed.map(({ key }) => [key, []]));
  const candidatesByMatch = new Map<Match, { entry: TierSplitEntry; key: string }[]>();

  for (const item of keyed) {
    for (const match of matchesForEntry(matches, asAttributionEntry(item.entry))) {
      const list = candidatesByMatch.get(match) ?? [];
      list.push(item);
      candidatesByMatch.set(match, list);
    }
  }

  for (const [match, candidates] of candidatesByMatch) {
    let best = candidates[0];
    if (!best) {
      continue;
    }
    let bestDistance = distanceToWindow(match.time, best.entry);
    // `candidates` is already in entryKey-ascending order, so a strict `<`
    // keeps the lexicographically first entry on an exact tie.
    for (const candidate of candidates.slice(1)) {
      const distance = distanceToWindow(match.time, candidate.entry);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    assigned.get(best.key)?.push(match);
  }

  return assigned;
}

/** One `{ entry, resolution, matches }` per entry, with `observedOnline` derived from that entry's own assigned matches. */
export function resolveEntryTiers(
  entries: TierSplitEntry[],
  matches: Match[],
): ResolvedTierEntry[] {
  const assigned = assignMatchesToEntries(entries, matches);
  return entries.map((entry) => {
    const entryKey = entryKeyOf(entry);
    const own = assigned.get(entryKey) ?? [];
    return {
      entry,
      entryKey,
      matches: own,
      resolution: resolveTournamentTier({
        entry,
        observedOnline: observedOnlineFor(entry, own),
      }),
    };
  });
}

function buildRow(tier: TierWord, group: ResolvedTierEntry[]): TierSplitRow {
  const pooled = toRateValue(group.flatMap((item) => item.matches));
  return {
    tier,
    events: group.length,
    estimatedEvents: group.filter((item) => item.resolution.basis === 'estimated').length,
    recordedEvents: group.filter((item) => item.resolution.basis === 'recorded').length,
    manualEvents: group.filter((item) => item.resolution.basis === 'manual').length,
    wins: pooled.wins,
    losses: pooled.losses,
    total: pooled.total,
    rate: pooled.total >= ABSTENTION_FLOOR_GAMES ? pooled.rate : null,
    gamesNeeded: Math.max(0, ABSTENTION_FLOOR_GAMES - pooled.total),
  };
}

/**
 * TIER-03 engine side: the by-tier split every tier surface reads. Pure. A
 * side event is left out of rows and cohorts (counted in
 * `coverage.sideExcluded`) unless `includeSideEvents`; an included side event
 * resolves Unknown and so lands in the Unknown bucket, never a cohort.
 */
export function buildTierSplitStats(input: {
  entries: TierSplitEntry[];
  matches: Match[];
  includeSideEvents: boolean;
}): TierSplitStats {
  const resolved = resolveEntryTiers(input.entries, input.matches);
  const counted = resolved.filter(
    (item) => input.includeSideEvents || item.resolution.eventKind !== 'side-event',
  );

  const known = counted.filter((item) => item.resolution.tier !== 'unknown');
  const unknownEvents = counted.filter((item) => item.resolution.tier === 'unknown');

  const rows: TierSplitRow[] = [];
  for (const tier of KNOWN_TIER_WORDS) {
    const group = known.filter((item) => item.resolution.tier === tier);
    if (group.length > 0) {
      rows.push(buildRow(tier, group));
    }
  }

  const inCohort = (tiers: readonly TierWord[]) =>
    known.filter((item) => tiers.includes(item.resolution.tier));
  const cohortA = inCohort(COHORT_A_TIERS);
  const cohortB = inCohort(COHORT_B_TIERS);

  return {
    rows,
    unknown: unknownEvents.length > 0 ? buildRow('unknown', unknownEvents) : null,
    coverage: {
      total: resolved.length,
      known: known.length,
      recorded: known.filter((item) => item.resolution.basis === 'recorded').length,
      manual: known.filter((item) => item.resolution.basis === 'manual').length,
      estimated: known.filter((item) => item.resolution.basis === 'estimated').length,
      unknown: unknownEvents.length,
      sideExcluded: resolved.length - counted.length,
    },
    cohorts: {
      a: cohortA.flatMap((item) => item.matches),
      b: cohortB.flatMap((item) => item.matches),
      aEvents: cohortA.length,
      bEvents: cohortB.length,
      estimatedEvents: [...cohortA, ...cohortB].filter(
        (item) => item.resolution.basis === 'estimated',
      ).length,
    },
  };
}
