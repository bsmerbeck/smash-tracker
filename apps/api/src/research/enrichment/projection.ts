import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  isSourceOwnedStageValue,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentProjectionStateRecordSchema,
  resolveEnrichedMatchMembers,
  UNKNOWN_STAGE,
  type EnrichedMatchMembersResult,
  type EnrichmentCharsOutcome,
  type EnrichmentCharsWitnessCommitAction,
  type EnrichmentGameEvidenceInput,
  type EnrichmentOwnershipWitness,
  type EnrichmentStageWitnessCommitAction,
  type EnrichmentStageWitnessPreWriteAction,
  type EnrichmentStocksOutcome,
  type EnrichmentStocksWitnessCommitAction,
  type EnrichmentStocksWitnessPreWriteAction,
  type EnrichmentVodOutcome,
  type EnrichmentVodSourceInput,
  type EnrichmentStageOutcome,
  type EnrichmentVodWitnessCommitAction,
  type EnrichmentVodWitnessPreWriteAction,
  type MatchStage,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentObservationRecord,
  type ResearchEnrichmentProjectionStateRecord,
  type ResearchLiquipediaStageForm,
} from '@smash-tracker/shared';
import { normalizeOpponentTag } from '../../startgg/sync.js';
import { isPathSafeTenantId } from '../subjectKind.js';
import { listAttachmentsForSet, readEnrichmentObservation } from './store.js';
import {
  readConfirmedCandidateVodForSet,
  VOD_CANDIDATE_MAX_ORDINAL_PROBE,
} from './vodDiscovery.js';

/**
 * Phase 30.2 Plan 08 (ENR-07/ENR-08, cycle-1 review HIGH 2/HIGH 3): the
 * enrichment applier — the ONLY writer of `matches/{tenantId}/{key}.vodUrl`
 * and `.map` from Liquipedia data, and the only writer of the
 * `researchEnrichmentProjection/{tenantId}/{matchKey}` ownership witness.
 *
 * Reads attachments through `listAttachmentsForSet` ONLY. An observation
 * that is not attached is invisible here — `buildEnrichmentOverlay` never
 * sees an attachment it was not handed, so an unattached observation
 * produces no candidate key and therefore no write, without any extra
 * filtering logic in this file.
 *
 * Every ownership decision is delegated to the shared, pure
 * `resolveEnrichedMatchMembers` — this module never reimplements the
 * fill-empty-only or provider-authoritative rules, so it cannot disagree
 * with `apps/api/src/research/ingestion/projection.ts`'s additive overlay
 * parameter (task 3), which delegates to the same function.
 *
 * THREE-PHASE WRITE ORDER (cycle-1 review HIGH 3 — this is the whole point
 * of this module, stated here and nowhere else):
 *
 *   Phase A — witness PRE-WRITE. One multi-path update recording the
 *   `pending*` half of every affected witness record, leaving the
 *   committed half untouched.
 *   Phase B — per-row transactions. Each affected row is written through
 *   its OWN `.transaction()` on its own path, so the merge runs against
 *   the value RTDB holds at commit time.
 *   Phase C — witness COMMIT. One multi-path update promoting each
 *   pending value into the committed half and CLEARING the pending half
 *   (absent members, never nulls, per the house null-stripping rule).
 *
 * WRITE-TIME OWNERSHIP RESOLUTION (30.2 gap-closure BLOCKER 1). The
 * planning pass below is a PLAN, never a decision. An earlier draft
 * resolved ownership ONCE against the pre-read row and then had phase B's
 * transaction destructure the transaction-current `vodUrl`/`map` away and
 * write the plan-time result — so a user edit landing between the plan read
 * (or phase A's pre-write) and that row's transaction was silently
 * overwritten, violating ENR-08/D-21's absolute rule that a user-entered
 * URL may NEVER be overwritten. The transaction callback therefore
 * RE-RESOLVES: it calls the same pure `resolveEnrichedMatchMembers` against
 * the TRANSACTION-CURRENT row (`current ?? cachedRow`), with the same
 * overlay and the same plan-time witness. The resolver is pure and total,
 * so re-running it on every retry attempt is safe by construction.
 *
 * ...AND THE COMMITTED ATTEMPT IS THE ONE THAT COUNTS. A transaction
 * callback may run several times (the real SDK's local-cache-first run, then
 * one re-run per hash mismatch); only ONE of those attempts is the one RTDB
 * actually commits. Reading the resolution back out of a closure variable
 * the callback assigned would therefore report whatever the LAST attempt
 * computed, committed or not. Instead every attempt is APPENDED to a list,
 * and `selectCommittedResolution` picks the attempt whose resolved
 * `vodUrl`/`map` match the transaction's own COMMITTED snapshot — so the
 * per-row outcome, the counters and the phase C witness commit all describe
 * what is genuinely stored. An uncommitted transaction resolves to
 * `voidedResolution`: no witness commit at all, which (paired with the
 * PLAN-TIME pre-write action below) still CLEARS the pending half, so a
 * pending witness whose fill never committed vouches for nothing. That
 * pairing is deliberate and is the one place the two resolutions are mixed:
 * phase C's commit action comes from the COMMITTED resolution, while its
 * pre-write action comes from the PLAN-TIME resolution, because phase A
 * wrote the plan-time pending half and only that half needs clearing.
 * `isSourceOwnedVodValue`'s value-comparison contract is what makes any
 * residue harmless: a witness whose recorded value does not match the row
 * vouches for nothing.
 *
 * This DELIBERATELY INVERTS the shipped `applyLegacyProjection` order (rows
 * first, index update second). In the shipped path the second write is a
 * projected-key INDEX whose staleness is self-correcting on the next pass —
 * a crash between the two writes is healed the next time the same source
 * record is re-derived. Here the second write would be the ONLY EVIDENCE
 * that a value is source-owned, so a crash between the two is NOT
 * self-correcting: the row would hold a non-empty value with no witness,
 * the ownership rule would have to call it user-owned, and the projected
 * value would become permanently uncorrectable while polluting the
 * user-owned skip counter. Cycle-1 review HIGH 3 identified exactly this
 * gap in an earlier draft's rows-first ordering, and that draft's claim
 * that the gap "is healed by the next enrichment pass" was wrong — nothing
 * about a later pass repairs a witness that was never written. Witness-first
 * plus the shared resolver's two-value accepted set (committed ∪ pending)
 * makes every crash point leave the stored value inside the set the
 * witness vouches for, so a retry always converges on the crash-free final
 * state.
 *
 * THE RESIDUAL, ACCEPTED WINDOW, stated honestly: a crash between phase A
 * and phase B can leave a pending witness for a row that never received the
 * value. That is benign — the shared resolver treats an empty row with a
 * pending witness as a fill-empty (behavior list item 6), and a genuine
 * user value in that row still matches neither witness value and is still
 * preserved (`skipped-user-owned`) — and because this module always
 * re-derives its plan from the CURRENT witness state on every invocation
 * (there is no separate "trust an old plan" path), a later run simply
 * reissues phase A rather than trusting a stale one.
 *
 * NEVER CREATES A MATCH ROW. Enrichment only fills members of rows the
 * provider projection already created. A row created by enrichment would be
 * a Liquipedia-authored match masquerading as a start.gg one. Existence is
 * decided ONCE, by a plain read, before any row's transaction is even
 * attempted; a row absent at that point is counted
 * (`attachedNoProjectableRows`) and never touched again this run.
 *
 * THE MERGED STAGE-IDEMPOTENCY DESIGN (30.3 Gate 5 commit 1 fused with
 * 30.2's defect-C composition fix — two independent fixes for the same
 * hazard, reconciled at merge time into one design). The hazard: this
 * applier's only stage input is the STORED row, and on a re-apply the
 * stored stage is its own earlier projection echoed back; presenting that
 * echo to the shared resolver as `providerStage` tripped provider-wins and
 * CLEARED the stage witness. The surviving design has three parts:
 *
 *   1. OWNERSHIP TEST — the shared `isSourceOwnedStageValue` (committed ∪
 *      PENDING accepted set) decides whether the stored stage is this
 *      pipeline's own projection. The pending half is load-bearing: a crash
 *      between the row write (phase B) and the witness commit (phase C)
 *      leaves a row stage only the pending half vouches for, and a
 *      committed-only test would clear that witness on the recovery pass.
 *   2. PRESENTATION — an own-projection stage is presented to the resolver
 *      as the unknown sentinel (the enrichment slot is still open); the
 *      resolver's committed-identical branch makes a healthy replay a
 *      witness-preserving no-op, and `resolveForRow` relabels it
 *      'provider-authoritative' so every label consumer (the run driver's
 *      cohort restatement, the stageEnriched counters, dry-run details)
 *      sees exactly the pre-fix healthy-set semantics.
 *   3. TRIGGER — `previewEnrichmentProjection` emits a value-derived
 *      `wouldChangeRow` per row (vodUrl, map, AND stocksLeft compared
 *      against the resolved members); the run driver's
 *      resume-reconciliation pass keys on that boolean, never on outcome
 *      labels, so it reprojects exactly the sets whose rows are missing a
 *      fill and skips every healthy set.
 */

// ---------------------------------------------------------------------------
// Overlay construction — pure, no I/O
// ---------------------------------------------------------------------------

export interface EnrichedStage {
  /** Untrusted third-party source text — never dropped. */
  raw?: string;
  form?: ResearchLiquipediaStageForm;
  /** Present only when the raw stage text was mapped to a canonical stage id. */
  canonicalStageId?: number;
  observationId: string;
  sourceRevisionId: number;
  parserVersion: string;
}

/**
 * 30.3 Gate 5: one row's raw character/stock evidence, exactly as the
 * attached observation stated it — source-seat-keyed tuples plus the
 * observation's game scope and set-level player tags. Everything here is
 * RAW: seat tags are NOT normalized (the applier normalizes at resolution
 * time with the same `normalizeOpponentTag` the ingestion projection used
 * to author the row's `opponent` member), characters are the wiki's own
 * strings, and no orientation has been decided.
 */
export interface EnrichedGameEvidence {
  game?: string;
  seatTags?: [string | null, string | null];
  rawChars?: [string | null, string | null];
  stocks?: [number | null, number | null];
  winnerSeat?: 1 | 2;
  observationId: string;
  sourceRevisionId: number;
  parserVersion: string;
}

export interface EnrichmentOverlay {
  enrichedVodUrlByKey: Record<string, string>;
  /**
   * The provenance of each `enrichedVodUrlByKey` entry — the observation
   * that supplied the URL, its revision and its parser version.
   *
   * OPTIONAL, and separate from the URL map rather than folded into it,
   * because `resolveEnrichedMatchMembers` explicitly documents that a
   * caller with less provenance than it would like still gets a correct
   * fill/correct/remove decision and simply stamps a thinner witness. Every
   * pre-existing caller that builds a bare `Record<string, string>` URL map
   * therefore keeps working unchanged.
   *
   * 30.2 gap-closure BLOCKER 2: without this, the witness's VOD half never
   * receives a `vodObservationId`, and the field-scoped attribution response
   * built from it could never carry a VOD source page — the VOD half of
   * ENR-09 attribution would be structurally dead, and the only way a VOD
   * surface could show a source link would be to borrow the STAGE
   * observation's page, which is exactly the mislabelling BLOCKER 2 removes.
   */
  enrichedVodSourceByKey?: Record<string, EnrichmentVodSourceInput>;
  enrichedStageByKey: Record<string, EnrichedStage>;
  /** OPTIONAL (30.3 Gate 5) so every pre-existing overlay literal keeps compiling; absent means "no character/stock evidence for any row". */
  enrichedGameEvidenceByKey?: Record<string, EnrichedGameEvidence>;
}

export interface BuildEnrichmentOverlayInput {
  targetSetId: string;
  attachments: ResearchEnrichmentAttachmentRecord[];
  observations: Record<string, ResearchEnrichmentObservationRecord>;
}

/**
 * Mirrors `apps/api/src/research/ingestion/projection.ts:262`'s
 * `sgg-${storageKey}-g${index + 1}` construction EXACTLY — `targetSetId` is
 * always `storageKey ?? providerSetId` (PATTERNS.md section "Path key"), the
 * same value the enrichment attachment tree is already keyed by. Do not
 * invent a second key shape; this module reads the exact construction from
 * the shipped projection and mirrors it.
 */
export function deriveEnrichmentMatchRowKey(targetSetId: string, gameOrdinal: number): string {
  return `sgg-${targetSetId}-g${gameOrdinal}`;
}

/**
 * A PURE function of its input — no I/O. `buildEnrichmentOverlay` derives
 * the ordinal universe for each attached observation from that
 * observation's OWN `games[]` array (the same bracket-page record that
 * carries stage data typically also carries the set-level VOD, per the
 * Supernova regression fixture — a grand final observation's `games` has
 * length 3, its reset's has length 5, and the two target sets remain
 * distinct calls). An observation with a `vodUrl` but no `games[]` at all
 * (a bare player-VOD-list reference with no declared per-game breakdown)
 * applies its URL to ordinal 1 only — the conservative minimal
 * application; a future plan that discovers a genuine multi-game VOD
 * reference with no bracket corroboration can widen this convention with
 * its own written reason.
 *
 * The declared ordinal universe may exceed the target set's REAL match row
 * count (Liquipedia and start.gg can disagree on game count) — this
 * function does not know and does not care; `applyEnrichmentProjection`
 * discovers real row existence and counts the surplus.
 */
export function buildEnrichmentOverlay(input: BuildEnrichmentOverlayInput): EnrichmentOverlay {
  const enrichedVodUrlByKey: Record<string, string> = {};
  const enrichedVodSourceByKey: Record<string, EnrichmentVodSourceInput> = {};
  const enrichedStageByKey: Record<string, EnrichedStage> = {};
  const enrichedGameEvidenceByKey: Record<string, EnrichedGameEvidence> = {};

  for (const attachment of input.attachments) {
    const record = input.observations[attachment.observationId];
    if (!record) {
      // An attachment naming an observation the caller never loaded is
      // skipped, never fabricated (mirrors `overlayEnrichment` in store.ts).
      continue;
    }

    const games = record.games ?? [];
    const declaredOrdinals = games.map((game) => game.ordinal);
    const maxOrdinal =
      declaredOrdinals.length > 0 ? Math.max(...declaredOrdinals) : record.vodUrl ? 1 : 0;

    if (record.vodUrl) {
      for (let ordinal = 1; ordinal <= maxOrdinal; ordinal += 1) {
        const rowKey = deriveEnrichmentMatchRowKey(input.targetSetId, ordinal);
        enrichedVodUrlByKey[rowKey] = record.vodUrl;
        // The VOD's OWN provenance — the observation that carried the URL,
        // never the stage observation for the same row (30.2 gap-closure
        // BLOCKER 2: the two are independent and may be different pages).
        enrichedVodSourceByKey[rowKey] = {
          observationId: record.observationId,
          sourceRevisionId: record.sourceRevisionId,
          parserVersion: record.parserVersion,
        };
      }
    }

    for (const game of games) {
      if (game.canonicalStageId != null || game.rawStage != null) {
        enrichedStageByKey[deriveEnrichmentMatchRowKey(input.targetSetId, game.ordinal)] = {
          ...(game.rawStage != null ? { raw: game.rawStage } : {}),
          ...(game.stageForm != null ? { form: game.stageForm } : {}),
          ...(game.canonicalStageId != null ? { canonicalStageId: game.canonicalStageId } : {}),
          observationId: record.observationId,
          sourceRevisionId: record.sourceRevisionId,
          parserVersion: record.parserVersion,
        };
      }

      // 30.3 Gate 5: character/stock evidence — carried RAW, source-seat
      // keyed, with the observation's set-level player tags and game scope
      // alongside, so the applier can prove (or abstain from) the
      // seat->subject orientation at resolution time. A game with neither
      // characters nor stocks contributes no evidence entry at all.
      const hasCharEvidence =
        game.rawChars != null && (game.rawChars[0] != null || game.rawChars[1] != null);
      const hasStockEvidence =
        game.stocks != null && (game.stocks[0] != null || game.stocks[1] != null);
      if (hasCharEvidence || hasStockEvidence) {
        const seatTags: [string | null, string | null] | undefined = record.players
          ? [record.players[0]?.rawTag ?? null, record.players[1]?.rawTag ?? null]
          : undefined;
        enrichedGameEvidenceByKey[deriveEnrichmentMatchRowKey(input.targetSetId, game.ordinal)] = {
          ...(record.game != null ? { game: record.game } : {}),
          ...(seatTags !== undefined ? { seatTags } : {}),
          ...(game.rawChars != null ? { rawChars: game.rawChars } : {}),
          ...(game.stocks != null ? { stocks: game.stocks } : {}),
          ...(game.winnerSeat != null ? { winnerSeat: game.winnerSeat } : {}),
          observationId: record.observationId,
          sourceRevisionId: record.sourceRevisionId,
          parserVersion: record.parserVersion,
        };
      }
    }
  }

  return {
    enrichedVodUrlByKey,
    enrichedVodSourceByKey,
    enrichedStageByKey,
    enrichedGameEvidenceByKey,
  };
}

// ---------------------------------------------------------------------------
// Apply — the crash-safe two-phase (three-write) applier
// ---------------------------------------------------------------------------

export interface EnrichmentProjectionRowOutcome {
  matchKey: string;
  vodOutcome: EnrichmentVodOutcome;
  stageOutcome: EnrichmentStageOutcome;
  /** 30.3 Gate 5 — OPTIONAL so every pre-existing consumer of the row list keeps compiling; omitted when the evidence half was not in play for the row. */
  charsOutcome?: EnrichmentCharsOutcome;
  stocksOutcome?: EnrichmentStocksOutcome;
  /**
   * PREVIEW-ONLY (set by `previewEnrichmentProjection`, absent on apply):
   * `true` when applying would actually change the stored row's `vodUrl`,
   * `map`, or `stocksLeft` — the signal the run driver's
   * resume-reconciliation trigger keys on (30.2 defect-C composition).
   * Outcome labels alone cannot carry this: under the merged own-projection
   * guard an identical replay is relabeled `provider-authoritative` (30.3
   * Gate 5) while a witness-vouched row missing its fill reports
   * `enriched` — the trigger needs the VALUE comparison either way, and a
   * boolean derived from the resolved members is robust to both labelings.
   */
  wouldChangeRow?: boolean;
}

export interface EnrichmentProjectionCounts {
  stageEnriched: number;
  vodFilledEmpty: number;
  vodSkippedUserOwned: number;
  unknownStageAfterEnrichment: number;
  attachedNoProjectableRows: number;
}

/**
 * 30.3 Gate 5: the character/stock evidence tallies, kept as a SEPARATE
 * sibling of `EnrichmentProjectionCounts` rather than new members on it —
 * `run.ts`'s fold builds an `EnrichmentProjectionCounts` literal and
 * iterates its keys with `+=`; growing that interface (even optionally)
 * would break its typecheck without touching that file, which this gate's
 * ownership boundary forbids. The run-level staging of these counters into
 * the coverage node is therefore a named follow-up for the run driver.
 */
export interface EnrichmentEvidenceCounts {
  charactersEnriched: number;
  charactersUnmapped: number;
  charactersAbstained: number;
  stocksFilledEmpty: number;
  stocksSkippedOwned: number;
  stocksAbstained: number;
}

export interface EnrichmentProjectionOutcome {
  rows: EnrichmentProjectionRowOutcome[];
  counts: EnrichmentProjectionCounts;
  evidenceCounts: EnrichmentEvidenceCounts;
}

function emptyOutcome(): EnrichmentProjectionOutcome {
  return {
    rows: [],
    counts: {
      stageEnriched: 0,
      vodFilledEmpty: 0,
      vodSkippedUserOwned: 0,
      unknownStageAfterEnrichment: 0,
      attachedNoProjectableRows: 0,
    },
    evidenceCounts: {
      charactersEnriched: 0,
      charactersUnmapped: 0,
      charactersAbstained: 0,
      stocksFilledEmpty: 0,
      stocksSkippedOwned: 0,
      stocksAbstained: 0,
    },
  };
}

/** Folds one resolved row into the outcome's counters — ONE tally definition shared by the preview and the applier so the two can never disagree. */
function tallyResolvedRow(
  outcome: EnrichmentProjectionOutcome,
  resolved: EnrichedMatchMembersResult,
): void {
  if (resolved.vodOutcome === 'filled-empty') {
    outcome.counts.vodFilledEmpty += 1;
  }
  if (resolved.vodOutcome === 'skipped-user-owned') {
    outcome.counts.vodSkippedUserOwned += 1;
  }
  if (resolved.stageOutcome === 'enriched') {
    outcome.counts.stageEnriched += 1;
  }
  if (resolved.stageOutcome === 'unknown') {
    outcome.counts.unknownStageAfterEnrichment += 1;
  }
  if (resolved.charsOutcome === 'enriched') {
    outcome.evidenceCounts.charactersEnriched += 1;
  }
  if (resolved.charsOutcome === 'partial-unmapped') {
    outcome.evidenceCounts.charactersUnmapped += 1;
  }
  if (
    resolved.charsOutcome === 'abstained-orientation' ||
    resolved.charsOutcome === 'abstained-game-scope'
  ) {
    outcome.evidenceCounts.charactersAbstained += 1;
  }
  if (resolved.stocksOutcome === 'filled-empty') {
    outcome.evidenceCounts.stocksFilledEmpty += 1;
  }
  if (resolved.stocksOutcome === 'skipped-owned') {
    outcome.evidenceCounts.stocksSkippedOwned += 1;
  }
  if (
    resolved.stocksOutcome === 'abstained-orientation' ||
    resolved.stocksOutcome === 'abstained-game-scope' ||
    resolved.stocksOutcome === 'abstained-winner-disagreement' ||
    resolved.stocksOutcome === 'abstained-value'
  ) {
    outcome.evidenceCounts.stocksAbstained += 1;
  }
}

/** Builds one row-outcome entry from a resolution — again ONE definition for both the preview and the applier. The evidence outcomes are OMITTED when `'none'` (no evidence in play), so rows untouched by the evidence half keep their exact pre-30.3 shape. */
function toRowOutcome(
  matchKey: string,
  resolved: EnrichedMatchMembersResult,
): EnrichmentProjectionRowOutcome {
  return {
    matchKey,
    vodOutcome: resolved.vodOutcome,
    stageOutcome: resolved.stageOutcome,
    ...(resolved.charsOutcome !== 'none' ? { charsOutcome: resolved.charsOutcome } : {}),
    ...(resolved.stocksOutcome !== 'none' ? { stocksOutcome: resolved.stocksOutcome } : {}),
  };
}

/**
 * Read-only counterpart to {@link applyEnrichmentProjection}. It evaluates
 * the exact shared ownership resolver against the current rows and witnesses
 * but performs no transaction or update. The operator dry-run manifest uses
 * this function so its VOD fill/skip and stage figures describe the current
 * production state without relying on a second, approximate implementation.
 */
export async function previewEnrichmentProjection(
  database: Database,
  tenantId: string,
  targetSetId: string,
  overlay: EnrichmentOverlay,
): Promise<EnrichmentProjectionOutcome> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return emptyOutcome();
  }

  overlay = await widenOverlayWithConfirmedCandidate(database, tenantId, targetSetId, overlay);

  const witnessTree = await database.ref(`researchEnrichmentProjection/${tenantId}`).get();
  const previouslyWitnessedKeys: string[] = [];
  if (witnessTree.exists()) {
    for (const [key, value] of Object.entries(witnessTree.val() as Record<string, unknown>)) {
      const parsed = readWitnessFromValue(value);
      if (parsed?.targetSetId === targetSetId && witnessCarriesAnyClaim(parsed)) {
        previouslyWitnessedKeys.push(key);
      }
    }
  }
  const touchedKeys = Array.from(
    new Set([
      ...Object.keys(overlay.enrichedVodUrlByKey),
      ...Object.keys(overlay.enrichedStageByKey),
      ...Object.keys(overlay.enrichedGameEvidenceByKey ?? {}),
      ...previouslyWitnessedKeys,
    ]),
  ).filter((key) => isPathSafeProviderId(key));
  const outcome = emptyOutcome();

  for (const key of touchedKeys) {
    const [rowSnapshot, witnessSnapshot] = await Promise.all([
      database.ref(`matches/${tenantId}/${key}`).get(),
      database.ref(`researchEnrichmentProjection/${tenantId}/${key}`).get(),
    ]);
    if (!rowSnapshot.exists()) {
      outcome.counts.attachedNoProjectableRows += 1;
      continue;
    }
    const row = rowSnapshot.val() as Record<string, unknown>;
    const witness = readWitnessFromValue(witnessSnapshot.exists() ? witnessSnapshot.val() : null);
    const resolved = resolveForRow(overlay, key, row, witness);
    // The row-change-aware trigger signal (30.2 defect-C composition,
    // master's half of the dual fix): a VALUE comparison over every member
    // this module writes — vodUrl, map, and (30.3 Gate 5) stocksLeft — so
    // the run driver's reconciliation pass keys on "would a write happen",
    // never on outcome labels.
    const wouldChangeRow =
      (resolved.vodUrl ?? undefined) !== extractExistingVodUrl(row) ||
      !stagesEqual(resolved.stage, extractExistingStage(row)) ||
      (resolved.stocksLeft ?? undefined) !== extractExistingStocksLeft(row);
    outcome.rows.push({ ...toRowOutcome(key, resolved), wouldChangeRow });
    tallyResolvedRow(outcome, resolved);
  }

  return outcome;
}

/**
 * A witness that carries ANY claim — VOD or stage, committed or pending —
 * makes its key a candidate for this run even when the current overlay no
 * longer mentions it: that is exactly how a removal (the source stopped
 * supplying a value it once projected) is discovered. 30.3 Gate 5 commit 1
 * WIDENED this from the VOD halves alone to the stage halves too, so a
 * stage-only witness whose observation was detached is found and its
 * projected stage removed, instead of surviving as an unattributable
 * orphan.
 */
function witnessCarriesAnyClaim(parsed: ResearchEnrichmentProjectionStateRecord): boolean {
  return (
    parsed.projectedVodUrl != null ||
    parsed.pendingVodUrl != null ||
    parsed.pendingVodRemoval === true ||
    parsed.projectedStageId != null ||
    parsed.projectedStageRaw != null ||
    parsed.pendingStageId != null ||
    parsed.pendingStageRaw != null
  );
}

/**
 * 30.3 Gate 5 — the PRIORITY-5 merge: the strongest admin-CONFIRMED YouTube
 * candidate for the set fills row keys NO observation URL already covers
 * (an attached Liquipedia observation always outranks a candidate), and
 * only for rows that EXIST (probed up to `VOD_CANDIDATE_MAX_ORDINAL_PROBE`
 * ordinals — this module never creates a match row). Merging INSIDE the
 * applier/preview, rather than in the overlay builders, means every caller
 * of `applyEnrichmentProjection` — run.ts's projection pass, refresh.ts's
 * re-apply, the confirm route — respects the confirmed candidate; an
 * overlay-builder-only merge would let an enrichment run's observation-only
 * overlay treat a candidate-projected URL as source-removed and strip it.
 * The user/provider priorities (1–2) are the shared resolver's own
 * ownership rules and are untouched by this merge.
 */
async function widenOverlayWithConfirmedCandidate(
  database: Database,
  tenantId: string,
  targetSetId: string,
  overlay: EnrichmentOverlay,
): Promise<EnrichmentOverlay> {
  const confirmed = await readConfirmedCandidateVodForSet(database, tenantId, targetSetId);
  if (!confirmed) {
    return overlay;
  }
  const enrichedVodUrlByKey = { ...overlay.enrichedVodUrlByKey };
  const enrichedVodSourceByKey = { ...(overlay.enrichedVodSourceByKey ?? {}) };
  for (let ordinal = 1; ordinal <= VOD_CANDIDATE_MAX_ORDINAL_PROBE; ordinal += 1) {
    const key = deriveEnrichmentMatchRowKey(targetSetId, ordinal);
    if (!isPathSafeProviderId(key) || enrichedVodUrlByKey[key] !== undefined) {
      continue;
    }
    const rowSnapshot = await database.ref(`matches/${tenantId}/${key}`).get();
    if (!rowSnapshot.exists()) {
      continue;
    }
    enrichedVodUrlByKey[key] = confirmed.videoUrl;
    enrichedVodSourceByKey[key] = { candidateId: confirmed.candidateId };
  }
  return { ...overlay, enrichedVodUrlByKey, enrichedVodSourceByKey };
}

/** Returns the FULL stored record (including `matchKey`/`targetSetId`) — structurally a superset of `EnrichmentOwnershipWitness`, so it may be passed anywhere that narrower type is expected. */
function readWitnessFromValue(value: unknown): ResearchEnrichmentProjectionStateRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = researchEnrichmentProjectionStateRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractExistingVodUrl(row: Record<string, unknown> | null): string | undefined {
  return row && typeof row.vodUrl === 'string' && row.vodUrl.length > 0
    ? (row.vodUrl as string)
    : undefined;
}

function extractExistingStage(row: Record<string, unknown> | null): MatchStage {
  const map = row?.map;
  if (map && typeof map === 'object' && typeof (map as MatchStage).id === 'number') {
    return map as MatchStage;
  }
  return UNKNOWN_STAGE;
}

function extractExistingStocksLeft(row: Record<string, unknown> | null): number | undefined {
  return row && typeof row.stocksLeft === 'number' ? (row.stocksLeft as number) : undefined;
}

/**
 * The ONE place this module builds a resolver input — called from the
 * planning pass AND from inside every phase B transaction attempt, so the
 * plan and the write can never disagree about anything except the row state
 * they were handed (30.2 gap-closure BLOCKER 1).
 */
function resolveForRow(
  overlay: EnrichmentOverlay,
  key: string,
  row: Record<string, unknown>,
  witness: EnrichmentOwnershipWitness | null,
): EnrichedMatchMembersResult {
  const vodSource = overlay.enrichedVodSourceByKey?.[key];
  // THE STAGE-WITNESS IDEMPOTENCY FIX — the MERGED design of two
  // independent fixes for the same hazard (30.3 Gate 5 commit 1 and 30.2's
  // defect-C composition fix; see this module's header). The shared
  // resolver's `providerStage` input means "a stage the PROVIDER vouches
  // for", but this applier only has the STORED row — and on a re-apply the
  // stored stage may be this module's OWN earlier projection echoed back
  // (which the parser-version re-key forces for every previously-matched
  // set, via supersede -> re-attach -> re-project). Handing that echo to
  // the resolver as a provider stage tripped "a provider-resolved stage
  // always wins" and CLEARED the stage witness — silently converting an
  // enrichment-owned stage into an uncorrectable, unattributable one. The
  // witness is the disambiguator: a stored stage `isSourceOwnedStageValue`
  // vouches for is passed as the unknown sentinel instead — the enrichment
  // slot is still open — and the resolver's committed-identical branch
  // turns the replay into a witness-preserving no-op. The SHARED predicate
  // survives (over master's inline committed-only check) because its
  // accepted set is committed ∪ PENDING: a crash between the row write
  // (phase B) and the witness commit (phase C) leaves a row stage only the
  // pending half vouches for, and a committed-only guard would clear that
  // witness on the recovery pass. A GENUINE provider-resolved stage (one
  // no witness half vouches for) still wins unconditionally.
  const storedStage = extractExistingStage(row);
  const stageIsOwnProjection = isSourceOwnedStageValue(storedStage, witness);
  // 30.3 Gate 5: the character/stock evidence context. The seat tags and the
  // row's opponent member go through the SAME normalizer the ingestion
  // projection used to AUTHOR that member (`normalizeOpponentTag`), so the
  // shared resolver's exact-equality orientation proof compares like with
  // like. `normalizeOpponentTag`'s empty-input sentinel ('unknown') is
  // withheld — a sentinel matching a sentinel would fabricate a proof.
  const evidence = overlay.enrichedGameEvidenceByKey?.[key];
  const gameEvidence: EnrichmentGameEvidenceInput | undefined = evidence
    ? {
        ...(evidence.game !== undefined ? { game: evidence.game } : {}),
        ...(evidence.seatTags !== undefined
          ? {
              seatTags: [
                evidence.seatTags[0] != null ? normalizeOpponentTag(evidence.seatTags[0]) : null,
                evidence.seatTags[1] != null ? normalizeOpponentTag(evidence.seatTags[1]) : null,
              ] as [string | null, string | null],
            }
          : {}),
        ...(evidence.rawChars !== undefined ? { rawChars: evidence.rawChars } : {}),
        ...(evidence.stocks !== undefined ? { stocks: evidence.stocks } : {}),
        ...(evidence.winnerSeat !== undefined ? { winnerSeat: evidence.winnerSeat } : {}),
        observationId: evidence.observationId,
        sourceRevisionId: evidence.sourceRevisionId,
        parserVersion: evidence.parserVersion,
      }
    : undefined;
  const rowOpponent =
    typeof row.opponent === 'string' ? normalizeOpponentTag(row.opponent) : undefined;
  const existingStocksLeft = extractExistingStocksLeft(row);
  const resolved = resolveEnrichedMatchMembers({
    existingVodUrl: extractExistingVodUrl(row),
    enrichmentVodUrl: overlay.enrichedVodUrlByKey[key],
    ...(vodSource !== undefined ? { enrichmentVodSource: vodSource } : {}),
    providerStage: stageIsOwnProjection ? UNKNOWN_STAGE : storedStage,
    enrichmentStage: overlay.enrichedStageByKey[key],
    witness,
    enrichmentEvidenceConsulted: true,
    ...(gameEvidence !== undefined ? { enrichmentGameEvidence: gameEvidence } : {}),
    ...(rowOpponent !== undefined && rowOpponent !== 'unknown'
      ? { rowOpponentTag: rowOpponent }
      : {}),
    ...(typeof row.win === 'boolean' ? { rowWin: row.win } : {}),
    ...(existingStocksLeft !== undefined ? { existingStocksLeft } : {}),
  });
  if (
    stageIsOwnProjection &&
    resolved.stageOutcome === 'enriched' &&
    stagesEqual(resolved.stage, storedStage) &&
    resolved.witnessPatch.stagePreWrite.kind === 'none' &&
    resolved.witnessPatch.stageCommit.kind === 'none'
  ) {
    // An identical replay is reported as SETTLED ('provider-authoritative'),
    // never as a fresh 'enriched'. run.ts's resume-reconciliation TRIGGER no
    // longer depends on this label (it keys on the preview's value-derived
    // `wouldChangeRow` — the master half of the merged design), but the
    // relabel still matters for everything else that reads outcome labels:
    // the cohort restatement (`STAGE_OUTCOME_TO_COHORT`) and the dry-run/
    // apply `stageEnriched` counters see exactly the pre-fix healthy-set
    // labels, so a replay restates nothing as freshly enriched. The relabel
    // changes only the REPORTED outcome of a no-op row — the resolved
    // members and the (empty) witness patch are untouched, so unlike the
    // pre-fix behavior the witness survives.
    return { ...resolved, stageOutcome: 'provider-authoritative' };
  }
  return resolved;
}

function stagesEqual(left: MatchStage, right: MatchStage): boolean {
  return left.id === right.id && left.name === right.name;
}

/**
 * Picks, out of every attempt a transaction callback made, the one whose
 * resolved members match the transaction's COMMITTED snapshot — the attempt
 * that genuinely landed. Compares only the two members this module writes
 * (`vodUrl` and `map`) rather than the whole row, because RTDB normalises
 * unrelated members on write (empty arrays are dropped) and a whole-row
 * comparison would spuriously fail for reasons that have nothing to do with
 * ownership. Searches from the LAST attempt backwards, so when two attempts
 * happen to resolve to the same stored members the later (committing) one
 * wins. Returns `null` when the transaction did not commit, or when no
 * attempt explains the committed value (a foreign writer won) — both cases
 * mean this run wrote nothing it may claim ownership of.
 */
function selectCommittedResolution(
  committed: boolean,
  committedRow: Record<string, unknown> | null,
  attempts: EnrichedMatchMembersResult[],
): EnrichedMatchMembersResult | null {
  if (!committed || committedRow === null) {
    return null;
  }
  const storedVodUrl = extractExistingVodUrl(committedRow);
  const storedStage = extractExistingStage(committedRow);
  const storedStocksLeft = extractExistingStocksLeft(committedRow);
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    if (
      attempt.vodUrl === storedVodUrl &&
      stagesEqual(attempt.stage, storedStage) &&
      attempt.stocksLeft === storedStocksLeft
    ) {
      return attempt;
    }
  }
  return null;
}

/**
 * The resolution to record when NOTHING this run computed was committed:
 * every witness commit action becomes `none`, so phase C promotes no value
 * into the committed half. Paired with the PLAN-TIME pre-write action at the
 * phase C call site, `buildCommitPatch`'s pre-write-driven fallback branch
 * still clears the pending half — the invariant that a pending witness whose
 * fill did not commit is voided rather than left dangling.
 */
function voidedResolution(planTime: EnrichedMatchMembersResult): EnrichedMatchMembersResult {
  return {
    vodOutcome: 'unchanged',
    stage: planTime.stage,
    // A provider-resolved stage needed no write at all, so its outcome is
    // unaffected by a failed commit; anything else did not get enriched.
    stageOutcome:
      planTime.stageOutcome === 'provider-authoritative' ? planTime.stageOutcome : 'unknown',
    // The evidence halves of an uncommitted transaction claim nothing: no
    // chars/stocks outcome is reported enriched, and no witness commit
    // promotes a value the row never received.
    stocksOutcome: 'none',
    charsOutcome: 'none',
    witnessPatch: {
      vodPreWrite: { kind: 'none' },
      vodCommit: { kind: 'none' },
      stagePreWrite: { kind: 'none' },
      stageCommit: { kind: 'none' },
      charsCommit: { kind: 'none' },
      stocksPreWrite: { kind: 'none' },
      stocksCommit: { kind: 'none' },
    },
  };
}

/** Builds the phase A (pending-half) witness patch fragment for one key, or `{}` when nothing needs pre-writing. */
function buildPreWritePatch(
  witnessBasePath: string,
  vodPreWrite: EnrichmentVodWitnessPreWriteAction,
  stagePreWrite: EnrichmentStageWitnessPreWriteAction,
  stocksPreWrite: EnrichmentStocksWitnessPreWriteAction,
  targetSetId: string,
  matchKey: string,
  nowMs: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  let touched = false;

  if (stocksPreWrite.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/pendingStocksLeft`] = stocksPreWrite.write.stocksLeft;
    patch[`${witnessBasePath}/pendingStocksObservationId`] =
      stocksPreWrite.write.observationId ?? null;
  }

  if (vodPreWrite.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = vodPreWrite.write.url;
    patch[`${witnessBasePath}/pendingVodObservationId`] = vodPreWrite.write.observationId ?? null;
    patch[`${witnessBasePath}/pendingVodCandidateId`] = vodPreWrite.write.candidateId ?? null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] =
      vodPreWrite.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodPreWrite.kind === 'mark-removal') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodRemoval`] = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodCandidateId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
  }

  if (stagePreWrite.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/pendingStageId`] = stagePreWrite.write.stageId;
    patch[`${witnessBasePath}/pendingStageName`] = stagePreWrite.write.stageName;
    patch[`${witnessBasePath}/pendingStageRaw`] = stagePreWrite.write.raw ?? null;
    patch[`${witnessBasePath}/pendingStageForm`] = stagePreWrite.write.form ?? null;
    patch[`${witnessBasePath}/pendingStageObservationId`] =
      stagePreWrite.write.observationId ?? null;
  } else if (stagePreWrite.kind === 'set-raw-only') {
    touched = true;
    patch[`${witnessBasePath}/pendingStageRaw`] = stagePreWrite.write.raw ?? null;
    patch[`${witnessBasePath}/pendingStageForm`] = stagePreWrite.write.form ?? null;
    patch[`${witnessBasePath}/pendingStageObservationId`] =
      stagePreWrite.write.observationId ?? null;
    patch[`${witnessBasePath}/pendingStageId`] = null;
    patch[`${witnessBasePath}/pendingStageName`] = null;
  }

  if (touched) {
    patch[`${witnessBasePath}/matchKey`] = matchKey;
    patch[`${witnessBasePath}/targetSetId`] = targetSetId;
    patch[`${witnessBasePath}/pendingWriteStartedAtMs`] = nowMs;
  }

  return patch;
}

/** Builds the phase C (commit) witness patch fragment for one key. Always clears the pending half when a pre-write happened this run, even when the eventual commit action is `none`, so a pending member never lingers. */
function buildCommitPatch(
  witnessBasePath: string,
  vodCommit: EnrichmentVodWitnessCommitAction,
  vodPreWrite: EnrichmentVodWitnessPreWriteAction,
  stageCommit: EnrichmentStageWitnessCommitAction,
  stagePreWrite: EnrichmentStageWitnessPreWriteAction,
  charsCommit: EnrichmentCharsWitnessCommitAction,
  stocksCommit: EnrichmentStocksWitnessCommitAction,
  stocksPreWrite: EnrichmentStocksWitnessPreWriteAction,
  targetSetId: string,
  matchKey: string,
  nowMs: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  let touched = false;

  if (charsCommit.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/projectedSubjectSeat`] = charsCommit.write.subjectSeat;
    patch[`${witnessBasePath}/projectedSubjectCharRaw`] = charsCommit.write.subjectCharRaw ?? null;
    patch[`${witnessBasePath}/projectedSubjectFighterId`] =
      charsCommit.write.subjectFighterId ?? null;
    patch[`${witnessBasePath}/projectedOpponentCharRaw`] =
      charsCommit.write.opponentCharRaw ?? null;
    patch[`${witnessBasePath}/projectedOpponentFighterId`] =
      charsCommit.write.opponentFighterId ?? null;
    patch[`${witnessBasePath}/charsObservationId`] = charsCommit.write.observationId;
    patch[`${witnessBasePath}/charsSourceRevisionId`] = charsCommit.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/charsParserVersion`] = charsCommit.write.parserVersion ?? null;
    patch[`${witnessBasePath}/charsProjectedAtMs`] = nowMs;
  } else if (charsCommit.kind === 'clear') {
    touched = true;
    patch[`${witnessBasePath}/projectedSubjectSeat`] = null;
    patch[`${witnessBasePath}/projectedSubjectCharRaw`] = null;
    patch[`${witnessBasePath}/projectedSubjectFighterId`] = null;
    patch[`${witnessBasePath}/projectedOpponentCharRaw`] = null;
    patch[`${witnessBasePath}/projectedOpponentFighterId`] = null;
    patch[`${witnessBasePath}/charsObservationId`] = null;
    patch[`${witnessBasePath}/charsSourceRevisionId`] = null;
    patch[`${witnessBasePath}/charsParserVersion`] = null;
    patch[`${witnessBasePath}/charsProjectedAtMs`] = null;
  }

  if (stocksCommit.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/projectedStocksLeft`] = stocksCommit.write.stocksLeft;
    patch[`${witnessBasePath}/stocksObservationId`] = stocksCommit.write.observationId;
    patch[`${witnessBasePath}/stocksSourceRevisionId`] =
      stocksCommit.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/stocksParserVersion`] = stocksCommit.write.parserVersion ?? null;
    patch[`${witnessBasePath}/stocksProjectedAtMs`] = nowMs;
    patch[`${witnessBasePath}/pendingStocksLeft`] = null;
    patch[`${witnessBasePath}/pendingStocksObservationId`] = null;
  } else if (stocksCommit.kind === 'clear') {
    touched = true;
    patch[`${witnessBasePath}/projectedStocksLeft`] = null;
    patch[`${witnessBasePath}/stocksObservationId`] = null;
    patch[`${witnessBasePath}/stocksSourceRevisionId`] = null;
    patch[`${witnessBasePath}/stocksParserVersion`] = null;
    patch[`${witnessBasePath}/stocksProjectedAtMs`] = null;
    patch[`${witnessBasePath}/pendingStocksLeft`] = null;
    patch[`${witnessBasePath}/pendingStocksObservationId`] = null;
  } else if (stocksPreWrite.kind !== 'none') {
    touched = true;
    patch[`${witnessBasePath}/pendingStocksLeft`] = null;
    patch[`${witnessBasePath}/pendingStocksObservationId`] = null;
  }

  if (vodCommit.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/projectedVodUrl`] = vodCommit.write.url;
    patch[`${witnessBasePath}/vodObservationId`] = vodCommit.write.observationId ?? null;
    patch[`${witnessBasePath}/vodCandidateId`] = vodCommit.write.candidateId ?? null;
    patch[`${witnessBasePath}/vodSourceRevisionId`] = vodCommit.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/vodParserVersion`] = vodCommit.write.parserVersion ?? null;
    patch[`${witnessBasePath}/vodProjectedAtMs`] = nowMs;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodCandidateId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodCommit.kind === 'clear') {
    touched = true;
    patch[`${witnessBasePath}/projectedVodUrl`] = null;
    patch[`${witnessBasePath}/vodObservationId`] = null;
    patch[`${witnessBasePath}/vodCandidateId`] = null;
    patch[`${witnessBasePath}/vodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/vodParserVersion`] = null;
    if (vodCommit.released) {
      patch[`${witnessBasePath}/vodOwnershipReleasedAtMs`] = nowMs;
    }
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodCandidateId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodPreWrite.kind !== 'none') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodCandidateId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  }

  if (stageCommit.kind === 'set' || stageCommit.kind === 'set-raw-only') {
    touched = true;
    if (stageCommit.kind === 'set') {
      patch[`${witnessBasePath}/projectedStageId`] = stageCommit.write.stageId;
      patch[`${witnessBasePath}/projectedStageName`] = stageCommit.write.stageName;
    } else {
      // A raw-only commit means the CURRENT source state has no canonical
      // mapping — a stale canonical claim from an earlier revision must not
      // survive alongside the new raw text, or the witness would vouch for
      // a stage the source no longer states (30.3 Gate 5 commit 1).
      patch[`${witnessBasePath}/projectedStageId`] = null;
      patch[`${witnessBasePath}/projectedStageName`] = null;
    }
    patch[`${witnessBasePath}/projectedStageRaw`] = stageCommit.write.raw ?? null;
    patch[`${witnessBasePath}/projectedStageForm`] = stageCommit.write.form ?? null;
    patch[`${witnessBasePath}/stageObservationId`] = stageCommit.write.observationId ?? null;
    patch[`${witnessBasePath}/stageSourceRevisionId`] = stageCommit.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/stageParserVersion`] = stageCommit.write.parserVersion ?? null;
    patch[`${witnessBasePath}/stageProjectedAtMs`] = nowMs;
    patch[`${witnessBasePath}/pendingStageId`] = null;
    patch[`${witnessBasePath}/pendingStageName`] = null;
    patch[`${witnessBasePath}/pendingStageRaw`] = null;
    patch[`${witnessBasePath}/pendingStageForm`] = null;
    patch[`${witnessBasePath}/pendingStageObservationId`] = null;
  } else if (stageCommit.kind === 'clear') {
    touched = true;
    patch[`${witnessBasePath}/projectedStageId`] = null;
    patch[`${witnessBasePath}/projectedStageName`] = null;
    patch[`${witnessBasePath}/projectedStageRaw`] = null;
    patch[`${witnessBasePath}/projectedStageForm`] = null;
    patch[`${witnessBasePath}/stageObservationId`] = null;
    patch[`${witnessBasePath}/stageSourceRevisionId`] = null;
    patch[`${witnessBasePath}/stageParserVersion`] = null;
    patch[`${witnessBasePath}/pendingStageId`] = null;
    patch[`${witnessBasePath}/pendingStageName`] = null;
    patch[`${witnessBasePath}/pendingStageRaw`] = null;
    patch[`${witnessBasePath}/pendingStageForm`] = null;
    patch[`${witnessBasePath}/pendingStageObservationId`] = null;
  } else if (stagePreWrite.kind !== 'none') {
    touched = true;
    patch[`${witnessBasePath}/pendingStageId`] = null;
    patch[`${witnessBasePath}/pendingStageName`] = null;
    patch[`${witnessBasePath}/pendingStageRaw`] = null;
    patch[`${witnessBasePath}/pendingStageForm`] = null;
    patch[`${witnessBasePath}/pendingStageObservationId`] = null;
  }

  if (touched) {
    patch[`${witnessBasePath}/matchKey`] = matchKey;
    patch[`${witnessBasePath}/targetSetId`] = targetSetId;
  }

  return patch;
}

/**
 * Applies an overlay to the match rows it names, through the three-phase
 * protocol documented at the top of this module. `targetSetId` is stamped
 * onto every witness record this run touches.
 */
export async function applyEnrichmentProjection(
  database: Database,
  tenantId: string,
  targetSetId: string,
  overlay: EnrichmentOverlay,
  nowMs: number,
): Promise<EnrichmentProjectionOutcome> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return emptyOutcome();
  }

  // The priority-5 merge (see widenOverlayWithConfirmedCandidate): every
  // apply — whichever caller built the overlay — sees the set's confirmed
  // YouTube candidate, so an observation-only overlay can never misread a
  // candidate-projected URL as source-removed.
  overlay = await widenOverlayWithConfirmedCandidate(database, tenantId, targetSetId, overlay);

  // A key the CURRENT overlay no longer mentions but a PRIOR run left a VOD
  // witness claim for — the "source stopped supplying a value" removal case
  // (behavior list item 5) — is invisible to the overlay maps alone (an
  // absent overlay entry looks identical to "never enriched"). Widen the
  // candidate set with any key this tenant's witness tree already
  // attributes to THIS target set, so a removal is discovered rather than
  // silently ignored.
  //
  // ACCEPTED RISK — WHOLE-WITNESS-TREE READ PER TARGET SET (Codex
  // checkpoint-3 risk, accepted for this phase). This reads the tenant's
  // ENTIRE `researchEnrichmentProjection` subtree and filters it in memory
  // by `targetSetId`, once per target set applied. The read is bounded and
  // cheap at the scale this phase actually serves — the four demo research
  // accounts and wave 9's target list — where the whole subtree is small
  // and the per-set filter costs less than the round trips an index would
  // add. It is NOT bounded by the number of sets being applied: cost grows
  // as (sets applied x tenant witness count), so a tenant with a large
  // witness tree processed set-by-set degrades quadratically.
  //
  // The named follow-up, before any larger-scale use: a TARGET-SET INDEX
  // (`researchEnrichmentProjectionByTargetSet/{tenantId}/{targetSetId}/{matchKey}`,
  // maintained by the same phase A/C witness patches that already stamp
  // `targetSetId` here) so this becomes a single scoped read. Do not widen
  // this module past the four-account scale without it.
  const witnessSnapshotForSet = await database
    .ref(`researchEnrichmentProjection/${tenantId}`)
    .get();
  const previouslyWitnessedKeys: string[] = [];
  if (witnessSnapshotForSet.exists()) {
    const raw = witnessSnapshotForSet.val() as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      const parsed = readWitnessFromValue(value);
      if (parsed && parsed.targetSetId === targetSetId && witnessCarriesAnyClaim(parsed)) {
        previouslyWitnessedKeys.push(key);
      }
    }
  }

  const touchedKeys = Array.from(
    new Set([
      ...Object.keys(overlay.enrichedVodUrlByKey),
      ...Object.keys(overlay.enrichedStageByKey),
      ...Object.keys(overlay.enrichedGameEvidenceByKey ?? {}),
      ...previouslyWitnessedKeys,
    ]),
  ).filter((key) => isPathSafeProviderId(key));

  if (touchedKeys.length === 0) {
    return emptyOutcome();
  }

  const outcome = emptyOutcome();

  // Planning pass: one read of the row and one read of the witness per key,
  // deciding existence and the PLANNED outcome up front. The plan drives
  // phase A's pending pre-write only — phase B re-resolves against the row
  // RTDB holds at commit time (see WRITE-TIME OWNERSHIP RESOLUTION above).
  interface PlannedRow {
    key: string;
    cachedRow: Record<string, unknown>;
    witness: EnrichmentOwnershipWitness | null;
    planned: EnrichedMatchMembersResult;
    /** The resolution the phase B transaction actually COMMITTED. */
    applied: EnrichedMatchMembersResult;
  }
  const planned: PlannedRow[] = [];

  for (const key of touchedKeys) {
    const rowSnapshot = await database.ref(`matches/${tenantId}/${key}`).get();
    if (!rowSnapshot.exists()) {
      outcome.counts.attachedNoProjectableRows += 1;
      continue;
    }
    const row = rowSnapshot.val() as Record<string, unknown>;

    const witnessSnapshot = await database
      .ref(`researchEnrichmentProjection/${tenantId}/${key}`)
      .get();
    const witness = readWitnessFromValue(witnessSnapshot.exists() ? witnessSnapshot.val() : null);

    const planTimeResult = resolveForRow(overlay, key, row, witness);

    planned.push({
      key,
      cachedRow: row,
      witness,
      planned: planTimeResult,
      // Replaced in phase B; the plan-time value is only a placeholder that
      // keeps the record total for TypeScript.
      applied: planTimeResult,
    });
  }

  if (planned.length === 0) {
    return outcome;
  }

  // Phase A — witness PRE-WRITE (one multi-path update), from the PLAN.
  const preWritePatch: Record<string, unknown> = {};
  for (const { key, planned: planTimeResult } of planned) {
    Object.assign(
      preWritePatch,
      buildPreWritePatch(
        `researchEnrichmentProjection/${tenantId}/${key}`,
        planTimeResult.witnessPatch.vodPreWrite,
        planTimeResult.witnessPatch.stagePreWrite,
        planTimeResult.witnessPatch.stocksPreWrite,
        targetSetId,
        key,
        nowMs,
      ),
    );
  }
  if (Object.keys(preWritePatch).length > 0) {
    await database.ref().update(preWritePatch);
  }

  // Phase B — per-row transactions, each RE-RESOLVING against the row RTDB
  // holds at commit time.
  for (const plan of planned) {
    const attempts: EnrichedMatchMembersResult[] = [];
    const transactionResult = await database
      .ref(`matches/${tenantId}/${plan.key}`)
      .transaction((current) => {
        const effective = (current ?? plan.cachedRow) as Record<string, unknown>;
        const live = resolveForRow(overlay, plan.key, effective, plan.witness);
        // APPEND, never assign: a retried callback must not be able to
        // overwrite the record of an earlier attempt, because which attempt
        // committed is decided below from the committed snapshot.
        attempts.push(live);
        /* eslint-disable @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `vodUrl`/`map`/`stocksLeft` are intentionally discarded (replaced below) */
        const {
          vodUrl: _ignoredVodUrl,
          map: _ignoredMap,
          stocksLeft: _ignoredStocks,
          ...rest
        } = effective;
        /* eslint-enable @typescript-eslint/no-unused-vars */
        return {
          ...rest,
          map: live.stage,
          ...(live.vodUrl !== undefined ? { vodUrl: live.vodUrl } : {}),
          ...(live.stocksLeft !== undefined ? { stocksLeft: live.stocksLeft } : {}),
        };
      });

    const committedRow = transactionResult.snapshot.exists()
      ? (transactionResult.snapshot.val() as Record<string, unknown>)
      : null;
    plan.applied =
      selectCommittedResolution(transactionResult.committed, committedRow, attempts) ??
      voidedResolution(plan.planned);

    const applied = plan.applied;
    outcome.rows.push(toRowOutcome(plan.key, applied));
    tallyResolvedRow(outcome, applied);
  }

  // Phase C — witness COMMIT (one multi-path update). The COMMIT action
  // comes from what phase B actually committed; the PRE-WRITE action comes
  // from the plan, because that is what phase A wrote and therefore what
  // needs clearing.
  const commitPatch: Record<string, unknown> = {};
  for (const { key, planned: planTimeResult, applied } of planned) {
    Object.assign(
      commitPatch,
      buildCommitPatch(
        `researchEnrichmentProjection/${tenantId}/${key}`,
        applied.witnessPatch.vodCommit,
        planTimeResult.witnessPatch.vodPreWrite,
        applied.witnessPatch.stageCommit,
        planTimeResult.witnessPatch.stagePreWrite,
        applied.witnessPatch.charsCommit,
        applied.witnessPatch.stocksCommit,
        planTimeResult.witnessPatch.stocksPreWrite,
        targetSetId,
        key,
        nowMs,
      ),
    );
  }
  if (Object.keys(commitPatch).length > 0) {
    await database.ref().update(commitPatch);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Overlay readers — the READ side the ingestion refresh needs (task 3)
// ---------------------------------------------------------------------------

export interface EnrichmentRowOverlay {
  enrichmentVodUrl?: string;
  /** The VOD's OWN provenance — never the stage observation's (BLOCKER 2). */
  enrichmentVodSource?: EnrichmentVodSourceInput;
  enrichmentStage?: EnrichedStage;
  /** 30.3 Gate 5 — carried for completeness; the ingestion merge deliberately ignores it (character/stock evidence acts only through the applier's consulted path). */
  enrichmentGameEvidence?: EnrichedGameEvidence;
  witness: EnrichmentOwnershipWitness | null;
}

export type EnrichmentOverlayForSet = Record<string, EnrichmentRowOverlay>;

async function readWitness(
  database: Database,
  tenantId: string,
  key: string,
): Promise<EnrichmentOwnershipWitness | null> {
  const snapshot = await database.ref(`researchEnrichmentProjection/${tenantId}/${key}`).get();
  return readWitnessFromValue(snapshot.exists() ? snapshot.val() : null);
}

function toRowOverlay(
  key: string,
  overlay: EnrichmentOverlay,
  witness: EnrichmentOwnershipWitness | null,
): EnrichmentRowOverlay {
  const {
    enrichedVodUrlByKey,
    enrichedVodSourceByKey,
    enrichedStageByKey,
    enrichedGameEvidenceByKey,
  } = overlay;
  return {
    ...(enrichedVodUrlByKey[key] !== undefined
      ? { enrichmentVodUrl: enrichedVodUrlByKey[key] }
      : {}),
    ...(enrichedVodSourceByKey?.[key] !== undefined
      ? { enrichmentVodSource: enrichedVodSourceByKey[key] }
      : {}),
    ...(enrichedStageByKey[key] !== undefined ? { enrichmentStage: enrichedStageByKey[key] } : {}),
    ...(enrichedGameEvidenceByKey?.[key] !== undefined
      ? { enrichmentGameEvidence: enrichedGameEvidenceByKey[key] }
      : {}),
    witness,
  };
}

/**
 * Composes stored attachments, their observations, and the stored witness
 * into the same per-row overlay shape `buildEnrichmentOverlay` produces.
 * Returns `{}` (not `null`) when this SPECIFIC target set has no
 * attachments — a normal, common state. `null` is reserved for
 * `readEnrichmentOverlayForTenant`'s tenant-wide "no enrichment tree at
 * all" signal below.
 */
export async function readEnrichmentOverlayForSet(
  database: Database,
  tenantId: string,
  storageKey: string,
): Promise<EnrichmentOverlayForSet | null> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(storageKey)) {
    return null;
  }

  const attachments = await listAttachmentsForSet(database, tenantId, storageKey);
  if (attachments.length === 0) {
    return {};
  }

  const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {};
  for (const attachment of attachments) {
    const record = await readEnrichmentObservation(database, tenantId, attachment.observationId);
    if (record) {
      observationsById[attachment.observationId] = record;
    }
  }

  const setOverlay = buildEnrichmentOverlay({
    targetSetId: storageKey,
    attachments,
    observations: observationsById,
  });

  const keys = new Set([
    ...Object.keys(setOverlay.enrichedVodUrlByKey),
    ...Object.keys(setOverlay.enrichedStageByKey),
    ...Object.keys(setOverlay.enrichedGameEvidenceByKey ?? {}),
  ]);
  const result: EnrichmentOverlayForSet = {};
  for (const key of keys) {
    if (!isPathSafeProviderId(key)) {
      continue;
    }
    const witness = await readWitness(database, tenantId, key);
    result[key] = toRowOverlay(key, setOverlay, witness);
  }
  return result;
}

interface AttachedTargetSet {
  targetSetId: string;
  attachments: ResearchEnrichmentAttachmentRecord[];
}

/** One read of the whole tenant attachment tree (`nested-two-level` shape), mirroring `store.ts`'s `collectAttachedObservationIds`. */
async function listAllAttachedTargetSets(
  database: Database,
  tenantId: string,
): Promise<AttachedTargetSet[] | null> {
  const snapshot = await database.ref(`researchEnrichmentAttachments/${tenantId}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const result: AttachedTargetSet[] = [];
  for (const [targetSetId, children] of Object.entries(raw)) {
    if (children === null || typeof children !== 'object') {
      continue;
    }
    const attachments: ResearchEnrichmentAttachmentRecord[] = [];
    for (const value of Object.values(children)) {
      const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(value);
      if (parsed.success) {
        attachments.push(parsed.data);
      }
    }
    if (attachments.length > 0) {
      result.push({ targetSetId, attachments });
    }
  }
  return result;
}

/**
 * Reads the ENTIRE tenant's enrichment overlay in ONE function call — the
 * production batch executor (task 3) calls this exactly ONCE per batch
 * invocation, never once per set, because the overlay is a bounded
 * per-tenant read and a per-set read would multiply RTDB round trips by the
 * batch size for no additional correctness.
 *
 * Returns `null` — not an empty `Map` — when the tenant has NO enrichment
 * tree at all (`researchEnrichmentAttachments/{tenantId}` absent), so the
 * caller can pass `undefined` for the ingestion projection's overlay
 * parameter and reduce to exactly today's behaviour.
 */
export async function readEnrichmentOverlayForTenant(
  database: Database,
  tenantId: string,
): Promise<Map<string, EnrichmentRowOverlay> | null> {
  if (!isPathSafeTenantId(tenantId)) {
    return null;
  }

  const grouped = await listAllAttachedTargetSets(database, tenantId);
  if (grouped === null) {
    return null;
  }

  // Read exactly the OBSERVATIONS THAT ATTACHMENTS NAME — never the whole
  // tenant observation tree — so an unattached observation stays invisible
  // here too, mirroring `buildEnrichmentOverlay`'s own contract.
  const observationIds = new Set<string>();
  for (const { attachments } of grouped) {
    for (const attachment of attachments) {
      observationIds.add(attachment.observationId);
    }
  }
  const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {};
  for (const observationId of observationIds) {
    const record = await readEnrichmentObservation(database, tenantId, observationId);
    if (record) {
      observationsById[observationId] = record;
    }
  }

  const witnessSnapshot = await database.ref(`researchEnrichmentProjection/${tenantId}`).get();
  const witnessByKey: Record<string, EnrichmentOwnershipWitness> = {};
  if (witnessSnapshot.exists()) {
    const raw = witnessSnapshot.val() as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      const parsed = readWitnessFromValue(value);
      if (parsed) {
        witnessByKey[key] = parsed;
      }
    }
  }

  const result = new Map<string, EnrichmentRowOverlay>();
  for (const { targetSetId, attachments } of grouped) {
    if (!isPathSafeProviderId(targetSetId)) {
      continue;
    }
    const setOverlay = buildEnrichmentOverlay({
      targetSetId,
      attachments,
      observations: observationsById,
    });
    const keys = new Set([
      ...Object.keys(setOverlay.enrichedVodUrlByKey),
      ...Object.keys(setOverlay.enrichedStageByKey),
      ...Object.keys(setOverlay.enrichedGameEvidenceByKey ?? {}),
    ]);
    for (const key of keys) {
      if (!isPathSafeProviderId(key)) {
        continue;
      }
      result.set(key, toRowOverlay(key, setOverlay, witnessByKey[key] ?? null));
    }
  }
  return result;
}
