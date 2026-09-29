import {
  TIER_ESTIMATE_LADDER,
  resolveTournamentTier,
  tierLevel,
  type KnownTierWord,
  type TierSetting,
} from './tournamentTier.js';

/**
 * D-01 calibration oracle data. NOT exported from the shared barrel — it is
 * test data and must never reach the web bundle. Consumed by
 * `tournamentTier.calibration.test.ts` (run as
 * `pnpm --filter @smash-tracker/shared run calibrate:tiers`).
 *
 * The ladder is calibrated against events whose tier was RECORDED by an
 * outside source. The designed direction of failure: the entrant-count
 * ladder must never OVER-rate a recorded event (calling a minor a major);
 * under-rating (S Factor's ~600 entrants vs a recorded supermajor) is the
 * expected, honest cost of a count-only heuristic and is labelled "estimated".
 */
export interface TierCalibrationRow {
  id: string;
  eventLabel: string;
  recordedTier: KnownTierWord;
  recordedSource: 'liquipedia' | 'ultrank' | 'synthetic-control';
  /** Repo-relative path of committed bytes the entrant count was read from, or a note for a row awaiting one. */
  evidence: string;
  setting: TierSetting;
  /** Read from committed bytes only. `null` while `status` is `awaiting-owner-probe` — never invent a count (Assumption A4). */
  numEntrants: number | null;
  status: 'active' | 'awaiting-owner-probe';
}

/** Rows with a verified count (ACTIVE) and rows awaiting the owner's probe (plan 39.2-14 fills them). */
export const TIER_CALIBRATION_FIXTURE: readonly TierCalibrationRow[] = [
  {
    id: 'supernova-2026-ultimate',
    eventLabel: 'Supernova 2026 Ultimate Singles',
    recordedTier: 'supermajor',
    recordedSource: 'liquipedia',
    evidence: 'apps/api/src/liquipedia/__fixtures__/query-supernova-2026-tournament.json',
    setting: 'offline',
    numEntrants: 1581,
    status: 'active',
  },
  {
    id: 'ssc-2019-ultimate',
    eventLabel: 'Super Smash Con 2019 Ultimate Singles',
    recordedTier: 'supermajor',
    recordedSource: 'liquipedia',
    evidence: 'apps/api/src/liquipedia/__fixtures__/query-ssc-2019-ultimate.json',
    setting: 'offline',
    numEntrants: 2708,
    status: 'active',
  },
  {
    id: 'sfactor-x3',
    eventLabel: 'S Factor X3 Ultimate Singles',
    recordedTier: 'supermajor',
    recordedSource: 'ultrank',
    evidence: 'UltRank S+; entrant count awaiting the owner probe (plan 39.2-14)',
    setting: 'offline',
    numEntrants: null,
    status: 'awaiting-owner-probe',
  },
  {
    id: 'getonmylevel-2026',
    eventLabel: 'Get On My Level 2026 Ultimate Singles',
    recordedTier: 'supermajor',
    recordedSource: 'ultrank',
    evidence: 'UltRank S; entrant count awaiting the owner probe (plan 39.2-14)',
    setting: 'offline',
    numEntrants: null,
    status: 'awaiting-owner-probe',
  },
  {
    id: 'momocon-2026',
    eventLabel: 'MomoCon 2026 Ultimate Singles',
    recordedTier: 'major',
    recordedSource: 'ultrank',
    evidence: 'UltRank A; entrant count awaiting the owner probe (plan 39.2-14)',
    setting: 'offline',
    numEntrants: null,
    status: 'awaiting-owner-probe',
  },
];

/**
 * SYNTHETIC rows, each labelled `synthetic-control` so no reader mistakes them
 * for external facts. They prove the oracle can fail (a halved ladder
 * over-rates the first), that the F2 gate holds (the second is online and
 * must resolve unknown), and that the designed direction is under-rating (the
 * third).
 */
export const TIER_CALIBRATION_CONTROL_ROWS: readonly TierCalibrationRow[] = [
  {
    id: 'control-minor-300-offline',
    eventLabel: 'Synthetic control minor at 300 offline',
    recordedTier: 'minor',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 300,
    status: 'active',
  },
  {
    id: 'control-regional-8000-online',
    eventLabel: 'Synthetic control regional at 8000 online',
    recordedTier: 'regional',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'online',
    numEntrants: 8000,
    status: 'active',
  },
  {
    id: 'control-supermajor-600-offline',
    eventLabel: 'Synthetic control supermajor at 600 offline',
    recordedTier: 'supermajor',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 600,
    status: 'active',
  },
];

type Ladder = readonly { tier: KnownTierWord; minEntrants: number }[];

function isEvaluable(row: TierCalibrationRow): row is TierCalibrationRow & { numEntrants: number } {
  return row.status === 'active' && row.numEntrants != null;
}

/** Resolves an ACTIVE row through the real resolver so the F2 online/unknown gate is exercised, not bypassed. */
function estimatedLevel(row: TierCalibrationRow & { numEntrants: number }, ladder: Ladder): number {
  const resolution = resolveTournamentTier({
    entry: {
      eventName: row.eventLabel,
      numEntrants: row.numEntrants,
      isOnline: row.setting === 'offline' ? false : row.setting === 'online' ? true : null,
    },
    ladder,
  });
  // A row that resolves unknown is neither over- nor under-rated.
  return resolution.tier === 'unknown' ? -1 : resolution.level;
}

/** ACTIVE rows whose ESTIMATED tier ranks above the recorded tier (the ladder over-rates). Awaiting rows are never evaluated. */
export function findOverRatedEvents(
  rows: readonly TierCalibrationRow[],
  ladder: Ladder = TIER_ESTIMATE_LADDER,
): TierCalibrationRow[] {
  return rows.filter(
    (row) =>
      isEvaluable(row) &&
      estimatedLevel(row, ladder) !== -1 &&
      estimatedLevel(row, ladder) > tierLevel(row.recordedTier),
  );
}

/** ACTIVE rows whose ESTIMATED tier ranks below the recorded tier (the designed, honest direction of error). */
export function findUnderRatedEvents(
  rows: readonly TierCalibrationRow[],
  ladder: Ladder = TIER_ESTIMATE_LADDER,
): TierCalibrationRow[] {
  return rows.filter(
    (row) =>
      isEvaluable(row) &&
      estimatedLevel(row, ladder) !== -1 &&
      estimatedLevel(row, ladder) < tierLevel(row.recordedTier),
  );
}

/** Ids of rows awaiting the owner's probe — reported, counted, never given an invented entrant count. */
export function skippedCalibrationRows(rows: readonly TierCalibrationRow[]): string[] {
  return rows.filter((row) => !isEvaluable(row)).map((row) => row.id);
}
