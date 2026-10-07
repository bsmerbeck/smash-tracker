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

/**
 * Rows with a verified count (ACTIVE). Evidence is either a committed fixture path or an
 * `owner start.gg probe <date>: <event slug> …` string (plan 39.2-14).
 *
 * competitionTier finding (owner probe 2026-09-30): start.gg `Event.competitionTier` read 5 on EVERY
 * event probed, including other games' side events (a 12-entrant GOML side event, a 20-entrant
 * basketball event). It does not discriminate tier and is unusable as a tier source (Phase 42 input;
 * no code reads it). Also probed, not calibration rows: The Cashbox #28 tournament/the-cashbox-28/event/ultimate-singles
 * (494 entrants, isOnline TRUE, type 1) and El Dojo Masters #3 Ultimate Master Singles PRO (40) / Amateur (34), offline.
 */
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
    evidence:
      'owner start.gg probe 2026-09-30: tournament/s-factor-x3/event/smash-bros-ultimate-singles numEntrants 1325 isOnline false type 1 competitionTier 5 (recorded tier: UltRank S+)',
    setting: 'offline',
    numEntrants: 1325,
    status: 'active',
  },
  {
    id: 'getonmylevel-2026',
    eventLabel: 'Get On My Level 2026 Ultimate Singles',
    recordedTier: 'supermajor',
    recordedSource: 'ultrank',
    evidence:
      'owner start.gg probe 2026-09-30: tournament/get-on-my-level-2026-canadian-fighting-game-championships/event/super-smash-bros-ultimate-singles numEntrants 512 isOnline false type 1 competitionTier 5 (recorded tier: UltRank S)',
    setting: 'offline',
    numEntrants: 512,
    status: 'active',
  },
  {
    id: 'momocon-2026',
    eventLabel: 'MomoCon 2026 Ultimate Singles',
    recordedTier: 'major',
    recordedSource: 'ultrank',
    evidence:
      'owner start.gg probe 2026-09-30: tournament/momocon-2026-5/event/super-smash-bros-ultimate-singles numEntrants 453 isOnline false type 1 competitionTier 5 (recorded tier: UltRank A)',
    setting: 'offline',
    numEntrants: 453,
    status: 'active',
  },
];

/**
 * SYNTHETIC rows, each labelled `synthetic-control` so no reader mistakes them
 * for external facts. They prove the oracle can fail (a halved ladder
 * over-rates the first), that the F2 gate holds (the second is online and
 * must resolve unknown), and that the designed direction is under-rating (the
 * third).
 *
 * 39.2-REVIEW SH-WR-01: the recorded rows are all major or above, so on their
 * own they cannot catch over-rating at the local / regional / minor rungs —
 * where nearly every real event resolves. The sub-major controls below sit
 * under each rung's threshold (a 3- and a 40-entrant local, a 200-entrant
 * regional, a 400-entrant minor, an 800-entrant major), so a ladder that
 * lowers ANY rung over-rates at least one of them. They stand in until
 * recorded low-rung rows (UltRank C/D regionals, Liquipedia-tiered locals)
 * are read from committed bytes.
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
    id: 'control-local-3-offline',
    eventLabel: 'Synthetic control local at 3 offline',
    recordedTier: 'local',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 3,
    status: 'active',
  },
  {
    id: 'control-local-40-offline',
    eventLabel: 'Synthetic control local at 40 offline',
    recordedTier: 'local',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 40,
    status: 'active',
  },
  {
    id: 'control-regional-200-offline',
    eventLabel: 'Synthetic control regional at 200 offline',
    recordedTier: 'regional',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 200,
    status: 'active',
  },
  {
    id: 'control-minor-400-offline',
    eventLabel: 'Synthetic control minor at 400 offline',
    recordedTier: 'minor',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 400,
    status: 'active',
  },
  {
    id: 'control-major-800-offline',
    eventLabel: 'Synthetic control major at 800 offline',
    recordedTier: 'major',
    recordedSource: 'synthetic-control',
    evidence: 'synthetic control — no external source',
    setting: 'offline',
    numEntrants: 800,
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
