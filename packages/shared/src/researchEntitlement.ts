import { z } from 'zod';

/**
 * Phase 29 Plan 10 (Research Tenancy, Isolation & Governance Gate, RTEN-05A,
 * D-09/D-12): the tenant-scoped, history-preserving, replay-safe pilot
 * entitlement record, and the single nested charge-snapshot contract Phase
 * 32's RTEN-05B charge-flow seam will attach to a report job.
 *
 * RTDB layout:
 *
 * - `researchEntitlements/{tenantId}` -> ResearchEntitlementRecord — ONE
 *   node per tenant carrying the active grant, the preserved grant history,
 *   and the durable operations index TOGETHER. This is deliberate: grant and
 *   revoke (`apps/api/src/research/entitlements.ts`) are each a single
 *   `transaction()` on this ONE node, because the operations index (below)
 *   must commit atomically with the grant decision it records — a sibling
 *   node could not be atomic with it. Registered in
 *   `TENANT_DELETION_TREES` (`apps/api/src/coaching/tenants.ts`), the
 *   hard-delete cascade's manifest — deliberately NOT in
 *   `CANONICAL_TENANT_TREES`, the same-subject content manifest, because
 *   this tree has no same-subject route (it is admin-only). See that
 *   module's header comment for the full split rationale.
 *
 * D-09: an entitlement is scoped to exactly one tenant, keyed by tenant id —
 * NEVER uid-wide. A uid-wide grant would make an unrelated personal report
 * free, which is exactly what RTEN-05A forbids.
 *
 * Ordering (review finding 29-09 LOW): `history` is a KEYED RTDB collection,
 * not an ordered list — RTDB child-key ordering is not a contract this
 * module relies on. Each history entry's `grantedAt` is the defined ordering
 * key; a consumer that needs chronological order sorts by it explicitly.
 * Entry keys themselves are opaque (push keys) and carry no meaning.
 *
 * Phase 29 ships this contract but does NOT attach it to
 * `packages/shared/src/reports.ts`'s `reportJobSchema` — plan 29-11 records
 * the RTEN-05A/RTEN-05B re-scope, and Phase 32 owns the attachment. A reader
 * should not go looking for a consumer that does not exist yet.
 */

/**
 * Idempotency-key shape (cycle-3 finding): this value becomes an RTDB map
 * key inside `operations` below, and RTDB child keys reject
 * `. # $ [ ] /`. `FakeDatabase` validates only `ref()` PATHS and `undefined`
 * payload members — it does NOT validate nested payload-object keys — so an
 * illegal caller-supplied key would pass every test built only against the
 * fake and fail only in production. Constraining the shape HERE, at the Zod
 * boundary the grant route's body schema uses, means an illegal key never
 * reaches a write in the first place. Grant identifiers happen to share this
 * shape (`randomUUID()` output fits it) but are never used as an RTDB key
 * themselves — they are stored as plain VALUES (`activeGrant.grantId`,
 * `history/{opaqueKey}.grantId`), so they are not constrained by this same
 * key-safety requirement, only by being non-empty strings.
 */
const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
export const idempotencyKeySchema = z
  .string()
  .regex(IDEMPOTENCY_KEY_SHAPE, 'must be 8-64 chars of [A-Za-z0-9_-] (path-safe RTDB key shape)');
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/** Fields common to the active grant and every terminated history entry. */
const grantFieldsSchema = z.object({
  /** Stable identifier for this specific grant (server-generated, e.g. `randomUUID()`). */
  grantId: z.string().min(1),
  /** The admin uid who created this grant. */
  grantedByUid: z.string().min(1),
  /** Epoch ms this grant was created — pre-generated ONCE outside the transaction callback (CR-01, review 29-09 MEDIUM). */
  grantedAt: z.number().int().nonnegative(),
  /** The idempotency key that created this grant — see `idempotencyKeySchema` above. */
  idempotencyKey: idempotencyKeySchema,
});

/** `researchEntitlements/{tenantId}.activeGrant` — present only while a grant is live. */
export const activeGrantSchema = grantFieldsSchema;
export type ActiveGrant = z.infer<typeof activeGrantSchema>;

/**
 * A terminated grant preserved in `history` (D-09/T-29-10-04): revoking
 * never erases the fact that a grant existed. Carries every active-grant
 * field PLUS the timestamp it was revoked — always present here, since an
 * entry only ever lands in history via revocation.
 */
export const grantHistoryEntrySchema = grantFieldsSchema.extend({
  /** Epoch ms this grant was revoked. */
  revokedAt: z.number().int().nonnegative(),
});
export type GrantHistoryEntry = z.infer<typeof grantHistoryEntrySchema>;

/**
 * The two outcomes a single idempotency-key attempt can resolve to (cycle-2
 * finding C2-HIGH-11): `created` — this key minted a brand-new grant;
 * `observed-existing` — this key arrived while a DIFFERENT grant was already
 * active (either a genuine duplicate call, or a concurrently-LOSING grant
 * attempt re-invoked by the transaction SDK against the winner's committed
 * value) and recorded itself against that grant's identifier instead of
 * creating anything.
 */
export const OPERATION_OUTCOMES = ['created', 'observed-existing'] as const;
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

/**
 * One entry in the operations index, keyed by the idempotency key that
 * produced it. Cycle-2 finding C2-HIGH-11: EVERY grant attempt — winner or
 * loser — writes its own entry here, inside the SAME transaction that
 * decides the outcome, so a concurrently-losing key is never lost. Without
 * this, a losing attempt's key would be recorded nowhere, and replaying it
 * after the winning grant is later revoked would mint a fresh grant —
 * exactly the resurrection this whole design exists to prevent.
 *
 * NEVER pruned. It dies only with the record itself (the deletion cascade
 * removes the whole node) — pruning it would reopen the replay window it
 * exists to close. A future editor must not "clean up" this index as
 * redundant with `history`: history only ever holds entries for grants that
 * were actually created; a losing attempt's key never created a grant at
 * all, so it has no home anywhere else.
 */
export const operationEntrySchema = z.object({
  /** The grant identifier this key resolved to (the winner's, whether this attempt created it or merely observed it). */
  grantId: z.string().min(1),
  outcome: z.enum(OPERATION_OUTCOMES),
  /** Epoch ms this operation was recorded — pre-generated ONCE outside the transaction callback (CR-01, review 29-09 MEDIUM). */
  recordedAt: z.number().int().nonnegative(),
});
export type OperationEntry = z.infer<typeof operationEntrySchema>;

/**
 * `researchEntitlements/{tenantId}` — the whole entitlement record as ONE
 * RTDB node. Every optional member uses the nullish zod modifier (never the
 * plain optional one), because this is a stored shape and RTDB strips
 * absent keys on write — a plain-optional field alone would not survive a
 * round trip through a real read that returns `null` for an absent child.
 */
export const researchEntitlementRecordSchema = z.object({
  /** The currently live grant, or absent/null if none is active. */
  activeGrant: activeGrantSchema.nullish(),
  /** Preserved terminated grants, keyed by an opaque push key — see the module header on ordering. */
  history: z.record(z.string(), grantHistoryEntrySchema).nullish(),
  /** The durable per-idempotency-key operations index — see `operationEntrySchema` above. Never pruned. */
  operations: z.record(z.string(), operationEntrySchema).nullish(),
});
export type ResearchEntitlementRecord = z.infer<typeof researchEntitlementRecordSchema>;

/**
 * D-12: the immutable per-job charge snapshot — written once at submission
 * and never re-derived, so a later revocation cannot retroactively change
 * what an already-charged (or already-waived) unit of work believes about
 * its own charge.
 *
 * Review finding 29-09 HIGH: modeled as ONE nested object schema — NOT three
 * independently-nullish sibling fields on a host record. The "waived
 * requires a grant id" constraint below is a refinement ON THIS OBJECT, so
 * it travels with the object wherever it is attached. Decomposing this into
 * three sibling fields on a host schema would silently discard the
 * refinement (a host object could then carry `chargeMode: 'waived'` with no
 * `grantId` and still parse) — do not do that. The intended attachment
 * shape is a single `.nullish()` member holding this whole object, e.g.
 * `chargeSnapshot: researchChargeSnapshotSchema.nullish()` on a host record;
 * a regression test below proves the refinement survives exactly that
 * attachment shape.
 */
export const CHARGE_MODES = ['waived', 'charged'] as const;
export type ChargeMode = (typeof CHARGE_MODES)[number];

export const researchChargeSnapshotSchema = z
  .object({
    chargeMode: z.enum(CHARGE_MODES),
    /** The entitlement grant that authorized a waiver — required when `chargeMode` is `'waived'`. */
    grantId: z.string().min(1).nullish(),
    /** The subject (tenant or personal uid) this snapshot was recorded for. */
    subjectId: z.string().min(1),
  })
  .refine((snapshot) => snapshot.chargeMode !== 'waived' || snapshot.grantId != null, {
    message: 'a waived charge snapshot must name the entitlement grant that authorized it',
    path: ['grantId'],
  });
export type ResearchChargeSnapshot = z.infer<typeof researchChargeSnapshotSchema>;
