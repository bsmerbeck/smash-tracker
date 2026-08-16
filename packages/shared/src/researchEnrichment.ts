import { z } from 'zod';
import {
  RESEARCH_PROVENANCE_CONTENT_TYPES,
  RESEARCH_PROVENANCE_ORIGINS,
  type ResearchProvenanceContentType,
  type ResearchProvenanceOrigin,
} from './researchProvenance.js';

/**
 * Phase 30.2 (Liquipedia Stage & VOD Enrichment, ENR-04/ENR-13): the stored
 * shapes for the Liquipedia-sourced enrichment layer — a SIBLING overlay to
 * the Phase 30 provider-ingestion schema module's start.gg provider tier,
 * never flattened into it and never written as a `manual` supplement.
 *
 * RTDB layout this file governs:
 *
 * - `researchEnrichmentObservations/{tenantId}/{observationId}` ->
 *   `ResearchEnrichmentObservationRecord` — one row per extracted Liquipedia
 *   fact (a bracket-page set or a VOD-list entry), independent of whether it
 *   has been matched to a start.gg set yet.
 * - `researchEnrichmentReceipts/{tenantId}/{observationId}` ->
 *   `ResearchEnrichmentResolutionReceiptRecord` — the persisted evidence an
 *   AUTOMATIC attachment is checked against (cycle-1 review MEDIUM 7).
 * - `researchEnrichmentAttachments/{tenantId}/{targetSetId}/{observationId}`
 *   -> `ResearchEnrichmentAttachmentRecord` — the authorization record that
 *   lets an observation reach projection.
 * - `researchEnrichmentProjection/{tenantId}/{matchKey}` ->
 *   `ResearchEnrichmentProjectionStateRecord` — the ENR-08 ownership witness,
 *   deliberately stored OUTSIDE the match row (see its own doc comment
 *   below).
 * - `researchEnrichmentCoverage/{tenantId}` ->
 *   `ResearchEnrichmentCoverageSnapshot`.
 * - `researchEnrichmentRuns/{tenantId}` ->
 *   `ResearchEnrichmentRunRecord`.
 *
 * Every optional member below uses the `.nullish()` zod modifier (house
 * constraint 1, the 260725-juj outage class) — never plain-optional, never
 * nullable — because these are STORED shapes and RTDB strips absent keys on
 * write; every writer that touches one of these trees conditional-spreads.
 * An unmapped/unknown value (an unrecognized stage symbol, an unresolved
 * character) is an ABSENT member, never a sentinel value.
 *
 * MANDATORY IMPORT GRAPH (cycle-1 review HIGH 1 — no plan in this phase may
 * add an edge to it):
 *
 *     researchProvenance.ts (neutral vocab)      -> (zod only)
 *     researchEnrichment.ts (this file)          -> researchProvenance.ts
 *     the Phase 30 provider-ingestion schema module -> researchProvenance.ts, researchEnrichment.ts
 *     researchEnrichmentProjection.ts (plan 08)  -> researchEnrichment.ts
 *
 * This file MUST NOT import the Phase 30 provider-ingestion schema module in
 * any form — not even a type-only import, because a later refactor can
 * silently turn a type import into a value import and reintroduce the
 * cycle. Anything this file would otherwise have borrowed from that module
 * (length caps, run lease/cursor/status shapes) is declared locally below
 * with its own named constant; each such declaration carries a comment
 * naming the constant it deliberately mirrors.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** The single admitted enrichment source. Liquipedia is the only provider this phase integrates. */
export const RESEARCH_ENRICHMENT_PROVIDERS = ['liquipedia'] as const;
export type ResearchEnrichmentProvider = (typeof RESEARCH_ENRICHMENT_PROVIDERS)[number];

/**
 * The two content shapes a Liquipedia observation may carry — a SUBSET of
 * `RESEARCH_PROVENANCE_CONTENT_TYPES` (which also admits `note`, a
 * manual-only shape). See the runtime cross-check below.
 */
export const RESEARCH_ENRICHMENT_CONTENT_TYPES = ['stage-observation', 'vod-reference'] as const;
export type ResearchEnrichmentContentType = (typeof RESEARCH_ENRICHMENT_CONTENT_TYPES)[number];

/**
 * `matched` alone does NOT authorize projection — see
 * `researchEnrichmentAttachmentRecordSchema` and the module header of
 * `researchEnrichmentResolutionReceiptRecordSchema` below. `ambiguous`/
 * `unmatched`/`conflicting` observations exist only in the admin-review
 * queue and coverage counters (30.2-CONTEXT.md, "Structural barrier for
 * match status").
 */
export const RESEARCH_ENRICHMENT_MATCH_STATUSES = [
  'matched',
  'ambiguous',
  'unmatched',
  'conflicting',
] as const;
export type ResearchEnrichmentMatchStatus = (typeof RESEARCH_ENRICHMENT_MATCH_STATUSES)[number];

/**
 * `resolver` is an automatic attachment authorized by a persisted receipt;
 * `admin` is an explicit human confirmation. No third value exists — every
 * attachment must be traceable to exactly one of the two.
 */
export const RESEARCH_ENRICHMENT_ATTACHMENT_SOURCES = ['resolver', 'admin'] as const;
export type ResearchEnrichmentAttachmentSource =
  (typeof RESEARCH_ENRICHMENT_ATTACHMENT_SOURCES)[number];

/**
 * `normal` means the source page stated NO form prefix for the stage — it is
 * UNSTATED, never an assertion that hazards are on. Liquipedia bracket pages
 * commonly omit the form entirely for the common case, and treating that
 * absence as "hazards on" would fabricate a fact the source never stated
 * (RESEARCH section 4.3).
 */
export const RESEARCH_LIQUIPEDIA_STAGE_FORMS = [
  'normal',
  'hazardless',
  'omega',
  'battlefield',
  'unknown',
] as const;
export type ResearchLiquipediaStageForm = (typeof RESEARCH_LIQUIPEDIA_STAGE_FORMS)[number];

/** Which bracket-rendering template family produced an observation — drives which adapter parsed it. */
export const RESEARCH_ENRICHMENT_TEMPLATE_FAMILIES = [
  'legacy',
  'match2',
  'vodlist',
  'unknown',
] as const;
export type ResearchEnrichmentTemplateFamily =
  (typeof RESEARCH_ENRICHMENT_TEMPLATE_FAMILIES)[number];

/**
 * Runtime cross-check, evaluated at module load: every enrichment-specific
 * vocabulary member must also be a member of the neutral provenance
 * vocabulary it specializes. This doubles as evidence, at import time, that
 * `./researchProvenance.js` finished evaluating before this module needs its
 * exports — see the module-load-order test in `researchEnrichment.test.ts`
 * (cycle-1 review HIGH 1).
 */
function isResearchProvenanceOrigin(value: string): value is ResearchProvenanceOrigin {
  return (RESEARCH_PROVENANCE_ORIGINS as readonly string[]).includes(value);
}

function isResearchProvenanceContentType(value: string): value is ResearchProvenanceContentType {
  return (RESEARCH_PROVENANCE_CONTENT_TYPES as readonly string[]).includes(value);
}

if (!RESEARCH_ENRICHMENT_PROVIDERS.every((provider) => isResearchProvenanceOrigin(provider))) {
  throw new Error('RESEARCH_ENRICHMENT_PROVIDERS must be a subset of RESEARCH_PROVENANCE_ORIGINS');
}
if (
  !RESEARCH_ENRICHMENT_CONTENT_TYPES.every((contentType) =>
    isResearchProvenanceContentType(contentType),
  )
) {
  throw new Error(
    'RESEARCH_ENRICHMENT_CONTENT_TYPES must be a subset of RESEARCH_PROVENANCE_CONTENT_TYPES',
  );
}

// ---------------------------------------------------------------------------
// Bound constants
// ---------------------------------------------------------------------------

/**
 * Untrusted third-party text caps (RESEARCH section 15, V5). Deliberately
 * declared locally rather than imported — the provider-text-length constant
 * in the Phase 30 provider-ingestion schema module is the constant this
 * mirrors, at a tighter bound because these strings are wiki-editable prose
 * fragments, not provider API fields.
 *
 * EXPORTED (30.2 reliability gate): the Liquipedia adapters bound every
 * untrusted raw-evidence string to these caps at extraction time, so a
 * record that reaches the persistence schema can never fail its length
 * bounds at the write boundary. Exporting the constant keeps the adapter
 * clamp and the schema bound one definition, never two numbers that drift.
 */
export const RESEARCH_ENRICHMENT_MAX_RAW_TEXT = 120;

/** Mirrors the URL-length bound constant in the Phase 30 provider-ingestion schema module — duplicated locally so this file has no sibling import besides `researchProvenance.ts`. Exported for the same adapter-clamp reason as `RESEARCH_ENRICHMENT_MAX_RAW_TEXT`. */
export const RESEARCH_ENRICHMENT_MAX_URL = 2048;

/** The schema's per-reason cap on `resolutionReasons` entries — exported so adapters can clamp stated reasons (which interpolate untrusted source text) at extraction time. */
export const RESEARCH_ENRICHMENT_MAX_REASON_TEXT = 200;

const RESEARCH_ENRICHMENT_MAX_PER_SOURCE_PAGE_ENTRIES = 400;

/** Every Liquipedia article this phase reads lives under this path — the same anchor both the observation record and the coverage snapshot's `perSourcePage` entries use for `sourcePageUrl` (cycle-1 review HIGH 5). */
const LIQUIPEDIA_PAGE_URL_SHAPE = /^https:\/\/liquipedia\.net\/smash\//;

/** A SHA-256 hex digest, lowercase, unabbreviated. */
const CONTENT_HASH_SHAPE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Parser-version / attribution constants
// ---------------------------------------------------------------------------

/**
 * Bumped @1 -> @2 (30.2 production defect C): the legacy observation-id
 * discriminator gained the per-page bracket-instance ordinal + section
 * heading (two same-template brackets on one page previously collided and
 * silently overwrote each other), and the match2 adapter now processes
 * EVERY `{{Bracket}}` instance on a page with the same ordinal dimension.
 * Ids embed the parser version, so every observation id re-keys; the
 * composed page-cache freshness version derives from these constants, so
 * every cached wikitext page auto-invalidates, and the run driver's
 * stale-parser supersede pass removes the old-version twins as each page
 * re-extracts.
 */
export const LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY = 'liquipedia-bracket-legacy@2';
export const LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2 = 'liquipedia-bracket-match2@2';
export const LIQUIPEDIA_PARSER_VERSION_VOD_LIST = 'liquipedia-vodlist@1';
export const LIQUIPEDIA_ATTRIBUTION_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/3.0/';

// ---------------------------------------------------------------------------
// Observation record
// ---------------------------------------------------------------------------

/**
 * 30.2 production defect (the RTDB null-strip trap in ARRAY form): a
 * two-seat positional array with nullable seats (`stocks`, `rawChars`,
 * `scores`) is VALID going in and UNPARSEABLE coming back. RTDB strips null
 * array members on storage (`[null, 0]` -> `{"1": 0}`); the SDK reads back
 * SPARSE arrays whose holes are `undefined` (failing the nullable union)
 * and whose fully-stripped tails SHORTEN the array (failing the tuple's
 * length). Production blast radius: 1,196 current-generation records
 * (mkleo 616 / sparg0 354 / hbox 226) schema-failed on read for exactly
 * this.
 *
 * This preprocess normalizes the READ side in the schema itself — zero
 * migration, the stored bytes stay as they are: holes/undefined seats
 * become explicit `null`, a shortened array is right-padded to its
 * two-seat structural length, and RTDB's numeric-keyed object form of a
 * sparse array (`{"1": 0}`) is rebuilt positionally. Semantic equivalence
 * holds by the schema's own vocabulary: a stripped seat and an explicit
 * null both mean "unknown at this seat". Anything structurally foreign
 * (three-plus members, an empty array, non-index keys) passes through
 * UNCHANGED so the tuple still rejects it — this normalizes storage
 * representations, it never weakens a bound.
 */
/** The three two-seat positional nullable tuples, declared once so the STORED schema (preprocess-wrapped) and the HTTP CONTRACT schema (plain, serializer-safe) share one bound definition. */
const twoSeatRawCharsTuple = z
  .tuple([
    z.union([z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT), z.null()]),
    z.union([z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT), z.null()]),
  ])
  .nullish();
const twoSeatStocksTuple = z
  .tuple([
    z.union([z.number().int().min(0).max(99), z.null()]),
    z.union([z.number().int().min(0).max(99), z.null()]),
  ])
  .nullish();
const twoSeatScoresTuple = z
  .tuple([z.union([z.number().int(), z.null()]), z.union([z.number().int(), z.null()])])
  .nullish();

function normalizeTwoSeatNullableArray(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 2) {
      return value;
    }
    return [value[0] === undefined ? null : value[0], value[1] === undefined ? null : value[1]];
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((key) => key === '0' || key === '1')) {
      return [record['0'] ?? null, record['1'] ?? null];
    }
  }
  return value;
}

const researchEnrichmentPlayerEntrySchema = z.object({
  /**
   * 30.2 reliability gate (owner corrective directive, Gate 1): `.min(1)`
   * alone admitted a whitespace-only tag, and the production MkLeo apply
   * abort proved an adapter could emit a present-but-empty player slot all
   * the way to the write boundary. The trim refinement TIGHTENS the bound
   * (additive, never a relaxation — the earlier "relax min(1)" advisory is
   * superseded): a player entry either carries a real, non-whitespace tag or
   * the observation must be stored WITHOUT `players` (which is `.nullish()`
   * below) as an explicit extraction failure. Adapters classify; this bound
   * makes the empty-tag shape structurally unpersistable.
   */
  rawTag: z
    .string()
    .min(1)
    .max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT)
    .refine((value) => value.trim().length > 0, {
      message: 'rawTag must contain at least one non-whitespace character',
    }),
  canonicalPage: z.string().max(300).nullish(),
  /** Untrusted third-party string: usually a 2-letter code, but live pages carry full country names ("Dominican Republic"). */
  flag: z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT).nullish(),
});

const researchEnrichmentGameEntrySchema = z.object({
  ordinal: z.number().int().min(1),
  /** Untrusted third-party string, capped at 120 (RESEARCH section 15, V5). */
  rawStage: z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT).nullish(),
  stageForm: z.enum(RESEARCH_LIQUIPEDIA_STAGE_FORMS).nullish(),
  canonicalStageId: z.number().int().nullish(),
  // Two-seat positional nullable arrays: read-normalized against the RTDB
  // null-strip trap — see `normalizeTwoSeatNullableArray`.
  rawChars: z.preprocess(normalizeTwoSeatNullableArray, twoSeatRawCharsTuple),
  stocks: z.preprocess(normalizeTwoSeatNullableArray, twoSeatStocksTuple),
  winnerSeat: z.union([z.literal(1), z.literal(2)]).nullish(),
});

/**
 * `researchEnrichmentObservations/{tenantId}/{observationId}` — one row per
 * extracted Liquipedia fact. `sourceProvider`/`sourceWiki` are REQUIRED
 * literals so a value can never claim any other authorship (ENR-04); every
 * provenance member below (`sourceRevisionId`, `sourceContentHash`,
 * `sourcePageUrl`, `parserVersion`, `fetchedAtMs`) is REQUIRED rather than
 * an optional annotation, so an observation is never stored without the
 * evidence trail that lets it be re-verified or re-fetched.
 */
export const researchEnrichmentObservationRecordSchema = z.object({
  observationId: z.string().min(1).max(200),
  sourceProvider: z.enum(RESEARCH_ENRICHMENT_PROVIDERS),
  sourceWiki: z.literal('smash'),
  contentType: z.enum(RESEARCH_ENRICHMENT_CONTENT_TYPES),
  sourcePageTitle: z.string().min(1).max(300),
  sourcePageUrl: z.string().max(500).regex(LIQUIPEDIA_PAGE_URL_SHAPE),
  sourceRevisionId: z.number().int(),
  sourceContentHash: z.string().regex(CONTENT_HASH_SHAPE),
  parserVersion: z.string().min(1).max(64),
  templateFamily: z.enum(RESEARCH_ENRICHMENT_TEMPLATE_FAMILIES),
  fetchedAtMs: z.number().int(),
  observedAtMs: z.number().int(),
  matchingStatus: z.enum(RESEARCH_ENRICHMENT_MATCH_STATUSES),
  sourceSha1: z.string().max(64).nullish(),
  bracketTemplate: z.string().max(200).nullish(),
  bracketKey: z.string().max(200).nullish(),
  /** The wiki's game scope string, e.g. `ultimate`. */
  game: z.string().max(64).nullish(),
  tournamentPageTitle: z.string().max(300).nullish(),
  tournamentPageUrl: z.string().max(500).nullish(),
  tournamentDisplayName: z.string().max(300).nullish(),
  tournamentStartggSlug: z.string().max(200).nullish(),
  sectionHeading: z.string().max(300).nullish(),
  derivedRoundLabel: z.string().max(200).nullish(),
  rawDate: z.string().max(100).nullish(),
  /** ISO day, e.g. `2026-05-17`. */
  date: z.string().max(10).nullish(),
  rawScores: z
    .tuple([
      z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT),
      z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT),
    ])
    .nullish(),
  // Read-normalized against the RTDB null-strip trap — see
  // `normalizeTwoSeatNullableArray`. (`rawScores` above needs no
  // normalization: its seats are plain strings, never null.)
  scores: z.preprocess(normalizeTwoSeatNullableArray, twoSeatScoresTuple),
  setWinnerSeat: z.union([z.literal(1), z.literal(2)]).nullish(),
  setWinnerDerived: z.boolean().nullish(),
  isBracketReset: z.boolean().nullish(),
  vodInheritedFromBracketKey: z.string().max(200).nullish(),
  rawVodUrl: z.string().max(RESEARCH_ENRICHMENT_MAX_URL).nullish(),
  // http(s)-only prefix check (never `new URL(...)`, which pulls in a DOM/node
  // global this shared package cannot assume — it is imported by both the
  // browser bundle and the API), mirroring the supplement schema's vodUrl
  // check in the Phase 30 provider-ingestion schema module.
  vodUrl: z
    .string()
    .max(RESEARCH_ENRICHMENT_MAX_URL)
    .regex(/^https:\/\//i, 'vodUrl must be an https URL')
    .nullish(),
  players: z
    .tuple([researchEnrichmentPlayerEntrySchema, researchEnrichmentPlayerEntrySchema])
    .nullish(),
  games: z.array(researchEnrichmentGameEntrySchema).max(15).nullish(),
  candidateTargetSetIds: z.array(z.string().max(200)).max(20).nullish(),
  resolutionReasons: z.array(z.string().max(RESEARCH_ENRICHMENT_MAX_REASON_TEXT)).max(10).nullish(),
  sourcePageMissing: z.boolean().nullish(),
  extractionFailed: z.boolean().nullish(),
});
export type ResearchEnrichmentObservationRecord = z.infer<
  typeof researchEnrichmentObservationRecordSchema
>;

/**
 * The HTTP-CONTRACT variant of the observation record — member-for-member
 * identical bounds, WITHOUT the two-seat read-normalization preprocess.
 * `fastify-type-provider-zod`'s response serializer cannot compile a
 * `z.preprocess` member, so the review-queue response schema below must
 * reference this plain shape; that costs nothing, because every value a
 * route serializes was READ through the stored schema and is therefore
 * already in canonical two-seat form. This mirrors the file's existing
 * stored-vs-contract split (`researchEnrichmentCoverageResponseSchema`).
 */
const researchEnrichmentGameEntryContractSchema = researchEnrichmentGameEntrySchema.extend({
  rawChars: twoSeatRawCharsTuple,
  stocks: twoSeatStocksTuple,
});

export const researchEnrichmentObservationRecordContractSchema =
  researchEnrichmentObservationRecordSchema.extend({
    scores: twoSeatScoresTuple,
    games: z.array(researchEnrichmentGameEntryContractSchema).max(15).nullish(),
  });

// ---------------------------------------------------------------------------
// Attachment record
// ---------------------------------------------------------------------------

/**
 * `researchEnrichmentAttachments/{tenantId}/{targetSetId}/{observationId}` —
 * the authorization record that lets an observation reach projection. An
 * automatic attachment must always name the persisted receipt that
 * authorised it (cycle-1 review MEDIUM 7); an admin attachment must always
 * name who confirmed it and when.
 */
export const researchEnrichmentAttachmentRecordSchema = z
  .object({
    observationId: z.string().min(1).max(200),
    targetSetId: z.string().min(1).max(200),
    attachmentSource: z.enum(RESEARCH_ENRICHMENT_ATTACHMENT_SOURCES),
    attachedAtMs: z.number().int(),
    sourceRevisionId: z.number().int(),
    sourceContentHash: z.string().regex(CONTENT_HASH_SHAPE),
    parserVersion: z.string().min(1).max(64),
    receiptId: z.string().max(200).nullish(),
    confirmedByUid: z.string().max(200).nullish(),
    confirmedAtMs: z.number().int().nullish(),
    matchEvidence: z.array(z.string().max(200)).max(10).nullish(),
  })
  .superRefine((value, ctx) => {
    if (
      value.attachmentSource === 'admin' &&
      (!value.confirmedByUid || value.confirmedAtMs == null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an admin attachment requires both confirmedByUid and confirmedAtMs',
        path: ['attachmentSource'],
      });
    }
    if (value.attachmentSource === 'resolver' && !value.receiptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a resolver attachment requires a receiptId naming the persisted receipt that authorised it',
        path: ['attachmentSource'],
      });
    }
  });
export type ResearchEnrichmentAttachmentRecord = z.infer<
  typeof researchEnrichmentAttachmentRecordSchema
>;

// ---------------------------------------------------------------------------
// Resolution receipt record
// ---------------------------------------------------------------------------

/**
 * `researchEnrichmentReceipts/{tenantId}/{observationId}` — the persisted
 * evidence an automatic attachment is checked against. A receipt is only
 * meaningful if it is FALSIFIABLE, so the shape itself refuses to express
 * "matched, but with more than one survivor": `candidateTargetSetIds` must
 * have length exactly 1, and that single candidate must equal `targetSetId`.
 * The resolver's ambiguous outcome has no receipt at all — it lives only in
 * the observation's `matchingStatus` and `candidateTargetSetIds`, never
 * here. This means the attachment writer that reloads this record can never
 * be handed a self-contradicting authorisation (cycle-1 review MEDIUM 7).
 */
export const researchEnrichmentResolutionReceiptRecordSchema = z
  .object({
    receiptId: z.string().min(1).max(200),
    observationId: z.string().min(1).max(200),
    targetSetId: z.string().min(1).max(200),
    confidence: z.literal('high'),
    resolvedAtMs: z.number().int(),
    resolverVersion: z.string().min(1).max(64),
    sourceRevisionId: z.number().int(),
    sourceContentHash: z.string().regex(CONTENT_HASH_SHAPE),
    parserVersion: z.string().min(1).max(64),
    candidateTargetSetIds: z.array(z.string().max(200)).min(1).max(20),
    evidence: z.array(z.string().max(200)).max(10).nullish(),
  })
  .superRefine((value, ctx) => {
    if (
      value.candidateTargetSetIds.length !== 1 ||
      value.candidateTargetSetIds[0] !== value.targetSetId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a receipt must name exactly one candidate target set, equal to its own targetSetId',
        path: ['candidateTargetSetIds'],
      });
    }
  });
export type ResearchEnrichmentResolutionReceiptRecord = z.infer<
  typeof researchEnrichmentResolutionReceiptRecordSchema
>;

// ---------------------------------------------------------------------------
// Projection state record (ENR-08 ownership witness)
// ---------------------------------------------------------------------------

/**
 * `researchEnrichmentProjection/{tenantId}/{matchKey}` — the ENR-08
 * ownership witness that deliberately does NOT live on the match row.
 *
 * Why not on the match row: `EditMatchForm`'s PATCH is a full overwrite
 * (omitted members are cleared) — see PATTERNS.md section 3 — so any witness
 * stored on `matches/{tenantId}/{key}` would be silently stripped the next
 * time a user saves their own edit, permanently losing the ability to tell a
 * source-owned value from a user-typed one.
 *
 * Why BOTH a committed half and a pending half exist: a witness written in
 * one operation and the match row written in another cannot be made atomic
 * in RTDB (there is no cross-tree transaction). So instead of trying to make
 * the two writes atomic, ownership is decided against the SET of values the
 * witness vouches for — the committed one and the pending one — which makes
 * every crash point between the two writes leave the stored row value inside
 * that set. Cycle-1 review HIGH 3 established the failure this prevents:
 * with only a committed half, a crash between a row write and its witness
 * write leaves a projected value indistinguishable from a user-typed one,
 * permanently and silently.
 */
export const researchEnrichmentProjectionStateRecordSchema = z.object({
  matchKey: z.string().min(1).max(200),
  targetSetId: z.string().min(1).max(200),
  // Committed half.
  projectedVodUrl: z.string().max(RESEARCH_ENRICHMENT_MAX_URL).nullish(),
  vodObservationId: z.string().max(200).nullish(),
  /** 30.3 Gate 5: present instead of `vodObservationId` when the projected VOD came from an admin-CONFIRMED YouTube candidate (priority 5), naming the candidate record that authorized it. */
  vodCandidateId: z.string().max(200).nullish(),
  vodSourceRevisionId: z.number().int().nullish(),
  vodParserVersion: z.string().max(64).nullish(),
  vodProjectedAtMs: z.number().int().nullish(),
  vodOwnershipReleasedAtMs: z.number().int().nullish(),
  projectedStageId: z.number().int().nullish(),
  projectedStageName: z.string().max(120).nullish(),
  projectedStageRaw: z.string().max(120).nullish(),
  projectedStageForm: z.enum(RESEARCH_LIQUIPEDIA_STAGE_FORMS).nullish(),
  stageObservationId: z.string().max(200).nullish(),
  stageSourceRevisionId: z.number().int().nullish(),
  stageParserVersion: z.string().max(64).nullish(),
  stageProjectedAtMs: z.number().int().nullish(),
  // -- Character/stock evidence halves (30.3 Gate 5) ------------------------
  // Committed only after the seat orientation is PROVEN (the source's seat 1/2
  // mapped onto subject/opponent through the row's own provider-authored
  // opponent tag) — `projectedSubjectSeat` records that proof. A raw member
  // present WITHOUT its fighter-id sibling is the flagged-unmapped state: the
  // source text is preserved, never guessed into the app vocabulary.
  projectedSubjectSeat: z.union([z.literal(1), z.literal(2)]).nullish(),
  projectedSubjectCharRaw: z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT).nullish(),
  projectedSubjectFighterId: z.number().int().nullish(),
  projectedOpponentCharRaw: z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT).nullish(),
  projectedOpponentFighterId: z.number().int().nullish(),
  charsObservationId: z.string().max(200).nullish(),
  charsSourceRevisionId: z.number().int().nullish(),
  charsParserVersion: z.string().max(64).nullish(),
  charsProjectedAtMs: z.number().int().nullish(),
  // The stocks half writes a real match-row member (`stocksLeft`), so it gets
  // the same committed+pending two-value accepted set the VOD half has.
  projectedStocksLeft: z.number().int().min(0).max(3).nullish(),
  stocksObservationId: z.string().max(200).nullish(),
  stocksSourceRevisionId: z.number().int().nullish(),
  stocksParserVersion: z.string().max(64).nullish(),
  stocksProjectedAtMs: z.number().int().nullish(),
  // Pending half — a write that began but did not (yet) commit.
  pendingVodUrl: z.string().max(RESEARCH_ENRICHMENT_MAX_URL).nullish(),
  pendingVodObservationId: z.string().max(200).nullish(),
  pendingVodCandidateId: z.string().max(200).nullish(),
  pendingVodSourceRevisionId: z.number().int().nullish(),
  pendingVodRemoval: z.boolean().nullish(),
  pendingStageId: z.number().int().nullish(),
  pendingStageName: z.string().max(120).nullish(),
  pendingStageRaw: z.string().max(120).nullish(),
  pendingStageForm: z.enum(RESEARCH_LIQUIPEDIA_STAGE_FORMS).nullish(),
  pendingStageObservationId: z.string().max(200).nullish(),
  pendingStocksLeft: z.number().int().min(0).max(3).nullish(),
  pendingStocksObservationId: z.string().max(200).nullish(),
  pendingWriteStartedAtMs: z.number().int().nullish(),
});
export type ResearchEnrichmentProjectionStateRecord = z.infer<
  typeof researchEnrichmentProjectionStateRecordSchema
>;

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const researchEnrichmentCountsSchema = z.object({
  matched: z.number().int().nonnegative().nullish(),
  ambiguous: z.number().int().nonnegative().nullish(),
  unmatched: z.number().int().nonnegative().nullish(),
  conflicting: z.number().int().nonnegative().nullish(),
  stageEnriched: z.number().int().nonnegative().nullish(),
  vodEnriched: z.number().int().nonnegative().nullish(),
  vodSkippedUserOwned: z.number().int().nonnegative().nullish(),
  vodFilledEmpty: z.number().int().nonnegative().nullish(),
  stageProviderAuthoritative: z.number().int().nonnegative().nullish(),
  unknownStageAfterEnrichment: z.number().int().nonnegative().nullish(),
  unmappedStageSymbol: z.number().int().nonnegative().nullish(),
  observationsExtracted: z.number().int().nonnegative().nullish(),
  pagesFetched: z.number().int().nonnegative().nullish(),
  pagesFromCache: z.number().int().nonnegative().nullish(),
  pagesShrinkHeld: z.number().int().nonnegative().nullish(),
  sourcePagesMissing: z.number().int().nonnegative().nullish(),
  vodRowsDeclared: z.number().int().nonnegative().nullish(),
  vodRowsExtracted: z.number().int().nonnegative().nullish(),
  attachedNoProjectableRows: z.number().int().nonnegative().nullish(),
  adminConfirmed: z.number().int().nonnegative().nullish(),
  // -- 30.3 Gate 5: character/stock evidence + VOD candidate counters -------
  charactersEnriched: z.number().int().nonnegative().nullish(),
  charactersUnmapped: z.number().int().nonnegative().nullish(),
  charactersAbstained: z.number().int().nonnegative().nullish(),
  stocksFilledEmpty: z.number().int().nonnegative().nullish(),
  stocksSkippedOwned: z.number().int().nonnegative().nullish(),
  stocksAbstained: z.number().int().nonnegative().nullish(),
  vodCandidatesProposed: z.number().int().nonnegative().nullish(),
  vodCandidatesConfirmed: z.number().int().nonnegative().nullish(),
});
export type ResearchEnrichmentCounts = z.infer<typeof researchEnrichmentCountsSchema>;

/** The three-cohort split ENR-11 requires and Phase 31's EVID-02 consumes. */
export const researchEnrichmentCohortCountsSchema = z.object({
  startggOnly: z.number().int().nonnegative().nullish(),
  liquipediaSupplemented: z.number().int().nonnegative().nullish(),
  missing: z.number().int().nonnegative().nullish(),
});
export type ResearchEnrichmentCohortCounts = z.infer<typeof researchEnrichmentCohortCountsSchema>;

/** Total helper: maps a `.nullish()` stored counts shape to an all-numeric object with zeros for absent members — mirrors the equivalent normalizer in the Phase 30 provider-ingestion schema module. */
export function normalizeResearchEnrichmentCounts(
  counts?: ResearchEnrichmentCounts | null,
): Required<ResearchEnrichmentCounts> {
  return {
    matched: counts?.matched ?? 0,
    ambiguous: counts?.ambiguous ?? 0,
    unmatched: counts?.unmatched ?? 0,
    conflicting: counts?.conflicting ?? 0,
    stageEnriched: counts?.stageEnriched ?? 0,
    vodEnriched: counts?.vodEnriched ?? 0,
    vodSkippedUserOwned: counts?.vodSkippedUserOwned ?? 0,
    vodFilledEmpty: counts?.vodFilledEmpty ?? 0,
    stageProviderAuthoritative: counts?.stageProviderAuthoritative ?? 0,
    unknownStageAfterEnrichment: counts?.unknownStageAfterEnrichment ?? 0,
    unmappedStageSymbol: counts?.unmappedStageSymbol ?? 0,
    observationsExtracted: counts?.observationsExtracted ?? 0,
    pagesFetched: counts?.pagesFetched ?? 0,
    pagesFromCache: counts?.pagesFromCache ?? 0,
    pagesShrinkHeld: counts?.pagesShrinkHeld ?? 0,
    sourcePagesMissing: counts?.sourcePagesMissing ?? 0,
    vodRowsDeclared: counts?.vodRowsDeclared ?? 0,
    vodRowsExtracted: counts?.vodRowsExtracted ?? 0,
    attachedNoProjectableRows: counts?.attachedNoProjectableRows ?? 0,
    adminConfirmed: counts?.adminConfirmed ?? 0,
    charactersEnriched: counts?.charactersEnriched ?? 0,
    charactersUnmapped: counts?.charactersUnmapped ?? 0,
    charactersAbstained: counts?.charactersAbstained ?? 0,
    stocksFilledEmpty: counts?.stocksFilledEmpty ?? 0,
    stocksSkippedOwned: counts?.stocksSkippedOwned ?? 0,
    stocksAbstained: counts?.stocksAbstained ?? 0,
    vodCandidatesProposed: counts?.vodCandidatesProposed ?? 0,
    vodCandidatesConfirmed: counts?.vodCandidatesConfirmed ?? 0,
  };
}

/** Total helper: maps a `.nullish()` stored cohort-counts shape to an all-numeric object with zeros for absent members. */
export function normalizeResearchEnrichmentCohortCounts(
  counts?: ResearchEnrichmentCohortCounts | null,
): Required<ResearchEnrichmentCohortCounts> {
  return {
    startggOnly: counts?.startggOnly ?? 0,
    liquipediaSupplemented: counts?.liquipediaSupplemented ?? 0,
    missing: counts?.missing ?? 0,
  };
}

// ---------------------------------------------------------------------------
// YouTube VOD candidate record (30.3 Gate 5 — priority 5 of the VOD chain)
// ---------------------------------------------------------------------------

export const RESEARCH_ENRICHMENT_VOD_CANDIDATE_STATUSES = [
  'proposed',
  'confirmed',
  'dismissed',
] as const;
export type ResearchEnrichmentVodCandidateStatus =
  (typeof RESEARCH_ENRICHMENT_VOD_CANDIDATE_STATUSES)[number];

/**
 * `researchEnrichmentVodCandidates/{tenantId}/{targetSetId}/{candidateId}` —
 * one YouTube Data API search result, persisted as a CANDIDATE, never a
 * fact (30.3 Gate 5). A candidate carries the query that produced it, the
 * result's own identity members (video id, title, channel, publication
 * date), the fetch time, and a heuristic score — everything an admin needs
 * to judge it. NOTHING projects from this tree until an explicit admin
 * confirmation stamps `status: 'confirmed'` with `confirmedByUid`/
 * `confirmedAtMs` (the same explicit-human-action shape the admin
 * attachment door uses); the projection applier reads ONLY confirmed
 * candidates, and only at the BOTTOM of the source-priority chain (a
 * user/manual URL, a provider URL, and any attached Liquipedia observation
 * URL all outrank it).
 */
export const researchEnrichmentVodCandidateRecordSchema = z
  .object({
    candidateId: z.string().min(1).max(200),
    targetSetId: z.string().min(1).max(200),
    /** The only admitted discovery mechanism — the YouTube Data API. Never HTML scraping. */
    provider: z.literal('youtube-data-api'),
    query: z.string().min(1).max(500),
    videoId: z.string().min(1).max(64),
    /** The canonical watch URL for `videoId` — the value a confirmation would project. */
    videoUrl: z
      .string()
      .max(RESEARCH_ENRICHMENT_MAX_URL)
      .regex(/^https:\/\//i, 'videoUrl must be an https URL'),
    /** Untrusted third-party text. */
    title: z.string().max(300),
    channelId: z.string().max(200).nullish(),
    channelTitle: z.string().max(300).nullish(),
    /** ISO timestamp string as the API returned it. */
    publishedAt: z.string().max(40).nullish(),
    fetchedAtMs: z.number().int(),
    score: z.number(),
    status: z.enum(RESEARCH_ENRICHMENT_VOD_CANDIDATE_STATUSES),
    confirmedByUid: z.string().max(200).nullish(),
    confirmedAtMs: z.number().int().nullish(),
    dismissedByUid: z.string().max(200).nullish(),
    dismissedAtMs: z.number().int().nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'confirmed' && (!value.confirmedByUid || value.confirmedAtMs == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a confirmed candidate requires both confirmedByUid and confirmedAtMs',
        path: ['status'],
      });
    }
  });
export type ResearchEnrichmentVodCandidateRecord = z.infer<
  typeof researchEnrichmentVodCandidateRecordSchema
>;

/** `GET .../enrichment/vod-candidates` — the tenant's full candidate list plus per-status tallies over exactly what the list contains. */
export const researchEnrichmentVodCandidateListResponseSchema = z.object({
  candidates: z.array(researchEnrichmentVodCandidateRecordSchema).max(500),
  counts: z.object({
    proposed: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    dismissed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type ResearchEnrichmentVodCandidateListResponse = z.infer<
  typeof researchEnrichmentVodCandidateListResponseSchema
>;

// ---------------------------------------------------------------------------
// Coverage snapshot
// ---------------------------------------------------------------------------

/**
 * `sourcePageUrl` is REQUIRED, not optional (cycle-1 review HIGH 5): plan
 * 11's coverage panel is contractually obliged to link each freshness row to
 * its source page, and plan 11's own key_link forbids deriving that link at
 * render time — so the URL must be stored at publish time or the
 * attribution requirement is unmeetable.
 */
const researchEnrichmentPerSourcePageEntrySchema = z.object({
  sourcePageUrl: z.string().max(500).regex(LIQUIPEDIA_PAGE_URL_SHAPE),
  revisionId: z.number().int(),
  contentHash: z.string().regex(CONTENT_HASH_SHAPE),
  fetchedAtMs: z.number().int(),
  observationCount: z.number().int().nonnegative(),
});

/**
 * `researchEnrichmentCoverage/{tenantId}` — published by an enrichment
 * rollup, composed into the same HTTP response the ingestion coverage
 * response already publishes, without touching the locked ingestion publish
 * path (PATTERNS.md section 5).
 */
export const researchEnrichmentCoverageSnapshotSchema = z.object({
  asOfMs: z.number().int(),
  runId: z.string().min(1).max(200),
  counts: researchEnrichmentCountsSchema,
  cohortCounts: researchEnrichmentCohortCountsSchema,
  perSourcePage: z
    .record(z.string().max(300), researchEnrichmentPerSourcePageEntrySchema)
    .refine(
      (value) => Object.keys(value).length <= RESEARCH_ENRICHMENT_MAX_PER_SOURCE_PAGE_ENTRIES,
      {
        message: `perSourcePage may not exceed ${RESEARCH_ENRICHMENT_MAX_PER_SOURCE_PAGE_ENTRIES} entries`,
      },
    )
    .nullish(),
  /** The home for the IzAw honest-zero reason and similar disclosed-gap notes. */
  notes: z.array(z.string().max(500)).max(20).nullish(),
});
export type ResearchEnrichmentCoverageSnapshot = z.infer<
  typeof researchEnrichmentCoverageSnapshotSchema
>;

/**
 * 30.3 Gate 5 — one field's explicit present/missing/ambiguous coverage
 * cell, derived at READ time from the stored ownership witnesses (the
 * enrichment rollup's `deriveEnrichmentFieldCoverage`). `present` counts
 * rows whose witness carries a committed value for the field; `ambiguous`
 * counts rows with partial or in-flight evidence (a raw-only stage, a
 * flagged-unmapped character, a pending half); `missing` is the honest
 * remainder of the witnessed universe. `latestSourceRevisionId`/
 * `latestProjectedAtMs` expose the freshest source revision and projection
 * time observed for the field, so a consumer can show "as of revision N".
 */
const researchEnrichmentFieldCoverageCellSchema = z.object({
  present: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  latestSourceRevisionId: z.number().int().nullish(),
  latestProjectedAtMs: z.number().int().nullish(),
});
export type ResearchEnrichmentFieldCoverageCell = z.infer<
  typeof researchEnrichmentFieldCoverageCellSchema
>;

/** The four-field coverage rollup (stages, characters, stocks, VODs) over every match key carrying an enrichment ownership witness. */
export const researchEnrichmentFieldCoverageSchema = z.object({
  asOfMs: z.number().int(),
  witnessedRows: z.number().int().nonnegative(),
  stages: researchEnrichmentFieldCoverageCellSchema,
  characters: researchEnrichmentFieldCoverageCellSchema,
  stocks: researchEnrichmentFieldCoverageCellSchema,
  vods: researchEnrichmentFieldCoverageCellSchema,
});
export type ResearchEnrichmentFieldCoverage = z.infer<typeof researchEnrichmentFieldCoverageSchema>;

/**
 * Phase 30.2 Plan 10 (ENR-06/ENR-09): the HTTP-facing shape of the
 * additive `enrichment` member the Phase 30 provider-ingestion schema
 * module's coverage-response schema adds — the value a caller of `GET
 * /api/users/me/coverage` or `GET /research/tenants/:tenantId/coverage`
 * actually receives. Declared as its OWN named export, not inlined as a
 * bare reference to `researchEnrichmentCoverageSnapshotSchema` at the call
 * site, so the response CONTRACT can diverge from the STORED shape —
 * exactly what 30.3 Gate 5 now does: `fieldCoverage` is a READ-TIME-derived
 * presentational member (built from the witness tree by the enrichment
 * rollup's `deriveEnrichmentFieldCoverage`), never stored on the
 * `researchEnrichmentCoverage/{tenantId}` node and never written by
 * `stageEnrichmentProgress`/`publishEnrichmentCoverage`. It is `.nullish()`
 * so every already-published snapshot keeps parsing unchanged.
 */
export const researchEnrichmentCoverageResponseSchema =
  researchEnrichmentCoverageSnapshotSchema.extend({
    fieldCoverage: researchEnrichmentFieldCoverageSchema.nullish(),
  });
export type ResearchEnrichmentCoverageResponse = z.infer<
  typeof researchEnrichmentCoverageResponseSchema
>;

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

/** Mirrors the run-status vocabulary in the Phase 30 provider-ingestion schema module — duplicated locally because this file must not import that module (cycle-1 review HIGH 1). */
const RESEARCH_ENRICHMENT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type ResearchEnrichmentRunStatus = (typeof RESEARCH_ENRICHMENT_RUN_STATUSES)[number];

/** Mirrors the run-lease schema in the Phase 30 provider-ingestion schema module (same fence-copy rationale: `fence` is a copy of the run's own monotonic sequence, never decremented/reset/removed) — duplicated locally for the same reason. */
const researchEnrichmentRunLeaseSchema = z.object({
  ownerId: z.string().min(1).max(200),
  acquiredAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  fence: z.number().int().min(1),
});

/**
 * Added by plan 09 (Rule 2 — the module this schema mirrors is
 * indexed-page-driven; this phase's walk is ordered-STAGE-driven, and the
 * schema had nowhere to record which stage a run had reached): the
 * resumable ordered work list Task 1 defines — discovery (player VOD pages)
 * -> expansion (tournament subpage enumeration) -> probe (batched head
 * revisions) -> extraction (per fact page) -> projection (per target set).
 * `run.ts` advances `stage` exactly once, to `'projection'`, as the single
 * crash-safe checkpoint between "everything has been gathered" and
 * "resolve/attach/project what was gathered" — an invocation that finds
 * `stage === 'projection'` already stored skips every fetch.
 */
export const RESEARCH_ENRICHMENT_RUN_STAGES = [
  'discovery',
  'expansion',
  'probe',
  'extraction',
  'projection',
] as const;
export type ResearchEnrichmentRunStage = (typeof RESEARCH_ENRICHMENT_RUN_STAGES)[number];

/** Mirrors the run-cursor schema in the Phase 30 provider-ingestion schema module, trimmed to what a page-title-driven Liquipedia walk needs rather than a numbered result-page walk. `stage` is a plan-09 addition (Rule 2, see above). */
const researchEnrichmentRunCursorSchema = z.object({
  stage: z.enum(RESEARCH_ENRICHMENT_RUN_STAGES).nullish(),
  pageTitle: z.string().max(300).nullish(),
  attempt: z.number().int().nullish(),
});

/**
 * `researchEnrichmentRuns/{tenantId}` — reuses the Phase-30 lease/fence
 * member NAMES from the sibling provider-ingestion run schema (`status`,
 * `startedAtMs`, `completedAtMs`, `failedAtMs`, `reason`,
 * `coveragePublishedAtMs`, `lease`, `leaseFenceCounter`, `cursor`) so plan 09
 * can copy `backfillRun.ts`'s fence machinery member-for-member.
 * `failedAtMs`/`reason` were added by plan 09 itself (Rule 2) — the status
 * enum below already declared `'failed'` with nothing to say when or why.
 * `runId` is an ENRICHMENT-ONLY required
 * member: the sibling provider-ingestion run schema has no `runId` (verified
 * — its members are `status`, `mode`, `playerId`, `requestedByUid`,
 * `startedAtMs`, `updatedAtMs`, `completedAtMs`, `failedAtMs`,
 * `coveragePublishedAtMs`, `reason`, `cursor`, `lease`, `leaseFenceCounter`,
 * `pendingPageReceipt`, the staged counter family,
 * `observedMaxUpdatedAtSeconds`, `backoffEvents`, `retryAfterObserved`,
 * `lastRetryAfterValue`); Phase 30 carries its run identity on the coverage
 * snapshot and coverage response instead. The enrichment coverage snapshot
 * above REQUIRES `runId`, so the enrichment run record must carry one of its
 * own rather than inheriting a member that does not exist.
 */
export const researchEnrichmentRunRecordSchema = z.object({
  runId: z.string().min(1).max(200),
  status: z.enum(RESEARCH_ENRICHMENT_RUN_STATUSES),
  startedAtMs: z.number().int(),
  completedAtMs: z.number().int().nullish(),
  /**
   * Added by plan 09 (Rule 2 — the status enum already declared `'failed'`
   * but this schema had no member to record when or why): mirrors the
   * sibling provider-ingestion run schema's `failedAtMs`/`reason` pair so a
   * failed enrichment run is diagnosable the same way a failed backfill run
   * is.
   */
  failedAtMs: z.number().int().nullish(),
  reason: z.string().max(500).nullish(),
  coveragePublishedAtMs: z.number().int().nullish(),
  lease: researchEnrichmentRunLeaseSchema.nullish(),
  leaseFenceCounter: z.number().int().nonnegative().nullish(),
  cursor: researchEnrichmentRunCursorSchema.nullish(),
});
export type ResearchEnrichmentRunRecord = z.infer<typeof researchEnrichmentRunRecordSchema>;

// ---------------------------------------------------------------------------
// Admin review-queue / confirm HTTP contract (Phase 30.2 Plan 10, ENR-06)
//
// Declared here (not locally in `apps/api/src/routes/research.ts`) so the
// web client and the API share ONE contract, mirroring
// `researchEnrichmentCoverageResponseSchema` above.
// ---------------------------------------------------------------------------

/**
 * The tenant-wide tallies over exactly what the review queue itself
 * contains — NEVER the tenant's full coverage counters, which include
 * already-attached observations this queue never lists. `total` is the
 * queue's own length, so a caller can render "N items need review" without
 * summing the three matching-status counts (a matched-but-unattached
 * observation — the adversarial forged-status case `store.ts`'s
 * `listEnrichmentReviewQueue` still surfaces — would otherwise be silently
 * dropped from a naive sum).
 */
export const researchEnrichmentReviewQueueCountsSchema = z.object({
  ambiguous: z.number().int().nonnegative(),
  conflicting: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ResearchEnrichmentReviewQueueCounts = z.infer<
  typeof researchEnrichmentReviewQueueCountsSchema
>;

/** `GET .../enrichment/review` — the queue itself (never an attached observation, `store.ts`'s own contract) plus its counts, in the route's deterministic sort order. Uses the CONTRACT observation schema (no preprocess members — the response serializer cannot compile them; values are already canonical). */
export const researchEnrichmentReviewQueueResponseSchema = z.object({
  observations: z.array(researchEnrichmentObservationRecordContractSchema).max(500),
  counts: researchEnrichmentReviewQueueCountsSchema,
});
export type ResearchEnrichmentReviewQueueResponse = z.infer<
  typeof researchEnrichmentReviewQueueResponseSchema
>;

/** `POST .../enrichment/review/:observationId/confirm` request body — the ONLY input this route accepts: the admin's chosen candidate. Everything else the store's `confirmEnrichmentObservationByAdmin` needs (the stored observation, its candidate list, the confirming uid, the clock) is server-derived, never client-supplied. */
export const researchEnrichmentConfirmRequestSchema = z.object({
  targetSetId: z.string().min(1).max(200),
});
export type ResearchEnrichmentConfirmRequest = z.infer<
  typeof researchEnrichmentConfirmRequestSchema
>;

// ---------------------------------------------------------------------------
// Self-scoped attribution HTTP contract (Phase 30.2 Plan 10, ENR-09)
// ---------------------------------------------------------------------------

/**
 * The page identity of ONE observation, as reported for ONE field.
 * `sourcePageTitle`/`sourcePageUrl` are read from the witness's referenced
 * observation (the witness itself stores only an observation id, revision id
 * and parser version — not the page identity), so both are `.nullish()`: a
 * half whose referenced observation has since been removed still reports its
 * revision id rather than disappearing entirely.
 */
export const researchEnrichmentAttributionSourceSchema = z.object({
  sourcePageTitle: z.string().max(300).nullish(),
  sourcePageUrl: z.string().max(500).nullish(),
  sourceRevisionId: z.number().int().nullish(),
});
export type ResearchEnrichmentAttributionSource = z.infer<
  typeof researchEnrichmentAttributionSourceSchema
>;

/** The STAGE half — page identity plus the stage-only members. */
export const researchEnrichmentStageAttributionSchema =
  researchEnrichmentAttributionSourceSchema.extend({
    /** Untrusted third-party source text — never dropped (mirrors the observation record's own `rawStage`). */
    rawStage: z.string().max(RESEARCH_ENRICHMENT_MAX_RAW_TEXT).nullish(),
    stageForm: z.enum(RESEARCH_LIQUIPEDIA_STAGE_FORMS).nullish(),
  });
export type ResearchEnrichmentStageAttribution = z.infer<
  typeof researchEnrichmentStageAttributionSchema
>;

/** The VOD half — page identity only; `rawStage`/`stageForm` are stage-only concepts and are structurally absent here. */
export const researchEnrichmentVodAttributionSchema = researchEnrichmentAttributionSourceSchema;
export type ResearchEnrichmentVodAttribution = z.infer<
  typeof researchEnrichmentVodAttributionSchema
>;

/**
 * One match key's attribution, present only for a key that carries a stored
 * enrichment witness — split into TWO INDEPENDENT HALVES (30.2 gap-closure
 * BLOCKER 2).
 *
 * An earlier shape reported ONE flat set of members per match key, built
 * from `stageObservationId ?? vodObservationId`. That single-slot shape was
 * wrong in two directions at once, and both were user-visible:
 *
 *   1. A STAGE-ONLY witness produced an entry, and every VOD surface
 *      (the attach-VOD dialog's prefilled hint, the VOD manager badge, the
 *      match table's VOD menu) treats "an entry exists" as "this row's
 *      vodUrl came from Liquipedia" — so a USER-ENTERED VOD on a
 *      stage-enriched row was labelled as source-derived. Mislabelling a
 *      user's own data as third-party-derived is an ENR-09 accuracy failure.
 *   2. When BOTH fields were enriched, the single `sourcePageUrl` was
 *      whichever page the STAGE observation named, so the VOD badge linked
 *      to the wrong source page.
 *
 * Each half is therefore built ONLY from its own witness members — the stage
 * half from `stageObservationId`/`stage*`, the VOD half from
 * `vodObservationId`/`vod*`/`projectedVodUrl` — and a half is ABSENT (never
 * an empty object) when that field carries no source claim. A consumer must
 * read the half for the field it is describing and no other.
 */
export const researchEnrichmentAttributionEntrySchema = z.object({
  matchKey: z.string().min(1).max(200),
  stage: researchEnrichmentStageAttributionSchema.nullish(),
  vod: researchEnrichmentVodAttributionSchema.nullish(),
});
export type ResearchEnrichmentAttributionEntry = z.infer<
  typeof researchEnrichmentAttributionEntrySchema
>;

/**
 * `GET /api/users/me/enrichment/attribution` response — ONLY the keys from
 * the caller's request that carry a stored witness for the CALLER'S OWN
 * subject are present; a key with no witness, or one belonging to another
 * subject, is silently absent rather than reported as an error (the route
 * accepts no subject parameter of any kind, so it is structurally
 * impossible to observe another subject's witness through this shape).
 * Capped at 200 to mirror `USERS_ENRICHMENT_ATTRIBUTION_MAX_KEYS`
 * (`apps/api/src/routes/users.ts`) — duplicated locally rather than
 * imported, since an API-only constant cannot be imported by this
 * platform-agnostic shared module.
 */
export const researchEnrichmentAttributionResponseSchema = z.object({
  attributions: z.array(researchEnrichmentAttributionEntrySchema).max(200),
});
export type ResearchEnrichmentAttributionResponse = z.infer<
  typeof researchEnrichmentAttributionResponseSchema
>;

// ---------------------------------------------------------------------------
// Observation id
// ---------------------------------------------------------------------------

/**
 * Deterministic observation id, built from the three coordinates that
 * uniquely identify an extracted fact: the source page, the parser that
 * produced it, and a caller-supplied discriminator (e.g. a bracket key or
 * VOD-list row index). Returns the first 32 lowercase-hex characters of the
 * SHA-256 of the three inputs joined by `\n`.
 *
 * Takes an INJECTED hash implementation rather than importing `node:crypto`
 * at module scope — this module is imported by the browser bundle through
 * `packages/shared/src/index.ts`, so it must not carry a node-only import.
 * The API side passes a `node:crypto` SHA-256 implementation; a test may
 * pass any implementation that returns a hex digest.
 */
export function buildEnrichmentObservationId(
  input: { sourcePageTitle: string; parserVersion: string; discriminator: string },
  hashHex: (value: string) => string,
): string {
  const digest = hashHex(
    `${input.sourcePageTitle}\n${input.parserVersion}\n${input.discriminator}`,
  );
  return digest.slice(0, 32);
}
