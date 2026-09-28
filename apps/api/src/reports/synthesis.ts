import type { Database } from 'firebase-admin/database';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  buildActionCandidates,
  buildClaimSet,
  CITATION_LABEL_MAX_LENGTH,
  CLAIM_SCHEMA_VERSION,
  confidenceTierFor,
  describeCohort,
  EVIDENCE_ID_PREFIX,
  EVIDENCE_POLICY_VERSION,
  isRtdbSafeKeySegment,
  makeCanonicalizer,
  matchRecordSchema,
  rankActionCandidates,
  RECENCY_TREATMENT,
  REVIEW_CHECKLIST_ITEM_IDS,
  selectReviewResultsContext,
  serializeCitationToken,
  SpriteList,
  StageList,
  tournamentEntrySchema,
  vodEvidenceId,
  type ActionCandidate,
  type ClaimAtom,
  type ClaimSet,
  type ClaimSubject,
  type EvidenceRow,
  type EvidenceSnapshot,
  type Match,
  type SampleMeta,
  type StoredPracticePlan,
  type VodRef,
} from '@smash-tracker/shared';
// The one symbol this module imports from prep/ — a deliberately ONE-WAY
// dependency (28-CONTEXT.md / RESEARCH Pitfall 9, mirroring 27-06's
// `routes/reports.ts` precedent). Nothing in `apps/api/src/prep/` imports
// back from `reports/` — see `prep/importGraph.test.ts`.
import { readPrepBrief } from '../prep/prep.js';
import { canonicalDigest } from '../research/registry/canonical.js';
import {
  claimSelectionSchema,
  engineAuthoredSummary,
  projectClaimRecordFields,
  type ClaimSelection,
} from './claimSelection.js';
import {
  ReportGenerationError,
  toModelFacingActionCandidate,
  toModelFacingClaim,
  type ModelFacingActionCandidate,
  type ModelFacingClaim,
  type ReportModelRequestOptions,
} from './generate.js';

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/**
 * One annotated moment of the caller's own stored evidence for this event.
 * Phase 39 (plan 39-08): the model references a moment by `claimId` — the
 * `vod_annotation` claim it was issued as — and the validator resolves that
 * claim's evidence id (`vodEvidenceId(matchId, seconds)`) against the
 * snapshot's rows. `cite` is the pre-serialized `{{cite:...}}` token 28-06's
 * retired citation rule resolved; it is no longer sent to the model (see
 * `buildSynthesisModelMessage`) and survives here only as the TESTS-ONLY
 * token universe behind `allowedTokens`.
 *
 * `tags` ride the evidence item's own text (embedded, (timestamp, string)
 * pairs) — there is no separate tag registry or tag-level citable id
 * (28-RESEARCH Q3 table).
 */
export interface SynthesisEvidenceItem {
  matchId: string;
  opponent: string | null;
  result: 'win' | 'loss';
  time: string;
  seconds: number;
  note: string;
  tags: string[];
  cite: string;
  /**
   * Phase 39 (plan 39-08, D-02): the id of the `vod_annotation` claim this
   * moment was issued as — what the model SELECTS to reference it. `null`
   * only when the claim builder's vocabulary truncation cut this moment's
   * claim (more issued candidates than `CLAIM_ID_VOCABULARY_SIZE`).
   */
  claimId: string | null;
}

export interface SynthesisPayload {
  entry: {
    eventName: string;
    tournamentName: string | null;
    dates: { firstSetAt: string; lastSetAt: string };
  };
  briefContext: {
    reviewChecklistProgress: { completed: number; total: number };
    /** Canonical names from the brief's curated `likelyOpponents` presence map. */
    likelyOpponents: string[];
  };
  results: { wins: number; losses: number };
  evidence: SynthesisEvidenceItem[];
  /** Phase 39 (D-01/D-02): the engine-issued claims the model selects from — the same model-facing projection the scout payload uses. */
  claims: ModelFacingClaim[];
  /** Phase 39 (RPT-09/D-12): the ranked action candidates the model may place in its three action slots. */
  actionCandidates: ModelFacingActionCandidate[];
}

/**
 * Discriminated result of `assembleSynthesisPayload`: `found: false` when
 * the brief or the registry row is absent (a missing brief, a foreign
 * entryKey the caller never activated a prep brief for, or a raced
 * activation) — the route 404s on this, never falling back to a partial
 * assembly. Kept HTTP-free deliberately: this module never imports Fastify
 * or throws an HTTP-shaped error itself.
 */
export type AssembleSynthesisResult =
  | { found: false }
  | {
      found: true;
      payload: SynthesisPayload;
      /**
       * Exactly `new Set(evidence.map((item) => item.cite))` — the
       * pre-serialized token universe of 28-06's retired citation rule.
       * TESTS-ONLY (review IN-01): no production code path consumes this.
       * It exists so `synthesis.test.ts` can pin the token set and the
       * migration battery can build shipped-rule outputs from real tokens.
       */
      allowedTokens: Set<string>;
      /**
       * Exactly `new Set(evidence.map((item) => \`${item.matchId}:${item.seconds}\`))`
       * — the shipped set-membership universe (owner invariant 1). Phase 39:
       * TESTS-ONLY as well; the SAME universe, re-expressed through
       * `vodEvidenceId`, is the key set of `rows` (the C1-M8 set-equality
       * proof in `synthesis.test.ts` goes through that bijection).
       */
      allowedPairs: Set<string>;
      evidenceCount: number;
      /**
       * Phase 39 (D-02, RPT-05): the `vod_annotation` evidence ROWS, keyed by
       * `vodEvidenceId(matchId, seconds)` — see `buildVodAnnotationRows`.
       */
      rows: Readonly<Record<string, EvidenceRow>>;
      /** Phase 39 (D-05): the immutable snapshot over `rows`, content-addressed and persisted by the route before the model call. */
      snapshot: EvidenceSnapshot;
      /** Phase 39 (D-01/RPT-05): `buildClaimSet({ rows, surface: 'post_event_synthesis' })` — the SAME builder every surface uses. */
      claimSet: ClaimSet;
      /** Phase 39 (RPT-09/D-12): the ranked action candidates over `claimSet`. */
      actionCandidates: readonly ActionCandidate[];
    };

/**
 * Assembles the synthesis payload from the caller's OWN uid-scoped stored
 * trees ONLY (brief, registry row, matches, aliases) — there is no
 * parameter through which a caller can inject evidence (28-RESEARCH Security
 * Domain, T-28-19). Every evidence item is pre-tokenized with a
 * `serializeCitationToken` output, so the model never has to construct a
 * token character-by-character and validation is later a pure
 * set-membership check (owner invariant 1).
 *
 * Deliberately reuses `selectReviewResultsContext` (28-01) — the SAME
 * synced/manual classification the free review page renders (REV-02: the
 * plan is grounded in exactly what the review displays) — rather than
 * re-deriving its own event-match filter.
 *
 * The timestamp entry's `id` field (a synthesized, non-durable index value
 * for records still stored as a dense array — see `normalizeVodTimestampsNode`
 * and RESEARCH Pitfall 3) is deliberately NEVER read into the payload or the
 * token: the citable identifier is the stable `(matchId, seconds)` pair.
 */
export async function assembleSynthesisPayload(
  database: Database,
  uid: string,
  entryKey: string,
): Promise<AssembleSynthesisResult> {
  const [brief, registrySnapshot] = await Promise.all([
    readPrepBrief(database, uid, entryKey),
    database.ref(`tournamentEntries/${uid}/${entryKey}`).get(),
  ]);

  if (brief == null || !registrySnapshot.exists()) {
    return { found: false };
  }

  const entry = tournamentEntrySchema.parse(registrySnapshot.val());

  const [matchesSnapshot, aliasSnapshot] = await Promise.all([
    database.ref(`matches/${uid}`).get(),
    database.ref(`opponentAliases/${uid}`).get(),
  ]);

  // Single-hop alias lookup — opponentAliases/{uid} is already transitively
  // flattened by the write path, mirroring `assembleReportPayload`'s
  // established precedent (reports/generate.ts:245-260). Phase 36 (EVID-12,
  // D-14): the alias hop has exactly one implementation now —
  // `makeCanonicalizer` from the shared evidence engine
  // (`packages/shared/src/evidence/identity.ts`), the same idempotent
  // normalize-then-hop `opponentEvidence.ts` and `reports/generate.ts` use.
  const aliasMap = aliasSnapshot.exists()
    ? (aliasSnapshot.val() as Record<string, string>)
    : ({} as Record<string, string>);

  const canonicalOpponentName = makeCanonicalizer(aliasMap);

  // safeParse-and-skip (production-gap rule, mirrors RtdbService.listMatches):
  // parses through `matchRecordSchema` (NOT `matchSchema` — the latter
  // re-declares `vodTimestamps` as a plain, non-preprocess array schema for
  // encode-safety, which would reject both raw shapes `vodTimestamps` can
  // actually be stored in). `matchRecordSchema`'s preprocess runs
  // `normalizeVodTimestampsNode`, so every entry below already carries a
  // normalized, id-bearing, seconds-sorted `VodTimestamp[]` regardless of
  // whether the raw node was a legacy dense array or a keyed push-key
  // subtree.
  const rawMatches: Match[] = matchesSnapshot.exists()
    ? Object.entries(matchesSnapshot.val() as Record<string, unknown>).flatMap(([id, value]) => {
        const parsed = matchRecordSchema.safeParse(value);
        if (!parsed.success) {
          return [];
        }
        return [{ id, ...parsed.data } as Match];
      })
    : [];

  const aliasResolvedMatches: Match[] = rawMatches.map((match) =>
    match.opponent ? { ...match, opponent: canonicalOpponentName(match.opponent) } : match,
  );

  const { synced, manual } = selectReviewResultsContext(
    aliasResolvedMatches,
    entry,
    brief.likelyOpponents,
  );
  const eventMatches = [...synced, ...manual];

  // Phase 39 (D-05/D-11): ONE refresh timestamp for every row this payload
  // assembles, mirroring `assembleReportPayload`.
  const refreshedAt = Date.now();
  const rows = buildVodAnnotationRows({ eventMatches, refreshedAt });
  const claimSet = buildClaimSet({ rows, surface: 'post_event_synthesis' });
  const claimIdByEvidenceId = new Map<string, string>();
  for (const claim of claimSet.claims) {
    for (const evidenceId of claim.evidenceIds) {
      claimIdByEvidenceId.set(evidenceId, claim.id);
    }
  }

  const evidence: SynthesisEvidenceItem[] = [];
  for (const match of eventMatches) {
    const timestamps = match.vodTimestamps ?? [];
    for (const timestamp of timestamps) {
      const noteText = timestamp.note.trim();
      const rawLabel = noteText.length > 0 ? noteText : `vs ${match.opponent ?? 'opponent'}`;
      const label = rawLabel.slice(0, CITATION_LABEL_MAX_LENGTH);
      const cite = serializeCitationToken({
        sourceVodRef: match.id,
        seconds: timestamp.seconds,
        label,
      });
      evidence.push({
        matchId: match.id,
        opponent: match.opponent ?? null,
        result: match.win ? 'win' : 'loss',
        time: new Date(match.time).toISOString(),
        seconds: timestamp.seconds,
        note: timestamp.note,
        tags: timestamp.tags ?? [],
        cite,
        claimId: (() => {
          const evidenceId = vodEvidenceIdOrNull(match.id, timestamp.seconds);
          return evidenceId === null ? null : (claimIdByEvidenceId.get(evidenceId) ?? null);
        })(),
      });
    }
  }

  const allowedTokens = new Set(evidence.map((item) => item.cite));
  const allowedPairs = new Set(evidence.map((item) => `${item.matchId}:${item.seconds}`));

  // The match-id digest: count plus the canonical hash of the EVENT match
  // ids the rows were built from, sorted so the digest is independent of
  // read order — the same construction `assembleReportPayload` uses, reusing
  // the ONE canonicalizer (C1-B2).
  const eventMatchIds = eventMatches.map((match) => match.id).sort();
  const snapshot: EvidenceSnapshot = {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt,
    cohort: describeCohort(eventMatches),
    rows,
    matchIdDigest: { count: eventMatchIds.length, hash: canonicalDigest(eventMatchIds) },
  };
  // RPT-09/D-12: a LOST event match carrying at least one annotation is a
  // reviewable VOD — the synthesis analogue of the scout path's lost
  // head-to-head matches with timestamps.
  const vodRefs: VodRef[] = eventMatches
    .filter((match) => !match.win && (match.vodTimestamps?.length ?? 0) > 0)
    .map((match) => ({
      matchId: match.id,
      opponentTag: match.opponent ? match.opponent : null,
      opponentFighterId: match.opponent_id,
      lost: true,
    }));
  const actionCandidates = rankActionCandidates(
    buildActionCandidates({ claims: claimSet.claims, vodRefs }),
  );

  const wins = eventMatches.filter((match) => match.win).length;
  const losses = eventMatches.length - wins;

  const payload: SynthesisPayload = {
    entry: {
      eventName: entry.eventName,
      tournamentName: entry.tournamentName ?? null,
      dates: {
        firstSetAt: new Date(entry.firstSetAt).toISOString(),
        lastSetAt: new Date(entry.lastSetAt).toISOString(),
      },
    },
    briefContext: {
      reviewChecklistProgress: {
        completed: Object.keys(brief.reviewChecklist).length,
        total: REVIEW_CHECKLIST_ITEM_IDS.length,
      },
      likelyOpponents: Object.keys(brief.likelyOpponents),
    },
    results: { wins, losses },
    evidence,
    claims: claimSet.claims.map(toModelFacingClaim),
    actionCandidates: actionCandidates.map(toModelFacingActionCandidate),
  };

  return {
    found: true,
    payload,
    allowedTokens,
    allowedPairs,
    evidenceCount: evidence.length,
    rows,
    snapshot,
    claimSet,
    actionCandidates,
  };
}

// ---------------------------------------------------------------------------
// vod_annotation rows (Phase 39, plan 39-08, D-02)
// ---------------------------------------------------------------------------

/**
 * `vodEvidenceId`, or `null` for a match id that cannot form an
 * `EVIDENCE_ID_PATTERN`-safe key (`vodEvidenceId` THROWS on one). Every id
 * this app writes under `matches/{uid}` is key-safe today (RTDB push keys,
 * `sgg-<set>-g<n>`, `pgg-<match>-g<n>`), so this never fires on real data —
 * it exists so a hypothetical unsafe legacy key costs that one moment its
 * claim instead of failing the whole assembly.
 */
function vodEvidenceIdOrNull(matchId: string, seconds: number): string | null {
  const candidate = `${EVIDENCE_ID_PREFIX.vod_annotation}-${matchId}-${seconds}`;
  return isRtdbSafeKeySegment(candidate) ? vodEvidenceId(matchId, seconds) : null;
}

const KNOWN_FIGHTER_IDS: ReadonlySet<number> = new Set(SpriteList.map((fighter) => fighter.id));
const KNOWN_STAGE_IDS: ReadonlySet<number> = new Set(StageList.map((stage) => stage.id));

/**
 * D-02/RPT-05: the post-event synthesis surface's evidence ROWS — one
 * `vod_annotation` row per annotated `(matchId, seconds)` moment of the
 * event, fed to the SAME `buildClaimSet` every other surface uses.
 *
 * KEY: `vodEvidenceId(matchId, seconds)` — the EXPORTED bijection from
 * `packages/shared/src/evidence/snapshot.ts` (review C1-M8). This id IS the
 * shipped `allowedPairs` membership key `${matchId}:${seconds}` re-expressed
 * in an RTDB-key-safe form (`EVIDENCE_ID_PATTERN` rejects `:`), and
 * `parseVodEvidenceId` is its inverse — the set-equality proof in
 * `synthesis.test.ts` goes through that pair, never a raw string compare.
 *
 * SUBJECT: the moment's match context — my fighter, their fighter, the
 * stage and the (alias-resolved) opponent tag, each only when KNOWN (an
 * unknown character or the no-selection stage is never a claimable entity,
 * validator rule R7). The moment's identity stays in its evidence id; the
 * subject says what the moment is ABOUT, which (a) licenses the prose lint
 * to let a section name the matchup it cites, (b) keeps two moments from two
 * different matchups two claims when both abstain (an abstained value is the
 * same for every row sharing a sample, and the builder collapses identical
 * `(predicate, subject, value)` triples), and (c) gives
 * `engineAuthoredSummary` a subject-bearing claim to name.
 *
 * VALUE: `{ kind: 'count', count: seconds }` — the moment's recorded offset,
 * recomputable from the row (rule R2) and distinct per moment.
 *
 * SAMPLE: ONE event-level sample shared by every row (the
 * `opponent_character_usage` precedent in `generate.ts`): the countable
 * games are the event's ANNOTATED games, out of all of the event's games.
 * The tier therefore describes how much reviewed footage the plan rests on,
 * and a plan resting on fewer than `ABSTENTION_FLOOR_GAMES` annotated games
 * abstains exactly as every other family does below the floor.
 */
function buildVodAnnotationRows(input: {
  eventMatches: readonly Match[];
  refreshedAt: number;
}): Record<string, EvidenceRow> {
  const { eventMatches, refreshedAt } = input;
  const annotatedGames = eventMatches.filter((match) => (match.vodTimestamps?.length ?? 0) > 0);
  if (annotatedGames.length === 0) {
    return {};
  }
  const times = annotatedGames.map((match) => match.time);
  const sample: SampleMeta = {
    rawSampleSize: eventMatches.length,
    eligibleDenominator: annotatedGames.length,
    knownFieldCoverage: annotatedGames.length / eventMatches.length,
    dateRange: { firstMs: Math.min(...times), lastMs: Math.max(...times) },
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(annotatedGames.length),
  };
  const rows: Record<string, EvidenceRow> = {};
  for (const match of annotatedGames) {
    const stageId = match.map?.id ?? 0;
    const subject: ClaimSubject = {
      myFighterId: KNOWN_FIGHTER_IDS.has(match.fighter_id) ? match.fighter_id : null,
      opponentFighterId: KNOWN_FIGHTER_IDS.has(match.opponent_id) ? match.opponent_id : null,
      stageId: stageId !== 0 && KNOWN_STAGE_IDS.has(stageId) ? stageId : null,
      opponentTag: match.opponent ? match.opponent : null,
    };
    for (const timestamp of match.vodTimestamps ?? []) {
      const evidenceId = vodEvidenceIdOrNull(match.id, timestamp.seconds);
      if (evidenceId === null) {
        continue;
      }
      rows[evidenceId] = {
        predicate: 'vod_annotation',
        subject,
        value: { kind: 'count', count: timestamp.seconds },
        sample,
      };
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Citation validation — RETIRED (Phase 39, plan 39-08, D-02)
// ---------------------------------------------------------------------------
//
// 28-06's `validatePracticePlanCitations` (set-membership of each cited
// `(matchId, seconds)` pair in `allowedPairs`) is no longer a production
// validator: its rule is now rule R1 of the ONE shared validator
// (`validateReportOutput`, `packages/shared/src/evidence/validateReport.ts`),
// which the route runs over the `vod_annotation` claim set — an evidence id
// that is not a key of the snapshot, or a claim id this job never issued, is
// dropped. It was retired only after the shared validator was proven at
// least as strict on every fixture (plan 39-04's corpus-wide property test)
// and on real synthesis evidence (the migration battery in
// `routes/reportsSynthesis.test.ts`). Its body is frozen VERBATIM in
// `apps/api/src/test-support/retiredCitationRule.ts` so that battery and the
// RPT-08 fail-first binding (`rpt08LegacyOracle.test.ts`) keep running
// against the exact rule that shipped; no production file imports it.

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for the Anthropic client — mirrors
 * `generate.ts`'s `AnthropicLikeClient` seam. Lets tests pass a plain stub
 * instead of constructing a real `Anthropic` instance.
 *
 * Phase 39 (plan 39-08, review C1-M4): the `output_config.format` and
 * `parsed_output` positions name the claim-SELECTION schema — a mechanical,
 * in-scope consequence of swapping the schema `generatePracticePlan` passes
 * to `zodOutputFormat`. The request OPTIONS and the call SHAPE are unchanged.
 */
export interface SynthesisAnthropicClient {
  messages: {
    parse: (
      params: {
        model: string;
        max_tokens: number;
        thinking: { type: 'adaptive' };
        system: string;
        messages: Array<{ role: 'user'; content: string }>;
        output_config: {
          format: ReturnType<typeof zodOutputFormat<typeof claimSelectionSchema>>;
        };
      },
      /** Code review R4-WR-02: the route's one-attempt bound (`ReportModelRequestOptions`). */
      options?: ReportModelRequestOptions,
    ) => Promise<{
      stop_reason: string | null;
      parsed_output: ClaimSelection | null;
    }>;
  };
}

const SYNTHESIS_MODEL = 'claude-opus-4-8';
const SYNTHESIS_MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are a competitive Super Smash Bros. Ultimate coach writing a post-event practice plan for the user, grounded only in the moments they annotated in their own VODs from the event they just played.

The user message is JSON. "claims" are findings the app has already computed: each annotated VOD moment is one claim, with an id, what it is about (with the display names of its characters and stage), and its recorded value. A claim whose value is "abstained" is a gap in the evidence, not a finding. "evidence" lists the same moments with the user's own note and tags, each naming the id of its claim. "actionCandidates" are practice actions the app has already ranked; each lists the claim ids that justify it. "entry", "results" and "briefContext" are orientation only.

Your job is to choose which moments matter most and explain how they connect into a practice plan.
- Fill the three sections (overview, gameplan, watchFor). For each, list the ids of the claims it rests on, most important first, and write one or two short sentences of connective prose explaining how those moments fit together and what the user should practise.
- Fill up to three action slots, in priority order, with actions from actionCandidates, each naming the claim it rests on. Leave a slot null when no candidate fits.
- Use only claim ids and action ids that appear in the input.
- Do not compute, count, rank or estimate anything. Do not introduce any number, character, stage, player or event that is not in a claim you listed in that same section, and refer to characters and stages only by the display names those claims give. The app shows each claim's own values and the user's notes beside it, so the prose does not need to repeat them.`;

/**
 * Calls Claude to SELECT claims from the assembled synthesis payload (Phase
 * 39, plan 39-08, D-01/D-02): the output is a `ClaimSelection` over the
 * fixed claim-id vocabulary — the same schema the scout path sends — never
 * a free-prose plan. Same model, same max_tokens, same
 * `client.messages.parse` + `zodOutputFormat` call and the same
 * refusal/truncation/unparseable mapping as `generateScoutReport`; the guard
 * ORDER below (refusal, then truncation, then a null parse) is load-bearing
 * and unchanged. Reuses generate.ts's `ReportGenerationError` so the
 * route's existing catch handles both call sites identically.
 */
export async function generatePracticePlan(
  client: SynthesisAnthropicClient,
  payload: SynthesisPayload,
): Promise<ClaimSelection> {
  const response = await client.messages.parse({
    model: SYNTHESIS_MODEL,
    max_tokens: SYNTHESIS_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(buildSynthesisModelMessage(payload)) }],
    output_config: { format: zodOutputFormat(claimSelectionSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new ReportGenerationError('refusal');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ReportGenerationError('truncated');
  }
  if (response.parsed_output == null) {
    throw new ReportGenerationError('unparseable');
  }

  return response.parsed_output;
}

/** One evidence moment as the MODEL sees it: everything but the retired `cite` token. */
export type ModelFacingSynthesisEvidenceItem = Omit<SynthesisEvidenceItem, 'cite'>;

/** The synthesis user message: the payload with each moment's `cite` token removed. */
export type SynthesisModelMessage = Omit<SynthesisPayload, 'evidence'> & {
  evidence: ModelFacingSynthesisEvidenceItem[];
};

/**
 * Phase 39 (plan 39-08 Task 2, D-02): the model-facing synthesis message.
 * DECISION: the pre-serialized `{{cite:...}}` token is RETIRED from what the
 * model is sent. The model references a moment by its claim id (each
 * moment's `claimId`), and a token in its input only invites it to paste
 * `{{cite:matchId=...;seconds=...}}` — a match id and a number no claim
 * licenses — into connective prose, which the prose lint (rule R4) would
 * then strip. `cite` stays on `SynthesisEvidenceItem`, with `allowedTokens`,
 * as the TESTS-ONLY historical token universe the migration battery builds
 * shipped-rule outputs from; no production code path consumes it.
 */
export function buildSynthesisModelMessage(payload: SynthesisPayload): SynthesisModelMessage {
  return {
    ...payload,
    evidence: payload.evidence.map((item) => ({
      matchId: item.matchId,
      opponent: item.opponent,
      result: item.result,
      time: item.time,
      seconds: item.seconds,
      note: item.note,
      tags: item.tags,
      claimId: item.claimId,
    })),
  };
}

// ---------------------------------------------------------------------------
// projectPracticePlanSelection (plan 39-08, review C1-B1 practice-plan half)
// ---------------------------------------------------------------------------

export interface ProjectPracticePlanSelectionInput {
  entryKey: string;
  createdAt: number;
  selection: ClaimSelection;
  /** The claims that SURVIVED validation — never the issued set (plan 39-07's scout-side rule). */
  claims: readonly ClaimAtom[];
  /** Sections whose prose the validator stripped (D-20) — stored with empty prose, never re-derived. */
  strippedSectionIds?: readonly string[];
  /** The validation outcome's dropped count — stored only when positive. */
  droppedClaimCount?: number;
  /** The `passed` validation block, carrying the content-addressed snapshot id. */
  validation?: NonNullable<StoredPracticePlan['validation']>;
}

/** A projected practice plan: every stored field EXCEPT `focusAreas`, which is omitted on purpose (see below). */
export type ProjectedPracticePlan = Omit<StoredPracticePlan, 'focusAreas'>;

/**
 * The C1-B1 practice-plan projection — the synthesis twin of
 * `projectScoutSelection` (`./claimSelection.ts`), sharing its invention-free
 * discipline and its additive-field implementation
 * (`projectClaimRecordFields`). It projects a claim selection onto a record
 * the UNCHANGED `storedPracticePlanSchema` accepts. Pure and TOTAL — never
 * throws, never calls a model. The mapping:
 *
 * | stored field           | source                                                        |
 * |------------------------|---------------------------------------------------------------|
 * | `entryKey`/`createdAt` | the route                                                     |
 * | `summary`              | `sections.overview.connective` when `overview` is NOT stripped |
 * |                        | and non-empty after NFC + trim; else `engineAuthoredSummary`   |
 * |                        | over the surviving claims (review C2-H2(a)) — never `''`       |
 * | `focusAreas`           | OMITTED                                                        |
 * | `droppedClaimCount`    | the validation outcome, conditional spread                    |
 * | `strippedSectionCount` | `strippedSectionIds.length`, ABSENT when zero (D-20)           |
 * | `claimSchemaVersion`, `claims`, `sections`, `actions` | `projectClaimRecordFields`     |
 * | `validation`           | the route's `passed` block, conditional spread                 |
 *
 * `focusAreas` is omitted DELIBERATELY: it is `.default([])` on the stored
 * schema, its `title` is `.min(1)`, and there is no honest source for a
 * focus-area title in a claim selection — synthesizing one would be exactly
 * the invention this projection exists to prevent. A record carrying
 * `claims` renders through the claim-anchored path (plan 39-09) from
 * `sections` + `claims`; a legacy record carrying `focusAreas` keeps
 * rendering through today's path. Plan 39-09 handles both.
 *
 * Why `summary` falls back rather than failing: D-07 makes the surviving
 * CLAIM count the failure axis, and this projection is only reached on a
 * `passed` outcome — so at least `MIN_VIABLE_CLAIMS['post_event_synthesis']`
 * claims survive and the engine-authored fallback always has a claim to
 * describe. Routing a stripped `overview` to a refund instead would
 * reintroduce the prose-to-refund path review C2-H3 removed.
 */
export function projectPracticePlanSelection(
  input: ProjectPracticePlanSelectionInput,
): ProjectedPracticePlan {
  const { entryKey, createdAt, selection, claims, validation, droppedClaimCount } = input;
  const stripped = new Set(input.strippedSectionIds ?? []);
  const overview = selection.sections.overview.connective;
  const usableOverview =
    !stripped.has('overview') && overview.normalize('NFC').trim().length > 0 ? overview : null;
  return {
    entryKey,
    createdAt,
    summary: usableOverview ?? engineAuthoredSummary(claims),
    ...projectClaimRecordFields({
      selection,
      claims,
      strippedSectionIds: input.strippedSectionIds,
    }),
    ...(validation ? { validation } : {}),
    ...(droppedClaimCount ? { droppedClaimCount } : {}),
  };
}
