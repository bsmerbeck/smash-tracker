import type { Match } from '../match.js';
import { resolveOpponentIdentities } from './opponentEvidence.js';
import {
  isCountableGame,
  isUnknownCharacter,
  stageBucketId,
  UNKNOWN_STAGE_ID,
} from './predicate.js';
import {
  confidenceTierFor,
  effectiveFloor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from './policy.js';
import { getWinLossRecord, type WinLossRecord } from './records.js';
import { describeCohort, type CohortComposition } from './cohort.js';
import type { ClaimKind, ConfidenceTier, SampleMeta, UnknownBucket } from './types.js';

/**
 * OPP-02/D-09/D-16: one opponent's countable games, cross-tabbed by (my
 * character x their character) rows and stage columns, sized by what
 * actually happened rather than by the roster/stage list. This is a
 * RECOMBINATION of four already-proven primitives, imported rather than
 * restated:
 *
 * - Identity resolution (one hop): `resolveOpponentIdentities` from
 *   `./opponentEvidence.js` — this module does no alias/slug matching of
 *   its own.
 * - Countability (one call site): `isCountableGame` from `./predicate.js` —
 *   the filter every cell counter reads from; see that function's own head
 *   comment for why it is currently a documented no-op (D-17) and why the
 *   ROUTING through it, not a runtime exclusion, is what this module's tests
 *   prove.
 * - Confidence thresholds: `confidenceTierFor`/`effectiveFloor` from
 *   `./policy.js` — the one threshold source (D-05).
 * - Win/loss counting: `getWinLossRecord` from `./records.js`.
 *
 * `groupMatchesByKey` below is the one "group by N keys, count a
 * `WinLossRecord`, attach a `SampleMeta`" helper both this module and
 * `stageBreakdown.ts` (Task 3) build their groups on top of — written once,
 * projected differently.
 */

/**
 * Groups a match array by a caller-supplied string key, computing a
 * `WinLossRecord` per group. Shared by `buildOpponentCrossTab` (row/column
 * pair keys) and `stageBreakdown.ts` (identity keys, character-pair keys) so
 * the "group then count" shape exists in exactly one place.
 */
export function groupMatchesByKey(
  matches: Match[],
  keyOf: (match: Match) => string,
): Map<string, { matches: Match[]; record: WinLossRecord }> {
  const byKey = new Map<string, Match[]>();
  for (const match of matches) {
    const key = keyOf(match);
    const group = byKey.get(key);
    if (group) {
      group.push(match);
    } else {
      byKey.set(key, [match]);
    }
  }
  const result = new Map<string, { matches: Match[]; record: WinLossRecord }>();
  for (const [key, groupMatches] of byKey) {
    result.set(key, { matches: groupMatches, record: getWinLossRecord(groupMatches) });
  }
  return result;
}

export interface CrossTabRow {
  /** `${myFighterId}:${theirFighterId}` — numeric ids joined by a colon, never a localized name. */
  rowKey: string;
  myFighterId: number;
  theirFighterId: number;
  /** Countable games across every column for this pairing — the row's own sort key. */
  total: number;
}

export interface CrossTabColumn {
  /** `String(stageId)` — reuse of `stageBucketId`'s numeric result. */
  colKey: string;
  stageId: number;
  /** Countable games across every row for this stage — the column's own sort key (ignored for the unknown-stage column, which always sorts last). */
  total: number;
}

export interface CrossTabCell {
  rowKey: string;
  colKey: string;
  wins: number;
  losses: number;
  total: number;
  /** `null` below `effectiveFloor(minMatches)` — never a reason to omit the cell. */
  confidenceTier: ConfidenceTier | null;
  /** A cross-tab cell is a raw recorded inventory, never ranked — always `'fact'`. */
  kind: ClaimKind;
  sample: SampleMeta;
}

export interface OpponentCrossTab {
  /** Sorted by `total` descending, tie-broken by `myFighterId` then `theirFighterId` ascending. */
  rows: CrossTabRow[];
  /** Sorted by `total` descending tie-broken by `stageId` ascending, with the unknown-stage column always LAST regardless of its total. */
  cols: CrossTabColumn[];
  /** No entry for a pairing/stage combination with zero games — the consumer renders absence, not a zero. */
  cells: CrossTabCell[];
  /**
   * Disclosure summary mirroring the trailing unknown-stage column's own
   * totals (D-09/D-10) — the games themselves still form a real, sortable
   * `cols` entry (`stageId === UNKNOWN_STAGE_ID`, pinned last); this field
   * exists so a consumer can render the disclosure without re-deriving it
   * from `cols`.
   */
  unknownStage: UnknownBucket | null;
  /** Games whose fighter id on either side is outside the known roster (D-25 — synthetic-fixture-only in practice) — excluded from every row/cell, never conflated with a real character pairing. */
  unknownCharacter: UnknownBucket | null;
  cohort: CohortComposition;
  sample: SampleMeta;
}

/**
 * One opponent's countable games, resolved through one identity hop, as a
 * sparse tiered cross-tab. Takes the SAME input shape `buildOpponentProfile`
 * (`opponentEvidence.ts`) already takes, so a caller can invoke both with one
 * argument object.
 */
export function buildOpponentCrossTab(input: {
  matches: Match[];
  aliasMap: Record<string, string>;
  opponentTag: string;
  refreshedAt: number;
  minMatches?: number;
}): OpponentCrossTab {
  const { matches, aliasMap, opponentTag, refreshedAt, minMatches } = input;
  const floor = effectiveFloor(minMatches);

  const resolve = resolveOpponentIdentities(matches, aliasMap);
  const targetIdentity = resolve({ opponent: opponentTag });
  const versus = matches.filter((m) => resolve(m) === targetIdentity);
  const countable = versus.filter(isCountableGame);

  const knownCharacterMatches: Match[] = [];
  let unknownCharGames = 0;
  let unknownCharWins = 0;
  let unknownCharLosses = 0;
  for (const match of countable) {
    if (isUnknownCharacter(match)) {
      unknownCharGames += 1;
      if (match.win) {
        unknownCharWins += 1;
      } else {
        unknownCharLosses += 1;
      }
    } else {
      knownCharacterMatches.push(match);
    }
  }
  const unknownCharacter: UnknownBucket | null =
    unknownCharGames > 0
      ? { games: unknownCharGames, wins: unknownCharWins, losses: unknownCharLosses }
      : null;

  const cellGroups = groupMatchesByKey(
    knownCharacterMatches,
    (m) => `${m.fighter_id}:${m.opponent_id}|${stageBucketId(m)}`,
  );

  const cells: CrossTabCell[] = [];
  const rowTotals = new Map<
    string,
    { myFighterId: number; theirFighterId: number; total: number }
  >();
  const colTotals = new Map<string, { stageId: number; total: number }>();

  for (const [compositeKey, group] of cellGroups) {
    const separatorIndex = compositeKey.lastIndexOf('|');
    const pairKey = compositeKey.slice(0, separatorIndex);
    const stageKeyStr = compositeKey.slice(separatorIndex + 1);
    const [myStr, theirStr] = pairKey.split(':');
    const myFighterId = Number(myStr);
    const theirFighterId = Number(theirStr);
    const stageId = Number(stageKeyStr);

    const { record, matches: cellMatches } = group;
    const times = cellMatches.map((m) => m.time);
    const confidenceTier: ConfidenceTier | null =
      record.total < floor ? null : confidenceTierFor(record.total);
    const sample: SampleMeta = {
      rawSampleSize: record.total,
      eligibleDenominator: record.total,
      knownFieldCoverage: record.total > 0 ? 1 : 0,
      dateRange: { firstMs: Math.min(...times), lastMs: Math.max(...times) },
      refreshedAt,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      recencyTreatment: RECENCY_TREATMENT,
      confidenceTier,
    };

    cells.push({
      rowKey: pairKey,
      colKey: stageKeyStr,
      wins: record.wins,
      losses: record.losses,
      total: record.total,
      confidenceTier,
      kind: 'fact',
      sample,
    });

    const rowAgg = rowTotals.get(pairKey);
    if (rowAgg) {
      rowAgg.total += record.total;
    } else {
      rowTotals.set(pairKey, { myFighterId, theirFighterId, total: record.total });
    }
    const colAgg = colTotals.get(stageKeyStr);
    if (colAgg) {
      colAgg.total += record.total;
    } else {
      colTotals.set(stageKeyStr, { stageId, total: record.total });
    }
  }

  const rows: CrossTabRow[] = [...rowTotals.entries()].map(([rowKey, agg]) => ({
    rowKey,
    myFighterId: agg.myFighterId,
    theirFighterId: agg.theirFighterId,
    total: agg.total,
  }));
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.myFighterId !== b.myFighterId) return a.myFighterId - b.myFighterId;
    return a.theirFighterId - b.theirFighterId;
  });

  const allCols: CrossTabColumn[] = [...colTotals.entries()].map(([colKey, agg]) => ({
    colKey,
    stageId: agg.stageId,
    total: agg.total,
  }));
  const knownCols = allCols.filter((c) => c.stageId !== UNKNOWN_STAGE_ID);
  const unknownCols = allCols.filter((c) => c.stageId === UNKNOWN_STAGE_ID);
  knownCols.sort((a, b) => (b.total !== a.total ? b.total - a.total : a.stageId - b.stageId));
  const cols: CrossTabColumn[] = [...knownCols, ...unknownCols];

  const unknownStageMatches = knownCharacterMatches.filter(
    (m) => stageBucketId(m) === UNKNOWN_STAGE_ID,
  );
  const unknownStage: UnknownBucket | null =
    unknownStageMatches.length > 0
      ? {
          games: unknownStageMatches.length,
          wins: unknownStageMatches.filter((m) => m.win).length,
          losses: unknownStageMatches.filter((m) => !m.win).length,
        }
      : null;

  const rawSampleSize = versus.length;
  const eligibleDenominator = countable.length;
  const times = versus.map((m) => m.time);
  const dateRange =
    times.length > 0 ? { firstMs: Math.min(...times), lastMs: Math.max(...times) } : null;
  const sample: SampleMeta = {
    rawSampleSize,
    eligibleDenominator,
    knownFieldCoverage: rawSampleSize > 0 ? eligibleDenominator / rawSampleSize : 0,
    dateRange,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: eligibleDenominator < floor ? null : confidenceTierFor(eligibleDenominator),
  };

  return {
    rows,
    cols,
    cells,
    unknownStage,
    unknownCharacter,
    cohort: describeCohort(countable),
    sample,
  };
}
