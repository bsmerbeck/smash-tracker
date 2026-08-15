import type { Database } from 'firebase-admin/database';
import {
  isTournamentRegistryOwnedRow,
  researchSourceSetRecordSchema,
  TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX,
  tournamentRegistryRowSchema,
  type TournamentRegistryRow,
} from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../subjectKind.js';
import { recordsDeepEqual } from '../migration/manifest.js';
import { deriveTournamentRegistryFromResearchSource } from './derive.js';

/**
 * Phase 30.3 (Tournament Registry Backfill): the DESTINATION-ONLY
 * projector. Reads `researchSource/{uid}/sets/*` (the records the Phase
 * 30.1 migration already copied onto the demo destination uid), derives the
 * admin-imported registry rows via the pure `derive.ts`, and reconciles
 * `tournamentEntries/{uid}` against them. It NEVER contacts start.gg, never
 * reads or writes `startggLinks`/OAuth state, and never touches a source
 * research tenant — the uid it is given IS the destination.
 *
 * Split into a READ-ONLY planner and a writer on purpose, mirroring the
 * dry-run→apply CLI contract: `planTournamentRegistry` performs zero
 * writes (the CLI's `dry-run` calls exactly it, so `writesPerformed: 0`
 * is structural, not a promise), and `applyTournamentRegistryPlan` is the
 * only writer.
 *
 * Ownership discipline (the witness contract):
 * - A refresh may overwrite or delete ONLY a child that satisfies
 *   `isTournamentRegistryOwnedRow` — origin discriminator plus this
 *   projector's witness prefix. Manual, start.gg-sync, and parry.gg-sync
 *   entries are preserved byte-for-byte: they are never rewritten, and a
 *   foreign value squatting on a `histimport:` key is reported as a
 *   collision and left untouched (strict no-silent-merge).
 * - Every write and every orphan delete runs through its own per-record
 *   conditional `transaction()` (the `copyTree` pattern from
 *   `../migration/manifest.ts`), so a foreign value that lands between
 *   plan and apply aborts the write instead of being clobbered.
 * - `provenance.importedAtMs` is a FIRST-import stamp: when the existing
 *   child is an owned row, its stamp is carried forward, which is what
 *   makes a content-unchanged refresh produce zero writes.
 */

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface TournamentRegistryPlan {
  uid: string;
  /** entryId -> final row for every child the apply step would write. */
  writes: Record<string, TournamentRegistryRow>;
  creates: string[];
  updates: string[];
  /** Derived rows whose existing stored child is already deep-equal — no write. */
  unchanged: string[];
  /** Derived rows whose `histimport:` key is occupied by a FOREIGN value — never written. */
  collisions: string[];
  /** Witness-owned children no longer derived — the apply step deletes exactly these. */
  orphanRemovals: string[];
  /** Children that are not witness-owned — never touched in any way. */
  preservedForeignCount: number;
  /** Stored source children that failed the source-record schema (skipped, counted). */
  corruptSourceRecords: number;
  sourceSetCount: number;
  skippedNoEventId: number;
  skippedUnsafeEventId: number;
  skippedExcludedClassification: number;
  /** The full derived row set (importedAtMs already resolved), sorted by entryId. */
  derivedRows: TournamentRegistryRow[];
}

function readOwnedImportedAtMs(value: unknown): number | null {
  // Only called for values that already passed `isTournamentRegistryOwnedRow`;
  // the schema parse still guards against a structurally-owned but corrupt row.
  const parsed = tournamentRegistryRowSchema.safeParse(value);
  return parsed.success ? parsed.data.provenance.importedAtMs : null;
}

/**
 * READ-ONLY: derives the registry rows for `uid` and diffs them against the
 * live `tournamentEntries/{uid}` children. Performs no write of any kind.
 */
export async function planTournamentRegistry(
  database: Database,
  uid: string,
  nowMs: number,
): Promise<TournamentRegistryPlan> {
  if (!isPathSafeTenantId(uid)) {
    throw new Error(`Unsafe uid: ${uid}`);
  }

  const sourceSnapshot = await database.ref(`researchSource/${uid}/sets`).get();
  const rawSets = (sourceSnapshot.val() ?? {}) as Record<string, unknown>;

  let corruptSourceRecords = 0;
  const records = Object.entries(rawSets).flatMap(([, value]) => {
    // safeParse-and-skip (production-gap rule, mirrors listMatches/
    // GET /tournaments): one corrupt source record must never abort the
    // whole backfill — it is skipped and counted.
    const parsed = researchSourceSetRecordSchema.safeParse(value);
    if (!parsed.success) {
      corruptSourceRecords += 1;
      return [];
    }
    return [parsed.data];
  });

  const derivation = deriveTournamentRegistryFromResearchSource(records, {
    importedAtMs: nowMs,
  });

  const entriesSnapshot = await database.ref(`tournamentEntries/${uid}`).get();
  const rawEntries = (entriesSnapshot.val() ?? {}) as Record<string, unknown>;

  const writes: Record<string, TournamentRegistryRow> = {};
  const creates: string[] = [];
  const updates: string[] = [];
  const unchanged: string[] = [];
  const collisions: string[] = [];
  const derivedRows: TournamentRegistryRow[] = [];

  for (const row of derivation.rows) {
    const existing = rawEntries[row.entryId];
    if (existing === undefined) {
      derivedRows.push(row);
      writes[row.entryId] = row;
      creates.push(row.entryId);
      continue;
    }
    if (!isTournamentRegistryOwnedRow(existing)) {
      // Strict no-silent-merge: a foreign value on this projector's key is
      // reported and NEVER written over.
      derivedRows.push(row);
      collisions.push(row.entryId);
      continue;
    }
    const existingImportedAtMs = readOwnedImportedAtMs(existing);
    const finalRow: TournamentRegistryRow =
      existingImportedAtMs !== null
        ? {
            ...row,
            provenance: { ...row.provenance, importedAtMs: existingImportedAtMs },
          }
        : row;
    derivedRows.push(finalRow);
    if (recordsDeepEqual(existing, finalRow)) {
      unchanged.push(row.entryId);
    } else {
      writes[row.entryId] = finalRow;
      updates.push(row.entryId);
    }
  }

  const derivedIds = new Set(derivation.rows.map((row) => row.entryId));
  const orphanRemovals: string[] = [];
  let preservedForeignCount = 0;
  for (const [childKey, value] of Object.entries(rawEntries)) {
    if (!isTournamentRegistryOwnedRow(value)) {
      preservedForeignCount += 1;
      continue;
    }
    if (!derivedIds.has(childKey)) {
      orphanRemovals.push(childKey);
    }
  }
  orphanRemovals.sort();

  return {
    uid,
    writes,
    creates: creates.sort(),
    updates: updates.sort(),
    unchanged: unchanged.sort(),
    collisions: collisions.sort(),
    orphanRemovals,
    preservedForeignCount,
    corruptSourceRecords,
    sourceSetCount: Object.keys(rawSets).length,
    skippedNoEventId: derivation.skippedNoEventId,
    skippedUnsafeEventId: derivation.skippedUnsafeEventId,
    skippedExcludedClassification: derivation.skippedExcludedClassification,
    derivedRows,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface TournamentRegistryApplyResult {
  uid: string;
  /** Rows actually committed (created or updated). */
  written: string[];
  /** Witness-owned orphans actually deleted. */
  removed: string[];
  /** Writes/deletes aborted because a FOREIGN value was present at commit time. */
  abortedForeign: string[];
  writesPerformed: number;
}

/**
 * The ONLY writer. Each planned write/delete is its own conditional
 * per-record transaction: absent -> create; witness-owned -> replace
 * (carrying the existing first-import stamp forward); foreign -> abort and
 * report, NEVER clobber. Orphan deletes abort the same way when the child
 * turns out to be foreign at commit time.
 */
export async function applyTournamentRegistryPlan(
  database: Database,
  plan: TournamentRegistryPlan,
): Promise<TournamentRegistryApplyResult> {
  const { uid } = plan;
  if (!isPathSafeTenantId(uid)) {
    throw new Error(`Unsafe uid: ${uid}`);
  }

  const written: string[] = [];
  const removed: string[] = [];
  const abortedForeign: string[] = [];

  for (const [entryId, row] of Object.entries(plan.writes)) {
    if (!entryId.startsWith(TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX)) {
      // Defense in depth: the planner only ever emits histimport: keys; a
      // foreign key here is a programming bug, not a data condition.
      throw new Error(`Refusing to write a non-registry entry key: ${entryId}`);
    }
    const result = await database
      .ref(`tournamentEntries/${uid}/${entryId}`)
      .transaction((current) => {
        if (current === null || current === undefined) {
          return row; // absent — create
        }
        if (!isTournamentRegistryOwnedRow(current)) {
          return undefined; // foreign — abort, never clobber
        }
        // Owned — replace, but preserve the stored first-import stamp the
        // plan may not have seen (a concurrent first write is still ours).
        const storedImportedAtMs = readOwnedImportedAtMs(current);
        return storedImportedAtMs !== null
          ? { ...row, provenance: { ...row.provenance, importedAtMs: storedImportedAtMs } }
          : row;
      });
    if (result.committed) {
      written.push(entryId);
    } else {
      abortedForeign.push(entryId);
    }
  }

  for (const entryId of plan.orphanRemovals) {
    const result = await database
      .ref(`tournamentEntries/${uid}/${entryId}`)
      .transaction((current) => {
        if (current === null || current === undefined) {
          return null; // already absent — a harmless no-op delete
        }
        return isTournamentRegistryOwnedRow(current) ? null : undefined;
      });
    if (result.committed) {
      removed.push(entryId);
    } else {
      abortedForeign.push(entryId);
    }
  }

  return {
    uid,
    written: written.sort(),
    removed: removed.sort(),
    abortedForeign: abortedForeign.sort(),
    writesPerformed: written.length + removed.length,
  };
}

// ---------------------------------------------------------------------------
// Convenience composition
// ---------------------------------------------------------------------------

export interface TournamentRegistryProjectionResult {
  plan: TournamentRegistryPlan;
  apply: TournamentRegistryApplyResult;
}

/** Plan + apply in one call — what tests and any future server-side refresh use. */
export async function projectTournamentRegistry(
  database: Database,
  uid: string,
  nowMs: number,
): Promise<TournamentRegistryProjectionResult> {
  const plan = await planTournamentRegistry(database, uid, nowMs);
  const apply = await applyTournamentRegistryPlan(database, plan);
  return { plan, apply };
}
