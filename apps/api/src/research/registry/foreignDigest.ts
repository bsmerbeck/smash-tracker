import type { Database } from 'firebase-admin/database';
import { isTournamentRegistryOwnedRow } from '@smash-tracker/shared';
import { canonicalDigest } from './canonical.js';
import { isPathSafeTenantId } from '../subjectKind.js';

/**
 * Phase 30.3 registry-operator hardening (owner directive, Gate 6): the
 * NON-REGISTRY-ROW preservation witness.
 *
 * The projector's whole safety claim is that it touches only children it
 * owns (`isTournamentRegistryOwnedRow`) and leaves manual, start.gg-sync and
 * parry.gg-sync entries byte-for-byte alone. Until now the operator only
 * proved that claim with `preservedForeignCount` — a COUNT, which is blind
 * to the failure that actually matters: a foreign row that was mutated,
 * swapped, or replaced by a different foreign row while the count stayed
 * the same.
 *
 * This module upgrades the witness to a content digest: a sha256 over the
 * canonical JSON of EVERY non-registry-owned child of
 * `tournamentEntries/{uid}`, keys sorted, values included verbatim. The
 * operator records it in each receipt PRE-apply and POST-apply; any change
 * is a failed invariant and a nonzero exit.
 *
 * It lives beside the projector rather than inside the CLI on purpose: the
 * Gate-6 audit tooling must be able to recompute the SAME digest from the
 * SAME code, not from a re-description of it. The only firebase-admin
 * dependency is a type-only import, so a consumer that already holds the
 * entries snapshot can call `computeForeignRowDigest` with no Firebase in
 * the module graph at all.
 */

export const REGISTRY_FOREIGN_DIGEST_VERSION = 1;

export interface ForeignRowDigest {
  /** Digest-rule version. Bumping it changes the hash, deliberately and visibly. */
  version: number;
  /** The account the digest was taken over — bound INTO the hash, so two accounts can never compare equal by accident. */
  uid: string;
  /** How many children are not registry-owned. */
  count: number;
  /** Their child keys, sorted — the human-diffable half of the witness. */
  keys: string[];
  /** sha256 over `{version, uid, rows}` in canonical JSON. */
  digest: string;
}

/**
 * The digest over an ALREADY-READ `tournamentEntries/{uid}` snapshot.
 *
 * Callers should prefer this overload when they already hold the snapshot:
 * deriving the plan and the digest from ONE read makes the two consistent
 * by construction (a second read could observe a different state and
 * produce a receipt whose counts and digest describe different moments).
 *
 * `null`/`undefined` children are ignored: RTDB does not store them, so a
 * key that reads back as one is an absent child, not a foreign row.
 */
export function computeForeignRowDigest(
  uid: string,
  entries: Record<string, unknown>,
): ForeignRowDigest {
  const foreignRows: Record<string, unknown> = {};
  for (const [childKey, value] of Object.entries(entries)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (isTournamentRegistryOwnedRow(value)) {
      continue;
    }
    foreignRows[childKey] = value;
  }
  return {
    version: REGISTRY_FOREIGN_DIGEST_VERSION,
    uid,
    count: Object.keys(foreignRows).length,
    keys: Object.keys(foreignRows).sort(),
    digest: canonicalDigest({
      version: REGISTRY_FOREIGN_DIGEST_VERSION,
      uid,
      rows: foreignRows,
    }),
  };
}

/** Reads `tournamentEntries/{uid}` and digests its foreign children. Read-only. */
export async function readForeignRowDigest(
  database: Database,
  uid: string,
): Promise<ForeignRowDigest> {
  if (!isPathSafeTenantId(uid)) {
    throw new Error(`Unsafe uid: ${uid}`);
  }
  const snapshot = await database.ref(`tournamentEntries/${uid}`).get();
  return computeForeignRowDigest(uid, (snapshot.val() ?? {}) as Record<string, unknown>);
}

/** True when two digests describe byte-identical foreign content for the same account. */
export function foreignRowDigestsMatch(a: ForeignRowDigest, b: ForeignRowDigest): boolean {
  return a.digest === b.digest;
}

/** A one-line, operator-readable description of what changed between two digests. */
export function describeForeignRowDigestDelta(
  before: ForeignRowDigest,
  after: ForeignRowDigest,
): string {
  const beforeKeys = new Set(before.keys);
  const afterKeys = new Set(after.keys);
  const added = after.keys.filter((key) => !beforeKeys.has(key));
  const removed = before.keys.filter((key) => !afterKeys.has(key));
  if (added.length === 0 && removed.length === 0) {
    return (
      `same ${before.count} foreign child key(s), but their CONTENT changed ` +
      `(${before.digest.slice(0, 12)} -> ${after.digest.slice(0, 12)})`
    );
  }
  return (
    `foreign children changed: added=[${added.join(',') || 'none'}] ` +
    `removed=[${removed.join(',') || 'none'}] (${before.count} -> ${after.count})`
  );
}
