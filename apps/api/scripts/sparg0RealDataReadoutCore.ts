import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import {
  matchRecordSchema,
  buildStageEvidence,
  buildMatchupEvidence,
  ABSTENTION_FLOOR_GAMES,
  SCL_01_BUDGETS,
  BUDGET_SAMPLE_ITERATIONS,
  percentileNearestRank,
  budgetVerdict,
  type Match,
} from '@smash-tracker/shared';

/**
 * Phase 36 Plan 06 Task 4 addendum: the real-account arm of the SCL-01
 * readout. Reads the LOCAL, gitignored export file the owner produced
 * (`sparg0Export.ts`'s output) and runs the SAME engine-compute/gzip-payload
 * measurement the synthetic budgets use, over sparg0's real match shape.
 *
 * READING A LOCAL FILE THE OWNER PRODUCED IS NOT A PRODUCTION READ (D-20)
 * — the agent never touches Firebase/RTDB here.
 *
 * HARD PII BOUNDARY: this module's public return type (`RealDataReadout`)
 * carries AGGREGATE NUMBERS ONLY — counts, milliseconds, bytes, a sha256
 * fingerprint, and a database HOSTNAME (not a credential, not a uid). It
 * never carries the account's uid, any opponent tag, any tournament name,
 * or a single match row. Every function below computes over the parsed
 * `Match[]` and returns only aggregates; none of them return or log the
 * array itself. Do not add a field here that isn't a count/timestamp/byte
 * size — that is the whole point of this boundary.
 */

export interface Sparg0ExportEnvelopeShape {
  matchCount: number;
  matches: unknown[];
  matchesSha256: string;
  databaseHost: string;
}

export interface RealDataReadout {
  matchCountRaw: number;
  matchCountParsed: number;
  skippedCorruptCount: number;
  matchesSha256: string;
  databaseHost: string;

  engineComputeBudgetId: string;
  engineComputeTargetMs: number;
  engineComputeP95Ms: number;
  engineComputeVerdict: 'PASS' | 'MISS';

  gzipPayloadBudgetId: string;
  gzipPayloadTargetBytes: number;
  gzipPayloadBytes: number;
  gzipPayloadVerdict: 'PASS' | 'MISS';

  /** From buildStageEvidence's own SampleMeta — the engine's existing coverage arithmetic, not reimplemented here. */
  knownStageFieldCoveragePct: number;
  unknownStageGames: number;
  unknownCharacterGames: number;

  /** Distinct (fighter_id, opponent_id) pairs — the EVID-01 shape question, counts only. */
  totalFighterOpponentPairs: number;
  pairsClearingFloor: number;
  pairsAbstained: number;
}

function budgetFor(id: string) {
  const budget = SCL_01_BUDGETS.find((b) => b.id === id);
  if (!budget) {
    throw new Error(`missing SCL-01 budget: ${id}`);
  }
  return budget;
}

/**
 * Safe-parse-and-skip over the raw exported values, mirroring
 * `RtdbService.listMatches`'s own corrupt-record handling — a byte-faithful
 * export may carry a record the schema rejects, and the count of skips is
 * itself a useful aggregate, never the record.
 */
export function parseExportedMatches(rawMatches: readonly unknown[]): {
  matches: Match[];
  skippedCorruptCount: number;
} {
  const matches: Match[] = [];
  let skippedCorruptCount = 0;
  rawMatches.forEach((raw, index) => {
    const parsed = matchRecordSchema.safeParse(raw);
    if (!parsed.success) {
      skippedCorruptCount += 1;
      return;
    }
    // A synthetic per-index id — never read by buildStageEvidence/
    // buildMatchupEvidence, only present because the `Match` type requires
    // one and the raw export (via Object.values) does not preserve RTDB
    // push keys (see 36-01-SUMMARY.md's identical synthetic-id precedent).
    matches.push({ id: `real-${index}`, ...parsed.data });
  });
  return { matches, skippedCorruptCount };
}

/** Distinct (fighter_id, opponent_id) pair counts against the abstention floor — counts only, never the pairs themselves. */
export function countFighterOpponentPairs(matches: readonly Match[]): {
  totalFighterOpponentPairs: number;
  pairsClearingFloor: number;
  pairsAbstained: number;
} {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = `${match.fighter_id}:${match.opponent_id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let pairsClearingFloor = 0;
  let pairsAbstained = 0;
  for (const count of counts.values()) {
    if (count >= ABSTENTION_FLOOR_GAMES) {
      pairsClearingFloor += 1;
    } else {
      pairsAbstained += 1;
    }
  }
  return { totalFighterOpponentPairs: counts.size, pairsClearingFloor, pairsAbstained };
}

/** One full engine recompute, identical composition to `computeBudget.budget.test.ts`'s synthetic-fixture measurement. */
function recompute(matches: Match[]): void {
  const refreshedAt = Date.now();
  buildStageEvidence({ matches, refreshedAt });
  buildMatchupEvidence({ matches, refreshedAt });
}

/** Same harness shape as the synthetic budget: warmup + `BUDGET_SAMPLE_ITERATIONS` timed iterations + nearest-rank p95. */
export function measureEngineComputeP95Ms(matches: Match[]): number {
  recompute(matches); // warmup — excluded from the sample
  const samplesMs: number[] = [];
  for (let i = 0; i < BUDGET_SAMPLE_ITERATIONS; i += 1) {
    const start = performance.now();
    recompute(matches);
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);
  return percentileNearestRank(samplesMs, 95);
}

/** Gzip size of the same shape `GET /api/matches` would serialize — never the matches themselves are returned. */
export function measureGzipPayloadBytes(matches: Match[]): number {
  return gzipSync(Buffer.from(JSON.stringify(matches), 'utf8')).length;
}

/**
 * Assembles the full real-account SCL-01 readout from an already-parsed
 * export envelope. Pure — no file I/O, no network, no RTDB. The CLI
 * (`sparg0RealDataReadout.ts`) is the only caller that reads a file, and it
 * hands this function the parsed JSON object.
 */
export function buildRealDataReadout(envelope: Sparg0ExportEnvelopeShape): RealDataReadout {
  const { matches, skippedCorruptCount } = parseExportedMatches(envelope.matches);

  const engineComputeBudget = budgetFor('engine-recompute-p95-8k');
  const engineComputeP95Ms = Math.round(measureEngineComputeP95Ms(matches) * 100) / 100;

  const gzipPayloadBudget = budgetFor('matches-gzip-payload-8k');
  const gzipPayloadBytes = measureGzipPayloadBytes(matches);

  const stageEvidence = buildStageEvidence({ matches, refreshedAt: Date.now() });
  const matchupEvidence = buildMatchupEvidence({ matches, refreshedAt: Date.now() });
  const pairs = countFighterOpponentPairs(matches);

  return {
    matchCountRaw: envelope.matches.length,
    matchCountParsed: matches.length,
    skippedCorruptCount,
    matchesSha256: envelope.matchesSha256,
    databaseHost: envelope.databaseHost,

    engineComputeBudgetId: engineComputeBudget.id,
    engineComputeTargetMs: engineComputeBudget.target,
    engineComputeP95Ms,
    engineComputeVerdict: budgetVerdict(engineComputeP95Ms, engineComputeBudget.target),

    gzipPayloadBudgetId: gzipPayloadBudget.id,
    gzipPayloadTargetBytes: gzipPayloadBudget.target,
    gzipPayloadBytes,
    gzipPayloadVerdict: budgetVerdict(gzipPayloadBytes, gzipPayloadBudget.target),

    knownStageFieldCoveragePct:
      Math.round(stageEvidence.claim.sample.knownFieldCoverage * 10000) / 100,
    unknownStageGames: stageEvidence.unknown?.games ?? 0,
    unknownCharacterGames: matchupEvidence.unknown?.games ?? 0,

    totalFighterOpponentPairs: pairs.totalFighterOpponentPairs,
    pairsClearingFloor: pairs.pairsClearingFloor,
    pairsAbstained: pairs.pairsAbstained,
  };
}

/** One machine-readable `SCL-01-REAL <field>=<value>` line per readout field, for a traceable console/log record. */
export function formatRealDataReadoutLines(readout: RealDataReadout): string[] {
  return Object.entries(readout).map(([field, value]) => `SCL-01-REAL ${field}=${String(value)}`);
}

/** Structural shape check for the JSON a file must have before it is treated as a sparg0 export envelope. */
export function isSparg0ExportEnvelopeShape(value: unknown): value is Sparg0ExportEnvelopeShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.matchCount === 'number' &&
    Array.isArray(record.matches) &&
    typeof record.matchesSha256 === 'string' &&
    typeof record.databaseHost === 'string'
  );
}

/**
 * Reads and shape-validates a sparg0 export envelope from `filePath`. The
 * ONLY function in this module that touches the filesystem — kept isolated
 * so `buildRealDataReadout` above stays a pure, synchronous function over an
 * already-parsed object, testable without any file I/O.
 */
export async function loadSparg0ExportEnvelope(
  filePath: string,
): Promise<Sparg0ExportEnvelopeShape> {
  const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isSparg0ExportEnvelopeShape(raw)) {
    throw new Error(`${filePath} does not match the sparg0 export envelope shape`);
  }
  return raw;
}
