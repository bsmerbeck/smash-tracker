import { z } from 'zod';
import {
  RESEARCH_PROVENANCE_CONTENT_TYPES,
  type ResearchProvenanceContentType,
  type ResearchProvenanceOrigin,
} from './researchProvenance.js';

/**
 * Phase 30 (start.gg Lossless Ingestion & Four-Player Coverage Audit,
 * ING-03/ING-05/ING-08): the ONE shared home for every stored shape the
 * ingestion pipeline reads and writes. Both `apps/api` and `apps/web` import
 * these declarations directly rather than each keeping a local copy — that
 * is what lets waves 2 and 3 of this phase run in parallel against one
 * contract instead of four divergent ones.
 *
 * RTDB layout this file governs:
 *
 * - `researchSource/{tenantId}/sets/{providerSetId}` -> `ResearchSourceSetRecord`
 *   (D-01, D-03) — the provider SET is the source record; DQ/bye/walkover/
 *   no-game sets are first-class records keyed by the stable provider set
 *   id (or a derived-safe key — see `storageKey` below).
 * - `researchSupplements/{tenantId}/{targetSetId}/{supplementId}` ->
 *   `ResearchSupplementRecord` (D-05) — a sibling overlay tree that NEVER
 *   mutates a provider record.
 * - `researchIdentity/{tenantId}` -> `ResearchIdentityMapping` (D-10).
 * - `researchIngestionRuns/{tenantId}` -> `ResearchTenantIngestionState`
 *   (D-06, D-16).
 * - `researchCoverage/{tenantId}` -> `ResearchCoverageSnapshot` (D-15, D-16).
 *
 * Every optional member below uses the `.nullish()` zod modifier (house
 * constraint 1, the 260725-juj outage class) — never the plain-optional
 * modifier — because these are STORED shapes and RTDB strips absent keys on
 * write; every writer that touches one of these trees conditional-spreads.
 * Unknown character / unknown stage / unknown online context are ABSENT
 * fields counted explicitly in the named-gaps rollup (D-04) — NEVER sentinel
 * values, and never silently defaulted to a "known" state.
 *
 * Timestamp-unit convention (review C-M3), binding on every sibling plan:
 * every member THIS system generates carries an explicit `Ms` suffix and
 * holds epoch MILLISECONDS. Every member copied verbatim from start.gg keeps
 * the provider's own name and holds whatever unit the provider uses — for
 * `completedAt`, `createdAt`, and `updatedAt` that unit is epoch SECONDS
 * (`apps/api/src/startgg/sync.ts` already establishes `completedAt * 1000`
 * at its own storage boundary). A member that crosses the boundary is
 * renamed at the crossing (`updatedAfterSeconds` on the cursor is a
 * provider-facing filter value; `earliestSetAtMs`/`latestSetAtMs` on the
 * coverage snapshot are derived, rendered values). No member may hold a unit
 * its name does not state. `providerSecondsToMs` below is the single
 * conversion site.
 *
 * Projected-row member ownership (D-21, review C3-H3 — this REVERSES an
 * earlier cycle-2 draft): on a legacy match row produced by the research
 * projection, `vodUrl` stays a USER-OWNED annotation, exactly as the shipped
 * service already classifies it (`apps/api/src/services/rtdb.ts`,
 * `changesSyncOwnedFields`'s doc comment: "User-owned annotations — `notes`,
 * `vodUrl`, `vodTimestamps`, `gsp` — ... stay editable on any match") and as
 * the shipped edit flow already accepts it
 * (`apps/web/src/components/match-form/EditMatchForm.tsx`). The provider's
 * VOD URL is applied FILL-EMPTY-ONLY: it lands only when the row carries no
 * value; a provider change never overwrites a non-empty value, and a
 * provider absence never deletes one. The accepted consequence is that a
 * human-entered URL can go stale relative to the provider's — DISCLOSED in
 * the Data Coverage panel and in `30-COVERAGE-AUDIT.md`, never silently
 * repaired. The REJECTED alternative — classifying `vodUrl` as
 * provider-owned — would have deleted, on the next refresh, data the
 * shipped UI still accepts: an irreversible user-data-loss path. The
 * supplement tree (`researchSupplementRecordSchema`) remains the home for an
 * ATTRIBUTED VOD reference (a `manual`/`vod` supplement carrying who
 * recorded it and when); it is no longer the only legal home for a URL.
 * Plan 30-03 implements the fill-empty-only merge.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The classification a stored source set carries. `no-game-detail` (review
 * C-H4) is the honest bucket for a set the provider reports as completed
 * while returning no per-game rows — start.gg routinely returns a real
 * played set with a populated `displayScore` and an empty `games` array, so
 * absence of game rows is NOT evidence of a walkover. `walkover` remains a
 * member because D-03 names it, but plan 30-03's `R-WALKOVER-EXPLICIT` rule
 * reaches it ONLY from a provider-explicit token, never from an absence.
 */
export const RESEARCH_SET_CLASSIFICATIONS = [
  'complete',
  'dq',
  'bye',
  'walkover',
  'no-game',
  'no-game-detail',
  'non-singles',
  'non-ssbu',
  'unresolved',
] as const;
export type ResearchSetClassification = (typeof RESEARCH_SET_CLASSIFICATIONS)[number];

export const RESEARCH_INGESTION_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type ResearchIngestionRunStatus = (typeof RESEARCH_INGESTION_RUN_STATUSES)[number];

export const RESEARCH_INGESTION_MODES = ['full', 'refresh'] as const;
export type ResearchIngestionMode = (typeof RESEARCH_INGESTION_MODES)[number];

export const RESEARCH_SUPPLEMENT_SOURCE_KINDS = ['manual', 'vod'] as const;
export type ResearchSupplementSourceKind = (typeof RESEARCH_SUPPLEMENT_SOURCE_KINDS)[number];

/** The single classification that may reach `matches/{tenantId}` (ING-03's structural guarantee). */
export const RESEARCH_PROJECTED_CLASSIFICATIONS = ['complete'] as const;
export type ResearchProjectedClassification = (typeof RESEARCH_PROJECTED_CLASSIFICATIONS)[number];

/**
 * The outcomes ING-04 requires to be visibly marked as excluded from
 * win-rate denominators — exported so the panel's excluded-outcomes section
 * and the coverage audit read ONE list rather than each hard-coding three
 * names.
 */
export const RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS = [
  'dq',
  'bye',
  'walkover',
  'no-game-detail',
] as const;
export type ResearchExcludedOutcomeClassification =
  (typeof RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS)[number];

// ---------------------------------------------------------------------------
// Provider-key safety predicate
// ---------------------------------------------------------------------------

/**
 * The excluded set is exactly: `.` `#` `$` `[` `]` `/` U+0000-U+001F U+007F.
 * A HYPHEN IS ALLOWED and a SPACE IS ALLOWED — this is deliberate and
 * load-bearing, not an oversight (review C-H1):
 *
 * 1. This is semantically identical to `apps/api/src/services/rtdb.ts`'s
 *    `ENTRY_KEY_SHAPE` (same escaped form, copied byte-for-byte) and to
 *    `apps/api/src/research/subjectKind.ts`'s `TENANT_ID_SHAPE` (same
 *    excluded range, spelled with literal control bytes there — this file
 *    deliberately uses the escaped form instead, because literal control
 *    bytes render as invisible whitespace in every diff/review tool, which
 *    is precisely what made an earlier draft of this predicate
 *    unreviewable). `apps/api/src/research/providerKeyParity.test.ts`
 *    (plan 30-01 Task 3) proves the equivalence mechanically.
 * 2. Rejecting a hyphen would reject every research tenant id, because
 *    `apps/api/src/coaching/tenants.ts` mints them with `randomUUID()`.
 *    Every ingestion module guards its `tenantId` with this class of
 *    predicate, so a stricter predicate would make every upsert return a
 *    rejected-key outcome and the entire pipeline would no-op while passing
 *    its own tests.
 * 3. A space is allowed because both shipped predicates allow it and this
 *    predicate must never be STRICTER than the reference it claims to
 *    mirror; provider set/entrant/player ids are numeric strings, so no real
 *    key exercises the case either way.
 *
 * Lives in shared (rather than a local copy per module) because five
 * separate ingestion modules construct provider-derived refs; API-side
 * callers guard a TENANT id with the shipped `isPathSafeTenantId`
 * (`apps/api/src/research/subjectKind.ts`) and a PROVIDER id with this one,
 * so neither package owns a second definition of the other's concern.
 */
// eslint-disable-next-line no-control-regex -- mirrors rtdb.ts's ENTRY_KEY_SHAPE (escaped form, never literal control bytes; review C-H1)
const PROVIDER_ID_SHAPE = /^[^.#$[\]/\u0000-\u001f\u007f]{1,200}$/;

export function isPathSafeProviderId(value: string): boolean {
  return PROVIDER_ID_SHAPE.test(value);
}

/**
 * Deliberately far narrower than the RTDB key class above (review C-H11): a
 * supplement id is derived from the field name, so any sanitizing transform
 * would both admit forbidden input and collapse two distinct field names
 * onto one id, silently overwriting one supplement with another. Invalid
 * field names are REJECTED, never sanitized.
 */
const SUPPLEMENT_FIELD_SHAPE = /^[A-Za-z0-9_]{1,64}$/;

export function isValidSupplementField(value: string): boolean {
  return SUPPLEMENT_FIELD_SHAPE.test(value);
}

/**
 * start.gg timestamps are epoch SECONDS; every timestamp this system
 * stores, publishes, and renders is epoch MILLISECONDS
 * (`apps/api/src/startgg/sync.ts` already establishes the `* 1000`
 * conversion at its own storage boundary). This is the SINGLE conversion
 * site so no consumer has to remember which side of the boundary it is on
 * (review C-M3). Returns `null` for `null`/`undefined`/non-finite input —
 * never `NaN`, never zero.
 */
export function providerSecondsToMs(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  return seconds * 1000;
}

// ---------------------------------------------------------------------------
// Bound constants
// ---------------------------------------------------------------------------

export const RESEARCH_RUN_HISTORY_LIMIT = 10;
export const RESEARCH_LEASE_TTL_MS = 120_000;
export const RESEARCH_REFRESH_OVERLAP_SECONDS = 86_400;
export const RESEARCH_MAX_CONFIRMED_PLAYER_IDS = 50;
export const RESEARCH_MAX_IDENTITY_CANDIDATES = 500;
export const RESEARCH_MAX_ENTRANTS_PER_SET = 8;
export const RESEARCH_MAX_PARTICIPANTS_PER_ENTRANT = 128;
export const RESEARCH_MAX_PLAYER_IDS_PER_SET = 256;
export const RESEARCH_MAX_GAMES_PER_SET = 200;
export const RESEARCH_MAX_PROJECTED_MATCH_KEYS = 200;
export const RESEARCH_MAX_PROVIDER_TEXT = 500;
export const RESEARCH_MAX_SUPPLEMENT_TEXT = 2000;
export const RESEARCH_MAX_URL = 2048;
/**
 * A supplement id is one per `(sourceKind, field)` pair, and the field-name
 * class above admits effectively unbounded distinct names, so the per-set
 * child map has no natural ceiling. Writers are dual-gated admins, so the
 * practical risk is low — but "low risk" is not a bound, and every other
 * collection in this file carries one (review C2-A2). Plan 30-04 enforces
 * this cap at the write boundary: a NEW supplement id is rejected once the
 * set already holds this many, but REPLACING an existing id is always
 * allowed, so the cap can never strand an admin editing what already exists.
 */
export const RESEARCH_MAX_SUPPLEMENTS_PER_SET = 50;

// ---------------------------------------------------------------------------
// Provenance / provider-shape building blocks
// ---------------------------------------------------------------------------

export const researchApiIdsSchema = z.object({
  setId: z.string().min(1).max(200),
  eventId: z.string().max(200).nullish(),
  tournamentId: z.string().max(200).nullish(),
  phaseGroupId: z.string().max(200).nullish(),
  entrantIds: z.array(z.string().max(200)).max(16).nullish(),
  playerIds: z.array(z.string().max(200)).max(RESEARCH_MAX_PLAYER_IDS_PER_SET).nullish(),
});
export type ResearchApiIds = z.infer<typeof researchApiIdsSchema>;

/**
 * The four provenance members every source record carries. Declared once
 * here and INLINED (via `.shape` spread, never nested) into
 * `researchSourceSetRecordSchema` below, so the record's own field list
 * documents its provenance directly rather than through an indirection.
 *
 * `lastObservedAtMs` (review C3-H5) holds the FETCH-SNAPSHOT timestamp of
 * the page attempt whose data this record carries — one value per page
 * attempt, captured when that page's fetch resolved — NEVER the clock at
 * the moment of the write. A write clock cannot order two observations,
 * which is exactly what plan 30-03's stale-write guard has to do when a
 * lease expired mid-page and a stale holder wakes up holding older provider
 * content.
 */
export const researchProvenanceSchema = z.object({
  apiIds: researchApiIdsSchema,
  ingestionRunId: z.string().min(1).max(200),
  fetchedAtMs: z.number().int().nonnegative(),
  lastObservedAtMs: z.number().int().nonnegative(),
});
export type ResearchProvenance = z.infer<typeof researchProvenanceSchema>;

export const researchSourceParticipantSchema = z.object({
  playerId: z.string().max(200).nullish(),
  /** VERBATIM, sponsor prefix intact (D-13) — normalization happens only at the legacy projection boundary. */
  gamerTag: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  userSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
});
export type ResearchSourceParticipant = z.infer<typeof researchSourceParticipantSchema>;

export const researchSourceEntrantSchema = z.object({
  entrantId: z.string().min(1).max(200),
  /** VERBATIM, sponsor prefix intact (D-13). */
  name: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  isDisqualified: z.boolean().nullish(),
  initialSeedNum: z.number().int().nullish(),
  seedNum: z.number().int().nullish(),
  placement: z.number().int().nullish(),
  participants: z
    .array(researchSourceParticipantSchema)
    .max(RESEARCH_MAX_PARTICIPANTS_PER_ENTRANT)
    .nullish(),
});
export type ResearchSourceEntrant = z.infer<typeof researchSourceEntrantSchema>;

const researchSourceGameSelectionSchema = z.object({
  entrantId: z.string().max(200).nullish(),
  characterId: z.union([z.number(), z.string()]).nullish(),
});
export type ResearchSourceGameSelection = z.infer<typeof researchSourceGameSelectionSchema>;

export const researchSourceGameSchema = z.object({
  gameId: z.union([z.number(), z.string()]).nullish(),
  winnerEntrantId: z.string().max(200).nullish(),
  stageId: z.union([z.number(), z.string()]).nullish(),
  stageName: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  selections: z
    .array(researchSourceGameSelectionSchema)
    .max(RESEARCH_MAX_ENTRANTS_PER_SET)
    .nullish(),
  entrant1Score: z.number().int().nullish(),
  entrant2Score: z.number().int().nullish(),
});
export type ResearchSourceGame = z.infer<typeof researchSourceGameSchema>;

/**
 * An absent `isOnline` is the "unknown online context" gap D-04 names — it
 * is NEVER defaulted to offline. An absent `videogameId` is likewise an
 * UNKNOWN, never evidence the set belongs to another game (review C-H3);
 * plan 30-03 classifies that case `unresolved`.
 */
export const researchSourceEventSchema = z.object({
  eventId: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  name: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  slug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  isOnline: z.boolean().nullish(),
  numEntrants: z.number().int().nullish(),
  eventType: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  videogameId: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  tournamentId: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  tournamentName: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  tournamentSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
});
export type ResearchSourceEvent = z.infer<typeof researchSourceEventSchema>;

/**
 * `researchSource/{tenantId}/sets/{providerSetId}` — the lossless provider
 * SET record (D-01, D-03). REJECTS `{}` (no defaults for the required
 * members below) and accepts a minimally valid record consisting only of
 * `providerSetId`, `classification`, `ruleId`, `apiIds.setId`,
 * `ingestionRunId`, `fetchedAtMs`, and `lastObservedAtMs` (review C-H2a).
 *
 * `ruleId`, `subjectEntrantId`, and `opponentEntrantId` are REQUIRED
 * additions (review C-H2b): plan 30-03's `deriveLegacyProjection` is a pure
 * function of the STORED record alone and must resolve the subject/opponent
 * by the ids the classifier recorded, without re-running the classifier
 * against data it does not have. `ruleId` is unconditional because
 * `classifyResearchSet` always returns one; the two entrant ids are nullish
 * because a non-SSBU or bye set legitimately has fewer than two resolvable
 * entrants.
 *
 * `storageKey`/`providerKeyDerived` (review C2-A7) exist so losslessness is
 * literal rather than nearly-literal. `providerSetId` always holds the
 * provider's RAW id. `storageKey` holds the RTDB child key the record
 * actually lives under — equal to `providerSetId` for the ordinary case, a
 * derived-safe digest key when the raw id contains an RTDB-illegal
 * character. `providerKeyDerived` is true exactly in the second case. Every
 * consumer that needs a path segment (the projection's match keys, the
 * supplement tree's `targetSetId`) reads `storageKey ?? providerSetId`;
 * nothing anywhere reconstructs a path from the raw id.
 *
 * `firstIngestionPlayerId` (review C3-A5) is the unique-record ownership
 * marker: the confirmed start.gg player id of the FIRST run that created
 * this record, written once and never changed — the mechanism that makes
 * the tenant rollup count a set exactly once when two confirmed player IDs
 * of the same human both observe it. An absent value means the record
 * predates the member, in which case the next run to touch it CLAIMS it by
 * writing its own player id (deterministic — the write is a single-node
 * transaction). Revoking the owning player id leaves the set counted in no
 * section's unique bundle until a remaining player's run re-observes it — a
 * stated, bounded consequence, never a silent one.
 *
 * `ingestionPage`/`baselineFingerprint` (review C2-H2) are the
 * attempt-invariance members. `ingestionPage` records which page of
 * `ingestionRunId` last wrote this record; it moves ONLY on a CONTRIBUTING
 * write and is otherwise carried forward unchanged, exactly as
 * `baselineFingerprint` is (review C3-H4a). Without the carry-forward, a set
 * committed on page 1 and re-observed (non-contributing) on page 2 would
 * make a RETRY of page 2 see `previousIngestionPage === page`, judge it
 * contributing, and count it a second time — a deterministic, fixture-
 * reproducible double count. `baselineFingerprint` records the
 * `contentFingerprint` this record carried BEFORE the current
 * `(ingestionRunId, ingestionPage)` pair first touched it — carried forward
 * unchanged while the same run keeps retrying the same page, and reset to
 * the prior stored fingerprint whenever a new run or a new page observes
 * the record. `corrected` is decided by comparing `baselineFingerprint`
 * against the newly computed fingerprint, so a correction applied on an
 * abandoned page attempt is still counted exactly once when that page is
 * retried, and a clean full re-run still reports zero corrections.
 *
 * `classification`, `ruleId`, `contentFingerprint`, `baselineFingerprint`,
 * `ingestionPage`, `firstIngestionPlayerId`, `storageKey`,
 * `providerKeyDerived`, and `projectedMatchKeys` are the only
 * NON-provider-owned members: this system's own bookkeeping, carried
 * forward or recomputed across a replace, and the mechanism by which D-09's
 * obsolete-projection deletion and `corrected` counting work.
 */
export const researchSourceSetRecordSchema = z.object({
  providerSetId: z.string().min(1).max(200),
  storageKey: z.string().max(200).nullish(),
  providerKeyDerived: z.boolean().nullish(),
  classification: z.enum(RESEARCH_SET_CLASSIFICATIONS),
  ruleId: z.string().min(1).max(64),
  subjectEntrantId: z.string().max(200).nullish(),
  opponentEntrantId: z.string().max(200).nullish(),
  state: z.number().int().nullish(),
  /** PROVIDER SECONDS — see the module-header timestamp-unit convention. */
  completedAt: z.number().int().nullish(),
  /** PROVIDER SECONDS. */
  createdAt: z.number().int().nullish(),
  /** PROVIDER SECONDS. */
  updatedAt: z.number().int().nullish(),
  fullRoundText: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  round: z.number().int().nullish(),
  displayScore: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  totalGames: z.number().int().nullish(),
  /** D-21/C3-H3: user-owned on the projected row; see module header. */
  vodUrl: z.string().max(RESEARCH_MAX_URL).nullish(),
  identifier: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  event: researchSourceEventSchema.nullish(),
  entrants: z.array(researchSourceEntrantSchema).max(RESEARCH_MAX_ENTRANTS_PER_SET).nullish(),
  games: z.array(researchSourceGameSchema).max(RESEARCH_MAX_GAMES_PER_SET).nullish(),
  contentFingerprint: z.string().max(64).nullish(),
  baselineFingerprint: z.string().max(64).nullish(),
  projectedMatchKeys: z.array(z.string().max(200)).max(RESEARCH_MAX_PROJECTED_MATCH_KEYS).nullish(),
  ingestionPage: z.number().int().min(1).nullish(),
  firstIngestionPlayerId: z.string().max(64).nullish(),
  // Provenance (D-04) inlined from `researchProvenanceSchema` — REQUIRED.
  ...researchProvenanceSchema.shape,
});
export type ResearchSourceSetRecord = z.infer<typeof researchSourceSetRecordSchema>;

// ---------------------------------------------------------------------------
// Ingestion run / cursor / counters
// ---------------------------------------------------------------------------

export const researchIngestionCursorSchema = z.object({
  page: z.number().int().min(1),
  totalPages: z.number().int().nullish(),
  /** PROVIDER SECONDS — passed straight to start.gg's `SetFilters.updatedAfter`. */
  updatedAfterSeconds: z.number().int().nullish(),
  attempt: z.number().int().nullish(),
  /** The current page's durable-write retry count, used by 30-07's all-or-retry page semantics. */
  pageAttempt: z.number().int().nullish(),
  /**
   * Dead-PREFIX extension (30-CONTEXT.md "Dead-PREFIX extension", decided
   * by Codex advisor as product-owner proxy, 2026-08-08): the SECOND
   * safeguard the extension requires. An invocation-scoped counter can
   * never reach `RESEARCH_MAX_CONSECUTIVE_DEAD_PAGES` under the 20-page
   * invocation budget, so the consecutive-confirmed-dead-page streak (empty
   * OR dead-prefix pages) lives here instead — durable across invocation
   * boundaries. Absent means zero (house convention). The executor
   * increments it by one on every confirmed dead page (empty or prefix) and
   * omits the member entirely (never writes zero) the moment a FULL healthy
   * page resolves — never decremented, never reset by anything else.
   */
  consecutiveUnavailablePages: z.number().int().nonnegative().nullish(),
});
export type ResearchIngestionCursor = z.infer<typeof researchIngestionCursorSchema>;

/**
 * `discoveredAllGames` and `discoveredEligible` are DISTINCT (RESEARCH.md
 * Pitfall 1): `SetFilters` has no videogame filter, so a multi-game
 * player's page stream contains non-SSBU sets that are correctly excluded,
 * not silently dropped. BOTH are counted from sets that received a source
 * record — a set is never counted without being stored (review C-H3).
 */
export const researchCountersSchema = z.object({
  discoveredAllGames: z.number().int().nonnegative().nullish(),
  discoveredEligible: z.number().int().nonnegative().nullish(),
  imported: z.number().int().nonnegative().nullish(),
  skipped: z.number().int().nonnegative().nullish(),
  unresolved: z.number().int().nonnegative().nullish(),
  corrected: z.number().int().nonnegative().nullish(),
  /**
   * Provider-dead-page carve-out (30-CONTEXT.md "Provider-dead-page
   * carve-out", decided by Codex advisor as product-owner proxy,
   * 2026-08-08): live evidence showed start.gg deterministically returning
   * an EMPTY connection (`total=0`, `totalPages=0`) for specific row ranges
   * of a player's set history (observed: Hungrybox rows 16-30), a
   * provider-side fault rather than genuine clipping. The executor may only
   * count a page here after a same-page, ID-only confirmation probe (see
   * `fetchResearchSetsIdProbe` in `apps/api/src/startgg/client.ts`) ALSO
   * returns zero nodes/zero total — the zero/zero shape alone is not
   * unique, because a fully clipped page produces the identical shape.
   * `providerUnavailablePages` counts confirmed-dead PAGES (never
   * clipped-but-unconfirmed ones, which stay a hard truncation failure);
   * `providerUnavailableRowEstimate` is this system's OWN page-size
   * ESTIMATE of the rows that page could have held — never a real observed
   * row count, since the provider returned none. Both roll into `totals`
   * exactly like every other member of this schema (`apps/api/src/research/
   * ingestion/rollup.ts`'s `computeTotals`).
   */
  providerUnavailablePages: z.number().int().nonnegative().nullish(),
  providerUnavailableRowEstimate: z.number().int().nonnegative().nullish(),
});
export type ResearchCounters = z.infer<typeof researchCountersSchema>;

/** `unknownVideogame` counts sets whose videogame identity the provider did not report — a gap, never an exclusion. */
export const researchNamedGapsSchema = z.object({
  unknownCharacter: z.number().int().nonnegative().nullish(),
  unknownStage: z.number().int().nonnegative().nullish(),
  missingGameDetail: z.number().int().nonnegative().nullish(),
  missingCompletedAt: z.number().int().nonnegative().nullish(),
  unknownOnlineContext: z.number().int().nonnegative().nullish(),
  unknownVideogame: z.number().int().nonnegative().nullish(),
  unsafeProviderKey: z.number().int().nonnegative().nullish(),
});
export type ResearchNamedGaps = z.infer<typeof researchNamedGapsSchema>;

export const researchDateCoverageSchema = z.object({
  earliestSetAtMs: z.number().int().nullish(),
  latestSetAtMs: z.number().int().nullish(),
});
export type ResearchDateCoverage = z.infer<typeof researchDateCoverageSchema>;

/**
 * A sparse record keyed by `RESEARCH_SET_CLASSIFICATIONS` members — declared
 * ONCE here and reused by both the run's staged member and the published
 * snapshot, so the panel's excluded-outcomes section can never be fed a
 * shape the run cannot produce (review C-H2c). Individual classification
 * counts are nullish (a run need not have observed every classification);
 * an unrecognized key fails to parse.
 */
export const researchClassificationCountsSchema = z.partialRecord(
  z.enum(RESEARCH_SET_CLASSIFICATIONS),
  z.number().int().nonnegative().nullish(),
);
export type ResearchClassificationCounts = z.infer<typeof researchClassificationCountsSchema>;

/**
 * Exactly one invocation may advance a given run at a time. `ownerId`
 * identifies the holder, `expiresAtMs` bounds a crashed holder's grip, and
 * `fence` is the value the CURRENT holder was issued (review C-H7).
 *
 * `fence` is a COPY, not the sequence itself — the sequence lives in the
 * run's `leaseFenceCounter` (review C2-H1). An earlier draft kept the only
 * fence value inside this member, so `releaseRunLease` deleting the member
 * reset the sequence, and an A-holds-1 / B-takes-2-and-releases /
 * C-acquires-1 sequence made stale A's fence valid again.
 */
export const researchRunLeaseSchema = z.object({
  ownerId: z.string().min(1).max(200),
  acquiredAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  fence: z.number().int().min(1),
});
export type ResearchRunLease = z.infer<typeof researchRunLeaseSchema>;

/**
 * One page's ENTIRE counter contribution, stored as a single replaceable
 * unit so a retried page corrects its own prior contribution instead of
 * adding a second one (review C2-H2). Exactly one receipt is retained at a
 * time (the run's `pendingPageReceipt`) because the cursor never advances
 * past a page whose receipt is still in question, so no earlier page's
 * receipt can ever need revising.
 *
 * `earliestSetAtMs`/`latestSetAtMs` carry the page's FULL date SPAN, never
 * a single sample (review C3-A4): `SETS_QUERY` specifies no ordering, so a
 * single page can legitimately hold both the earliest and the latest
 * eligible set in the whole career. One sample per page could carry at
 * most one of those ends, silently narrowing the published span — an
 * ING-05 accuracy defect with no visible symptom. The pair stays monotone
 * under a same-page replace, because 30-05 folds a span by widening an
 * envelope rather than by summing.
 *
 * `uniqueCounters`/`uniqueNamedGaps`/`uniqueClassificationCounts` (review
 * C3-A5) describe the subset of this page's observation whose sets this
 * run's player id OWNS (`firstIngestionPlayerId` equals the run's player
 * id). Element-wise never greater than the observation twins; accumulated
 * set-by-set from the upsert's returned ownership verdict, never derived
 * after the fact by subtraction.
 */
export const researchPageReceiptSchema = z.object({
  page: z.number().int().min(1),
  attempt: z.number().int().min(0),
  stagedAtMs: z.number().int(),
  counters: researchCountersSchema,
  namedGaps: researchNamedGapsSchema,
  classificationCounts: researchClassificationCountsSchema,
  uniqueCounters: researchCountersSchema,
  uniqueNamedGaps: researchNamedGapsSchema,
  uniqueClassificationCounts: researchClassificationCountsSchema,
  earliestSetAtMs: z.number().int().nullish(),
  latestSetAtMs: z.number().int().nullish(),
  observedMaxUpdatedAtSeconds: z.number().int().nullish(),
});
export type ResearchPageReceipt = z.infer<typeof researchPageReceiptSchema>;

/**
 * `researchIngestionRuns/{tenantId}` -> one run inside `runs` below (D-06,
 * D-16). This is a STORED shape backing a single-transaction node, so run
 * creation, lease acquisition, cursor advance, and counter staging are each
 * a single `transaction()`.
 *
 * `leaseFenceCounter` is the monotonic fence SEQUENCE and belongs to the
 * RUN, deliberately OUTSIDE `lease` (review C2-H1): it starts absent, is
 * incremented inside the same transaction that grants any lease, is copied
 * into the granted `lease.fence`, and is NEVER decremented, reset, or
 * removed — not by release, not by a terminal transition, not by pruning a
 * lease off a completed run. A run may legitimately carry
 * `leaseFenceCounter: 7` with no `lease` at all — that is the post-release
 * state, and it is what makes a re-acquired fence strictly greater than
 * every fence ever issued for this run.
 *
 * `pendingPageReceipt` holds the last page receipt folded into the staged
 * counters. 30-05's staging helper folds a receipt by SUBTRACTING the
 * pending receipt's counters first when the incoming receipt names the same
 * page, so the staged totals always equal (every committed page) plus (the
 * current page's latest attempt). A run that FAILS may therefore carry a
 * partial final page in its staged counters; that is acceptable and
 * harmless because a failed run never publishes and its counters are
 * diagnostic only.
 *
 * `coveragePublishedAtMs` (review C-H8) exists so the completion→
 * publication seam is recoverable: `completeBackfillRun` commits a terminal
 * run WITHOUT it, the publish step sets it, and a later invocation that
 * finds a completed run with this member absent finishes the publication
 * instead of no-opping. A crash between the two writes self-heals on the
 * next tick rather than stranding a completed run whose snapshot can never
 * publish.
 *
 * `stagedClassificationCounts` is what the published `classificationCounts`
 * is built from; without it the panel's excluded-outcomes section could
 * never populate (review C-H2c). The three `stagedUnique*` members are the
 * run-level accumulators of the receipt's unique bundle (review C3-A5) —
 * they fold by exactly the same subtract-then-add rule as their observation
 * twins, so a retried page corrects both bundles together and neither can
 * drift from the other.
 *
 * `observedMaxUpdatedAtSeconds` records the largest provider `updatedAt`
 * this run actually observed, so 30-07 can derive a refresh high-water
 * automatically (review C-M6). `retryAfterObserved`/`lastRetryAfterValue`
 * exist to close A-29-08 from observed behavior (D-19).
 */
export const researchIngestionRunSchema = z.object({
  status: z.enum(RESEARCH_INGESTION_RUN_STATUSES),
  mode: z.enum(RESEARCH_INGESTION_MODES),
  playerId: z.string().min(1).max(64),
  requestedByUid: z.string().min(1).max(200),
  startedAtMs: z.number().int(),
  updatedAtMs: z.number().int().nullish(),
  completedAtMs: z.number().int().nullish(),
  failedAtMs: z.number().int().nullish(),
  coveragePublishedAtMs: z.number().int().nullish(),
  reason: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  cursor: researchIngestionCursorSchema.nullish(),
  lease: researchRunLeaseSchema.nullish(),
  leaseFenceCounter: z.number().int().nonnegative().nullish(),
  pendingPageReceipt: researchPageReceiptSchema.nullish(),
  stagedCounters: researchCountersSchema.nullish(),
  stagedNamedGaps: researchNamedGapsSchema.nullish(),
  stagedDateCoverage: researchDateCoverageSchema.nullish(),
  stagedClassificationCounts: researchClassificationCountsSchema.nullish(),
  stagedUniqueCounters: researchCountersSchema.nullish(),
  stagedUniqueNamedGaps: researchNamedGapsSchema.nullish(),
  stagedUniqueClassificationCounts: researchClassificationCountsSchema.nullish(),
  observedMaxUpdatedAtSeconds: z.number().int().nullish(),
  backoffEvents: z.number().int().nullish(),
  retryAfterObserved: z.boolean().nullish(),
  lastRetryAfterValue: z.string().max(200).nullish(),
});
export type ResearchIngestionRun = z.infer<typeof researchIngestionRunSchema>;

/**
 * `researchIngestionRuns/{tenantId}` — the whole per-tenant state as ONE
 * RTDB node (the same one-node rationale `researchEntitlement.ts` records),
 * so run-creation, lease acquisition, cursor advance, and counter staging
 * are each a single `transaction()`. `RESEARCH_RUN_HISTORY_LIMIT` is the
 * prune bound that keeps the node small enough for a per-page rewrite; the
 * `+ 2` headroom in the bound below means a schema parse fails loudly if
 * pruning ever stops working, rather than the node growing unbounded.
 */
export const researchTenantIngestionStateSchema = z.object({
  activeRunId: z.string().max(200).nullish(),
  runs: z
    .record(z.string(), researchIngestionRunSchema)
    .refine((value) => Object.keys(value).length <= RESEARCH_RUN_HISTORY_LIMIT + 2, {
      message: `runs may not exceed ${RESEARCH_RUN_HISTORY_LIMIT + 2} entries`,
    })
    .nullish(),
});
export type ResearchTenantIngestionState = z.infer<typeof researchTenantIngestionStateSchema>;

// ---------------------------------------------------------------------------
// Identity mapping (D-10, D-11)
// ---------------------------------------------------------------------------

/**
 * `primary` is enforced to be true for AT MOST ONE member by
 * `confirmIdentityPlayers` (30-04) transactionally. Consumers MUST call the
 * exported `selectPrimaryConfirmedPlayerId` below rather than scanning for a
 * true flag themselves (review C-M4).
 */
export const researchIdentityConfirmedPlayerSchema = z.object({
  playerId: z.string().min(1).max(64),
  gamerTag: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  userSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  knownTagVariants: z.array(z.string().max(100)).max(50).nullish(),
  sponsorPrefixes: z.array(z.string().max(100)).max(50).nullish(),
  primary: z.boolean().nullish(),
  confirmedByUid: z.string().min(1).max(200),
  confirmedAtMs: z.number().int(),
});
export type ResearchIdentityConfirmedPlayer = z.infer<typeof researchIdentityConfirmedPlayerSchema>;

/** A candidate is NEVER promoted by any writer other than an explicit admin confirmation (D-11). */
export const researchIdentityCandidateSchema = z.object({
  playerId: z.string().min(1).max(64),
  gamerTag: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  userSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  observedEntrantName: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).nullish(),
  observedInSetId: z.string().max(200).nullish(),
  firstObservedAtMs: z.number().int(),
  lastObservedAtMs: z.number().int(),
  observationCount: z.number().int().nullish(),
});
export type ResearchIdentityCandidate = z.infer<typeof researchIdentityCandidateSchema>;

export const researchIdentityMappingSchema = z.object({
  confirmedPlayerIds: z
    .record(z.string(), researchIdentityConfirmedPlayerSchema)
    .refine((value) => Object.keys(value).length <= RESEARCH_MAX_CONFIRMED_PLAYER_IDS, {
      message: `confirmedPlayerIds may not exceed ${RESEARCH_MAX_CONFIRMED_PLAYER_IDS} entries`,
    })
    .nullish(),
  candidates: z
    .record(z.string(), researchIdentityCandidateSchema)
    .refine((value) => Object.keys(value).length <= RESEARCH_MAX_IDENTITY_CANDIDATES, {
      message: `candidates may not exceed ${RESEARCH_MAX_IDENTITY_CANDIDATES} entries`,
    })
    .nullish(),
  lastConfirmedByUid: z.string().max(200).nullish(),
  lastConfirmedAtMs: z.number().int().nullish(),
});
export type ResearchIdentityMapping = z.infer<typeof researchIdentityMappingSchema>;

/**
 * The ONLY sanctioned way to read a workspace's primary confirmed player id
 * (review C-M4) — never scan `confirmedPlayerIds` for a truthy `primary`
 * flag at a call site; call this instead.
 */
export function selectPrimaryConfirmedPlayerId(
  confirmedPlayerIds: ResearchIdentityMapping['confirmedPlayerIds'],
): string | null {
  if (!confirmedPlayerIds) {
    return null;
  }
  for (const [playerId, entry] of Object.entries(confirmedPlayerIds)) {
    if (entry.primary) {
      return playerId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Supplements (D-05, ING-08)
// ---------------------------------------------------------------------------

/**
 * `researchSupplements/{tenantId}/{targetSetId}/{supplementId}` — a sibling
 * overlay tree that never mutates a provider record (D-05). The enum
 * deliberately has NO provider member, so a supplement can never claim
 * provider authorship. `attributedToUid`/`recordedAtMs` are REQUIRED, never
 * nullish (T-30-01-03) — a supplement must always be traceable to the admin
 * who wrote it.
 *
 * ENR-13 correction (Phase 30.2): the RTDB child key is LITERALLY
 * `${sourceKind}-${field}` (see `buildSupplementId` in
 * `apps/api/src/research/ingestion/supplements.ts`), so this correction
 * deliberately did NOT re-key or rename anything — a rename would orphan
 * every existing record under a new name while the old node kept consuming
 * the per-set cap, and `listSupplementsForSet`'s independent per-child
 * safe-parse would make every legacy record silently invisible if a new
 * member were made REQUIRED. `sourceKind` therefore stays exactly as
 * shipped, and `sourceOrigin`/`contentType` are ADDITIVE `.nullish()`
 * members carrying the separated two-dimension shape: `sourceOrigin` is
 * restricted to the single literal `manual` (the enum still has NO provider
 * member — a Liquipedia observation lives on
 * `researchEnrichmentObservationRecordSchema` instead, never here), and
 * `contentType` is checked against `sourceKind` by the `superRefine` below
 * so the two dimensions can never drift apart. A legacy record (no
 * `sourceOrigin`/`contentType` present) is read through
 * `deriveSupplementProvenance` below, which derives the same two dimensions
 * from `sourceKind` alone.
 */
// Declared as a plain (unrefined) base schema, kept separate from the
// `.superRefine()` wrapper below on purpose: chaining `.superRefine()`
// directly onto this `z.object({...})` call forces Prettier to reformat the
// WHOLE object literal onto a `z\n  .object({...})\n  .superRefine(...)`
// chain, which would rewrite every existing field's indentation and make an
// unrelated diff look like every original member was touched. Splitting the
// refinement into its own statement keeps every pre-existing field line
// byte-identical to what shipped.
const researchSupplementRecordSchemaBase = z.object({
  sourceKind: z.enum(RESEARCH_SUPPLEMENT_SOURCE_KINDS),
  targetSetId: z.string().min(1).max(200),
  field: z
    .string()
    .regex(SUPPLEMENT_FIELD_SHAPE, 'field must match the supplement field-name shape'),
  value: z.string().min(1).max(RESEARCH_MAX_SUPPLEMENT_TEXT),
  note: z.string().max(RESEARCH_MAX_SUPPLEMENT_TEXT).nullish(),
  // http(s)-only prefix check (never `new URL(...)`, which pulls in a DOM/node
  // global this shared package cannot assume — it is imported by both the
  // browser bundle and the API): rejects script-scheme and protocol-relative
  // hrefs from ever reaching a future rendering surface.
  vodUrl: z
    .string()
    .max(RESEARCH_MAX_URL)
    .regex(/^https?:\/\//i, 'vodUrl must be an http(s) URL')
    .nullish(),
  vodTimestampSeconds: z.number().int().min(0).max(2_592_000).nullish(),
  attributedToUid: z.string().min(1).max(200),
  recordedAtMs: z.number().int(),
  /**
   * ENR-13: restricted to the single literal `manual` — this tree
   * structurally cannot hold a provider-sourced record. A Liquipedia
   * observation lives on `researchEnrichmentObservationRecordSchema`
   * instead, never here.
   */
  sourceOrigin: z.literal('manual').nullish(),
  contentType: z.enum(RESEARCH_PROVENANCE_CONTENT_TYPES).nullish(),
  rawValue: z.string().max(RESEARCH_MAX_SUPPLEMENT_TEXT).nullish(),
  canonicalValue: z.string().max(RESEARCH_MAX_SUPPLEMENT_TEXT).nullish(),
  observedAtMs: z.number().int().nullish(),
});

/** ENR-13: rejects an explicit `contentType` that disagrees with the value implied by `sourceKind` (manual implies note, vod implies vod-reference), so the two dimensions can never drift apart. */
export const researchSupplementRecordSchema = researchSupplementRecordSchemaBase.superRefine(
  (value, ctx) => {
    if (value.contentType != null) {
      const impliedContentType = value.sourceKind === 'manual' ? 'note' : 'vod-reference';
      if (value.contentType !== impliedContentType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'contentType must match sourceKind (manual implies note, vod implies vod-reference)',
          path: ['contentType'],
        });
      }
    }
  },
);
export type ResearchSupplementRecord = z.infer<typeof researchSupplementRecordSchema>;

/**
 * Derives the two-dimension provenance shape (origin, content type) for a
 * supplement record, whether or not it carries the explicit ENR-13 members.
 * A legacy record (written before this correction) carries neither
 * `sourceOrigin` nor `contentType` — its provenance is DERIVED from
 * `sourceKind` alone: `manual` implies origin `manual` / contentType `note`;
 * `vod` implies origin `manual` / contentType `vod-reference` (a legacy
 * `sourceKind: 'vod'` record is a MANUAL-origin record whose content type is
 * a VOD reference — the conflation ENR-13 corrects is content type
 * masquerading as provenance, and the shipped tree has exactly one origin
 * because it has exactly one writer, the research-tenant admin). A record
 * written by the corrected `upsertSupplement` carries both members
 * explicitly, and this function returns them with `explicit: true`.
 */
export function deriveSupplementProvenance(record: ResearchSupplementRecord): {
  origin: ResearchProvenanceOrigin;
  contentType: ResearchProvenanceContentType;
  explicit: boolean;
} {
  if (record.sourceOrigin != null && record.contentType != null) {
    return { origin: record.sourceOrigin, contentType: record.contentType, explicit: true };
  }
  return {
    origin: 'manual',
    contentType: record.sourceKind === 'manual' ? 'note' : 'vod-reference',
    explicit: false,
  };
}

// ---------------------------------------------------------------------------
// Coverage snapshot (D-15, D-16)
// ---------------------------------------------------------------------------

/**
 * A research workspace may hold MULTIPLE confirmed start.gg player IDs —
 * the entire MkLeo/Sparg0 pattern this milestone exists to cover — and a
 * backfill run targets exactly one of them. Every member here is REQUIRED
 * (never nullish at this level): `playerId`, `runId`, `runCompletedAtMs`,
 * and `asOfMs` name the completed run that produced the section, and the
 * observation/unique bundles are both mandatory (review C3-A5) so the
 * section can never exist half-populated.
 *
 * The un-prefixed members (`counters`/`namedGaps`/`classificationCounts`)
 * are what THIS player ID's query observed and are what the panel renders
 * inside that player's section. The `unique*` members are the subset this
 * player id OWNS by `firstIngestionPlayerId`, existing solely so the tenant
 * rollup can be a unique-record figure without a full-scan read of the
 * source tier (D-15 forbids one).
 *
 * `asOfMs` equals the producing run's own `completedAtMs` and is NEVER a
 * publication-retry clock (review C2-H4). `runCompletedAtMs` is the value
 * 30-05's compare-and-set recency guard reads to refuse replacing a section
 * with an older run's.
 */
export const researchCoveragePlayerSectionSchema = z.object({
  playerId: z.string().min(1).max(64),
  runId: z.string().min(1).max(200),
  runCompletedAtMs: z.number().int(),
  asOfMs: z.number().int(),
  counters: researchCountersSchema,
  namedGaps: researchNamedGapsSchema,
  dateCoverage: researchDateCoverageSchema,
  classificationCounts: researchClassificationCountsSchema,
  uniqueCounters: researchCountersSchema,
  uniqueNamedGaps: researchNamedGapsSchema,
  uniqueClassificationCounts: researchClassificationCountsSchema,
});
export type ResearchCoveragePlayerSection = z.infer<typeof researchCoveragePlayerSectionSchema>;

const researchCoverageTotalsSchema = z.object({
  counters: researchCountersSchema,
  namedGaps: researchNamedGapsSchema,
  dateCoverage: researchDateCoverageSchema,
  classificationCounts: researchClassificationCountsSchema,
});
export type ResearchCoverageTotals = z.infer<typeof researchCoverageTotalsSchema>;

/**
 * `researchCoverage/{tenantId}` — the tenant's last-completed snapshot,
 * published atomically ONLY on run completion (D-16). `players` is a MAP
 * (review C2-H3, D-10), never a flat structure: a single flat snapshot
 * would let a run for a second confirmed player ID replace the workspace's
 * published coverage with second-ID-only counts, turning ING-05's
 * completeness report into a structurally wrong claim for exactly the
 * players this milestone was built for.
 *
 * `totals` is DERIVED (summed over `players` at publication time, with
 * `dateCoverage` widened across sections) and is STORED — never recomputed
 * by the reader — so the panel and the audit can never disagree about the
 * rollup.
 *
 * `totals` IS UNIQUE-RECORD LIBRARY SEMANTICS (review C3-A5) — it describes
 * the tenant's stored set library, deduped by provider set id, so a set
 * exposed under two confirmed player IDs of the same human counts ONCE. It
 * is summed from each section's `uniqueCounters`/`uniqueNamedGaps`/
 * `uniqueClassificationCounts`, NEVER from the sections' observation
 * bundles: the source tier is tenant-wide and keyed by provider set id, so
 * it IS a unique-set library, and summing observations would report two
 * records where one exists. Each per-player section still reports its OWN
 * observation, so a set visible to both IDs legitimately appears in both
 * sections and once in the rollup. `dateCoverage` is widened across
 * sections rather than summed, because a span is an envelope and dedupe
 * does not apply to it.
 */
export const researchCoverageSnapshotSchema = z.object({
  /** The MAXIMUM `asOfMs` across the sections, so the tenant-level freshness stamp is the freshest section. */
  asOfMs: z.number().int(),
  players: z
    .record(z.string(), researchCoveragePlayerSectionSchema)
    .refine((value) => Object.keys(value).length <= RESEARCH_MAX_CONFIRMED_PLAYER_IDS, {
      message: `players may not exceed ${RESEARCH_MAX_CONFIRMED_PLAYER_IDS} entries`,
    }),
  totals: researchCoverageTotalsSchema,
});
export type ResearchCoverageSnapshot = z.infer<typeof researchCoverageSnapshotSchema>;

/**
 * The HTTP shape the Data Coverage panel reads, consumed by both
 * `apps/api/src/routes/research.ts` and `apps/web/src/lib/api.ts`.
 * `confirmedPlayerIds` is present so the panel can render a confirmed ID
 * that has NO section yet as "not yet backfilled" rather than omitting it
 * silently; `activeRun.playerId` is present so the panel can say which
 * player is currently in flight.
 */
export const researchCoverageResponseSchema = z.object({
  coverage: researchCoverageSnapshotSchema.nullish(),
  confirmedPlayerIds: z.array(z.string().max(64)).max(RESEARCH_MAX_CONFIRMED_PLAYER_IDS),
  confirmedPlayerIdCount: z.number().int().nonnegative(),
  unresolvedCandidateCount: z.number().int().nonnegative(),
  activeRun: z
    .object({
      runId: z.string().min(1).max(200),
      status: z.enum(RESEARCH_INGESTION_RUN_STATUSES),
      playerId: z.string().min(1).max(64),
      startedAtMs: z.number().int(),
      cursorPage: z.number().int().nullish(),
      totalPages: z.number().int().nullish(),
    })
    .nullish(),
});
export type ResearchCoverageResponse = z.infer<typeof researchCoverageResponseSchema>;

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/** Total helper: maps a `.nullish()` stored counters shape to an all-numeric object with zeros for absent members. */
export function normalizeResearchCounters(
  counters?: ResearchCounters | null,
): Required<ResearchCounters> {
  return {
    discoveredAllGames: counters?.discoveredAllGames ?? 0,
    discoveredEligible: counters?.discoveredEligible ?? 0,
    imported: counters?.imported ?? 0,
    skipped: counters?.skipped ?? 0,
    unresolved: counters?.unresolved ?? 0,
    corrected: counters?.corrected ?? 0,
    providerUnavailablePages: counters?.providerUnavailablePages ?? 0,
    providerUnavailableRowEstimate: counters?.providerUnavailableRowEstimate ?? 0,
  };
}

/** Total helper: maps a `.nullish()` stored named-gaps shape to an all-numeric object with zeros for absent members. */
export function normalizeResearchNamedGaps(
  gaps?: ResearchNamedGaps | null,
): Required<ResearchNamedGaps> {
  return {
    unknownCharacter: gaps?.unknownCharacter ?? 0,
    unknownStage: gaps?.unknownStage ?? 0,
    missingGameDetail: gaps?.missingGameDetail ?? 0,
    missingCompletedAt: gaps?.missingCompletedAt ?? 0,
    unknownOnlineContext: gaps?.unknownOnlineContext ?? 0,
    unknownVideogame: gaps?.unknownVideogame ?? 0,
    unsafeProviderKey: gaps?.unsafeProviderKey ?? 0,
  };
}

/** Total helper: returns one member per `RESEARCH_SET_CLASSIFICATIONS` entry, zero for every absent classification. */
export function normalizeResearchClassificationCounts(
  counts?: ResearchClassificationCounts | null,
): Record<ResearchSetClassification, number> {
  const result = {} as Record<ResearchSetClassification, number>;
  for (const classification of RESEARCH_SET_CLASSIFICATIONS) {
    result[classification] = counts?.[classification] ?? 0;
  }
  return result;
}

/** Delta shape for plan 30-05's staging helper — every member an optional number, never a stored shape. */
export type ResearchCountersDelta = Partial<{ [K in keyof ResearchCounters]: number }>;

/** Delta shape for plan 30-05's staging helper — every member an optional number, never a stored shape. */
export type ResearchClassificationCountsDelta = Partial<Record<ResearchSetClassification, number>>;
