import { z } from 'zod';
import { tournamentEntrySchema } from './startgg.js';

/**
 * Phase 30.3 (Tournament Registry Backfill): the shared contract for a
 * HISTORICAL, admin-imported tournament-registry row — the shape the
 * research-source registry projector (`apps/api/src/research/registry/`)
 * writes under `tournamentEntries/{uid}/{entryId}` for the four demo
 * accounts, and the shape the web reads back from `GET /api/tournaments`.
 *
 * Why this exists: the Phase 30.1 migration copied the lossless
 * `researchSource/{uid}/sets` records (and their `matches` projection) onto
 * the demo accounts but wrote NO `tournamentEntries` rows, so the
 * Tournaments tab rendered empty. These rows are derived from those stored
 * start.gg source records — public bracket data imported by an admin —
 * and are labeled truthfully as exactly that:
 *
 * - `origin: 'admin-imported'` is the DISCRIMINATOR. Existing registry
 *   entries (start.gg sync, parry.gg sync, manual) keep their current
 *   shape untouched and never carry this member.
 * - `provider: 'startgg'` records where the underlying public data came
 *   from. It does NOT imply a linked start.gg integration: the projector
 *   never creates `startggLinks`, OAuth state, or any integration status.
 * - `registryWitness` is the generated-row OWNERSHIP witness: refresh
 *   reconciliation may delete a `tournamentEntries` child ONLY when the
 *   stored value carries this projector's witness. Manual and linked-sync
 *   entries are never touched — byte-for-byte.
 *
 * Historical-vs-prep separation: every one of these rows describes a PAST
 * event, so `firstSetAt` is always in the past (or `0` when the provider
 * reported no set timestamps) — the shipped prep gate
 * (`apps/web/src/pages/Tournaments/TournamentDetailPage.tsx`, `firstSetAt >
 * now`) therefore never offers registration/seeded/live prep controls for
 * one, and `origin` gives the web an explicit field to distinguish on.
 *
 * Storage constraint (house RTDB rule, `CONCERNS.md`): every optional
 * member is `.nullish()` and every writer conditional-spreads — an absent
 * member is OMITTED on write, never stored as `null`/`undefined`.
 */

// ---------------------------------------------------------------------------
// Discriminators, key/witness builders
// ---------------------------------------------------------------------------

export const TOURNAMENT_REGISTRY_ORIGIN = 'admin-imported' as const;
export type TournamentRegistryOrigin = typeof TOURNAMENT_REGISTRY_ORIGIN;

/**
 * `entryId` prefix: the RTDB child key of a projected row is
 * `histimport:{startggEventId}` — deterministic from the stable provider
 * event id, so a re-run derives the SAME key and reconciles in place. The
 * prefix can never collide with the three existing writers' key shapes
 * (start.gg sync: `String(eventId)`; parry.gg sync: `pgg-...`; manual:
 * `manual-...`), and `:` is RTDB-path-legal and passes the shipped
 * `ENTRY_KEY_SHAPE` / `entryKeyInputSchema` guards.
 */
export const TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX = 'histimport:';

/**
 * `registryWitness` prefix. Versioned so a future projector revision can
 * widen its ownership claim explicitly instead of guessing from row shape.
 */
export const TOURNAMENT_REGISTRY_WITNESS_PREFIX = 'research-import:v1:';

export function buildTournamentRegistryEntryId(startggEventId: string): string {
  return `${TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX}${startggEventId}`;
}

export function buildTournamentRegistryWitness(startggEventId: string): string {
  return `${TOURNAMENT_REGISTRY_WITNESS_PREFIX}${startggEventId}`;
}

/**
 * The ownership predicate reconciliation trusts: a RAW stored
 * `tournamentEntries` child value is owned by this projector ONLY when it
 * carries BOTH the `origin` discriminator and a witness string with this
 * projector's prefix. Everything else — legacy start.gg rows, parry.gg
 * rows, manual rows, corrupt values — is foreign and must never be
 * rewritten or deleted by a registry refresh.
 */
export function isTournamentRegistryOwnedRow(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.origin === TOURNAMENT_REGISTRY_ORIGIN &&
    typeof record.registryWitness === 'string' &&
    record.registryWitness.startsWith(TOURNAMENT_REGISTRY_WITNESS_PREFIX)
  );
}

// ---------------------------------------------------------------------------
// Row schema
// ---------------------------------------------------------------------------

const MAX_REGISTRY_TEXT = 500;

/**
 * Import provenance. `importedAtMs` is the FIRST-import stamp — the
 * projector preserves an existing row's value on refresh (so an unchanged
 * derivation produces a byte-identical row and the refresh is a no-op);
 * `asOfMs` is the freshness stamp: the max `lastObservedAtMs` across the
 * contributing source records — deterministic from the stored data, never a
 * run clock.
 */
export const tournamentRegistryProvenanceSchema = z.object({
  source: z.literal('research-import'),
  importedAtMs: z.number().int().nonnegative(),
  asOfMs: z.number().int().nonnegative().nullish(),
});
export type TournamentRegistryProvenance = z.infer<typeof tournamentRegistryProvenanceSchema>;

/**
 * One admin-imported historical registry row.
 *
 * Contract deviations from the bare field list this row was specified
 * against, each forced by the shipped `tournamentEntries` readers and
 * documented here rather than improvised:
 *
 * - `tournamentName` is `.nullish()` (the provider may omit it), not
 *   required; `eventName` stays required — the deriver guarantees a
 *   deterministic fallback (`event.slug`, then `start.gg event {id}`).
 * - The row ALSO carries the legacy `tournamentEntrySchema` members
 *   `firstSetAt`/`lastSetAt`/`setsPlayed` (+ `slug`, mirroring
 *   `tournamentSlug`): `packages/shared/src/startgg.ts`'s schema requires
 *   them, and the shipped readers (`GET /api/tournaments` list parse,
 *   `apps/api/src/routes/prep.ts`'s `requireOwnedEntry` — a throwing
 *   `.parse`) would otherwise skip the row or 500 on it. `firstSetAt`/
 *   `lastSetAt` equal `startAtMs`/`endAtMs` when the provider reported set
 *   timestamps, else `0`; `setsPlayed` equals `playedSetCount` exactly.
 * - There is deliberately NO legacy `source` member: its enum
 *   (`'startgg' | 'parrygg' | 'manual'`) has no honest value for an
 *   admin-imported snapshot, and an unknown value would make every legacy
 *   safeParse fail. `origin`/`provider` carry the truth; legacy readers see
 *   an absent `source` (their pre-existing "legacy record" state).
 * - `topStandings` is intentionally ABSENT: full event standings are not
 *   available in the per-player source records, and a top eight must never
 *   be reconstructed from one player's opponents.
 * - `entryKey` is the read-time stamp `GET /api/tournaments` fills from the
 *   RTDB child key (always equal to `entryId`), `.nullish()` here exactly
 *   as it is on `tournamentEntrySchema`.
 */
export const tournamentRegistryRowSchema = z.object({
  /** Deterministic RTDB child key: `histimport:{startggEventId}`. */
  entryId: z.string().min(1).max(200),
  origin: z.literal(TOURNAMENT_REGISTRY_ORIGIN),
  /** Where the public data came from — NOT an integration/OAuth claim. */
  provider: z.literal('startgg'),
  /** The stable start.gg event id the row is grouped by. */
  startggEventId: z.string().min(1).max(200),
  tournamentName: z.string().min(1).max(MAX_REGISTRY_TEXT).nullish(),
  eventName: z.string().min(1).max(MAX_REGISTRY_TEXT),
  /** Tournament-level path slug (e.g. "tournament/the-big-house-9"). */
  tournamentSlug: z.string().min(1).max(MAX_REGISTRY_TEXT).nullish(),
  /** Event-level path slug (e.g. "tournament/.../event/ultimate-singles"). */
  eventSlug: z.string().min(1).max(MAX_REGISTRY_TEXT).nullish(),
  /** Epoch ms of the earliest PLAYED set observed for this event; absent when no set carried a timestamp. */
  startAtMs: z.number().int().nonnegative().nullish(),
  /** Epoch ms of the latest PLAYED set observed for this event; absent when no set carried a timestamp. */
  endAtMs: z.number().int().nonnegative().nullish(),
  numEntrants: z.number().int().positive().nullish(),
  /** The tracked player's seed, when the provider reported one. */
  seed: z.number().int().positive().nullish(),
  /** The tracked player's final placement, when the provider reported one. */
  placement: z.number().int().positive().nullish(),
  /** Sets actually played (`complete` + `no-game-detail`); DQs/byes/walkovers NEVER count here. */
  playedSetCount: z.number().int().nonnegative(),
  /** Explicit marker for retained DQ sets — present only when > 0. */
  dqCount: z.number().int().positive().nullish(),
  provenance: tournamentRegistryProvenanceSchema,
  /** Generated-row ownership witness — see `isTournamentRegistryOwnedRow`. */
  registryWitness: z.string().min(1).max(200),
  // -- legacy tournamentEntrySchema compatibility members (see doc above) --
  firstSetAt: z.number().int().nonnegative(),
  lastSetAt: z.number().int().nonnegative(),
  setsPlayed: z.number().int().nonnegative(),
  /** Legacy alias of `tournamentSlug` (the member name shipped readers know). */
  slug: z.string().min(1).max(MAX_REGISTRY_TEXT).nullish(),
  /** Read-time stamp from the RTDB child key (always equals `entryId`). */
  entryKey: z.string().min(1).nullish(),
});
export type TournamentRegistryRow = z.infer<typeof tournamentRegistryRowSchema>;

/**
 * One `GET /api/tournaments` list element after Phase 30.3: an
 * admin-imported registry row (discriminated by `origin`) or one of the
 * three pre-existing entry shapes. Registry-first union order is
 * load-bearing for serialization: a registry row also satisfies the legacy
 * schema (which would strip its new members), so the registry member must
 * win for rows that match it.
 */
export const tournamentRegistryListEntrySchema = z.union([
  tournamentRegistryRowSchema,
  tournamentEntrySchema,
]);
export type TournamentRegistryListEntry = z.infer<typeof tournamentRegistryListEntrySchema>;

/** `GET /api/tournaments` response — the user's registry, newest first, both shapes. */
export const tournamentRegistryListSchema = z.array(tournamentRegistryListEntrySchema);
export type TournamentRegistryList = z.infer<typeof tournamentRegistryListSchema>;
