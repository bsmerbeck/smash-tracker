import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentProjectionStateRecordSchema,
  resolveEnrichedMatchMembers,
  UNKNOWN_STAGE,
  type EnrichmentOwnershipWitness,
  type EnrichmentStageWitnessCommitAction,
  type EnrichmentStageWitnessPreWriteAction,
  type EnrichmentVodOutcome,
  type EnrichmentStageOutcome,
  type EnrichmentVodWitnessCommitAction,
  type EnrichmentVodWitnessPreWriteAction,
  type MatchStage,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentObservationRecord,
  type ResearchEnrichmentProjectionStateRecord,
  type ResearchLiquipediaStageForm,
} from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../subjectKind.js';
import { listAttachmentsForSet, readEnrichmentObservation } from './store.js';

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

export interface EnrichmentOverlay {
  enrichedVodUrlByKey: Record<string, string>;
  enrichedStageByKey: Record<string, EnrichedStage>;
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
  const enrichedStageByKey: Record<string, EnrichedStage> = {};

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
        enrichedVodUrlByKey[deriveEnrichmentMatchRowKey(input.targetSetId, ordinal)] =
          record.vodUrl;
      }
    }

    for (const game of games) {
      if (game.canonicalStageId == null && game.rawStage == null) {
        continue;
      }
      enrichedStageByKey[deriveEnrichmentMatchRowKey(input.targetSetId, game.ordinal)] = {
        ...(game.rawStage != null ? { raw: game.rawStage } : {}),
        ...(game.stageForm != null ? { form: game.stageForm } : {}),
        ...(game.canonicalStageId != null ? { canonicalStageId: game.canonicalStageId } : {}),
        observationId: record.observationId,
        sourceRevisionId: record.sourceRevisionId,
        parserVersion: record.parserVersion,
      };
    }
  }

  return { enrichedVodUrlByKey, enrichedStageByKey };
}

// ---------------------------------------------------------------------------
// Apply — the crash-safe two-phase (three-write) applier
// ---------------------------------------------------------------------------

export interface EnrichmentProjectionRowOutcome {
  matchKey: string;
  vodOutcome: EnrichmentVodOutcome;
  stageOutcome: EnrichmentStageOutcome;
}

export interface EnrichmentProjectionCounts {
  stageEnriched: number;
  vodFilledEmpty: number;
  vodSkippedUserOwned: number;
  unknownStageAfterEnrichment: number;
  attachedNoProjectableRows: number;
}

export interface EnrichmentProjectionOutcome {
  rows: EnrichmentProjectionRowOutcome[];
  counts: EnrichmentProjectionCounts;
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
  };
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

/** Builds the phase A (pending-half) witness patch fragment for one key, or `{}` when nothing needs pre-writing. */
function buildPreWritePatch(
  witnessBasePath: string,
  vodPreWrite: EnrichmentVodWitnessPreWriteAction,
  stagePreWrite: EnrichmentStageWitnessPreWriteAction,
  targetSetId: string,
  matchKey: string,
  nowMs: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  let touched = false;

  if (vodPreWrite.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = vodPreWrite.write.url;
    patch[`${witnessBasePath}/pendingVodObservationId`] = vodPreWrite.write.observationId ?? null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] =
      vodPreWrite.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodPreWrite.kind === 'mark-removal') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodRemoval`] = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
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
  targetSetId: string,
  matchKey: string,
  nowMs: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  let touched = false;

  if (vodCommit.kind === 'set') {
    touched = true;
    patch[`${witnessBasePath}/projectedVodUrl`] = vodCommit.write.url;
    patch[`${witnessBasePath}/vodObservationId`] = vodCommit.write.observationId ?? null;
    patch[`${witnessBasePath}/vodSourceRevisionId`] = vodCommit.write.sourceRevisionId ?? null;
    patch[`${witnessBasePath}/vodParserVersion`] = vodCommit.write.parserVersion ?? null;
    patch[`${witnessBasePath}/vodProjectedAtMs`] = nowMs;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodCommit.kind === 'clear') {
    touched = true;
    patch[`${witnessBasePath}/projectedVodUrl`] = null;
    patch[`${witnessBasePath}/vodObservationId`] = null;
    patch[`${witnessBasePath}/vodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/vodParserVersion`] = null;
    if (vodCommit.released) {
      patch[`${witnessBasePath}/vodOwnershipReleasedAtMs`] = nowMs;
    }
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  } else if (vodPreWrite.kind !== 'none') {
    touched = true;
    patch[`${witnessBasePath}/pendingVodUrl`] = null;
    patch[`${witnessBasePath}/pendingVodObservationId`] = null;
    patch[`${witnessBasePath}/pendingVodSourceRevisionId`] = null;
    patch[`${witnessBasePath}/pendingVodRemoval`] = null;
  }

  if (stageCommit.kind === 'set' || stageCommit.kind === 'set-raw-only') {
    touched = true;
    if (stageCommit.kind === 'set') {
      patch[`${witnessBasePath}/projectedStageId`] = stageCommit.write.stageId;
      patch[`${witnessBasePath}/projectedStageName`] = stageCommit.write.stageName;
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

  // A key the CURRENT overlay no longer mentions but a PRIOR run left a VOD
  // witness claim for — the "source stopped supplying a value" removal case
  // (behavior list item 5) — is invisible to the overlay maps alone (an
  // absent overlay entry looks identical to "never enriched"). Widen the
  // candidate set with any key this tenant's witness tree already
  // attributes to THIS target set, so a removal is discovered rather than
  // silently ignored.
  const witnessSnapshotForSet = await database
    .ref(`researchEnrichmentProjection/${tenantId}`)
    .get();
  const previouslyWitnessedKeys: string[] = [];
  if (witnessSnapshotForSet.exists()) {
    const raw = witnessSnapshotForSet.val() as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      const parsed = readWitnessFromValue(value);
      if (
        parsed &&
        parsed.targetSetId === targetSetId &&
        (parsed.projectedVodUrl != null || parsed.pendingVodUrl != null)
      ) {
        previouslyWitnessedKeys.push(key);
      }
    }
  }

  const touchedKeys = Array.from(
    new Set([
      ...Object.keys(overlay.enrichedVodUrlByKey),
      ...Object.keys(overlay.enrichedStageByKey),
      ...previouslyWitnessedKeys,
    ]),
  ).filter((key) => isPathSafeProviderId(key));

  if (touchedKeys.length === 0) {
    return emptyOutcome();
  }

  const outcome = emptyOutcome();

  // Planning pass: one read of the row and one read of the witness per key,
  // deciding existence and the resolved outcome up front.
  interface PlannedRow {
    key: string;
    cachedRow: Record<string, unknown>;
    result: ReturnType<typeof resolveEnrichedMatchMembers>;
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

    const result = resolveEnrichedMatchMembers({
      existingVodUrl: extractExistingVodUrl(row),
      enrichmentVodUrl: overlay.enrichedVodUrlByKey[key],
      providerStage: extractExistingStage(row),
      enrichmentStage: overlay.enrichedStageByKey[key],
      witness,
    });

    planned.push({ key, cachedRow: row, result });
  }

  if (planned.length === 0) {
    return outcome;
  }

  // Phase A — witness PRE-WRITE (one multi-path update).
  const preWritePatch: Record<string, unknown> = {};
  for (const { key, result } of planned) {
    Object.assign(
      preWritePatch,
      buildPreWritePatch(
        `researchEnrichmentProjection/${tenantId}/${key}`,
        result.witnessPatch.vodPreWrite,
        result.witnessPatch.stagePreWrite,
        targetSetId,
        key,
        nowMs,
      ),
    );
  }
  if (Object.keys(preWritePatch).length > 0) {
    await database.ref().update(preWritePatch);
  }

  // Phase B — per-row transactions.
  for (const { key, cachedRow, result } of planned) {
    await database.ref(`matches/${tenantId}/${key}`).transaction((current) => {
      const effective = (current ?? cachedRow) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `vodUrl`/`map` are intentionally discarded (replaced below)
      const { vodUrl: _ignoredVodUrl, map: _ignoredMap, ...rest } = effective;
      return {
        ...rest,
        map: result.stage,
        ...(result.vodUrl !== undefined ? { vodUrl: result.vodUrl } : {}),
      };
    });

    outcome.rows.push({
      matchKey: key,
      vodOutcome: result.vodOutcome,
      stageOutcome: result.stageOutcome,
    });
    if (result.vodOutcome === 'filled-empty') {
      outcome.counts.vodFilledEmpty += 1;
    }
    if (result.vodOutcome === 'skipped-user-owned') {
      outcome.counts.vodSkippedUserOwned += 1;
    }
    if (result.stageOutcome === 'enriched') {
      outcome.counts.stageEnriched += 1;
    }
    if (result.stageOutcome === 'unknown') {
      outcome.counts.unknownStageAfterEnrichment += 1;
    }
  }

  // Phase C — witness COMMIT (one multi-path update).
  const commitPatch: Record<string, unknown> = {};
  for (const { key, result } of planned) {
    Object.assign(
      commitPatch,
      buildCommitPatch(
        `researchEnrichmentProjection/${tenantId}/${key}`,
        result.witnessPatch.vodCommit,
        result.witnessPatch.vodPreWrite,
        result.witnessPatch.stageCommit,
        result.witnessPatch.stagePreWrite,
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
  enrichmentStage?: EnrichedStage;
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
  enrichedVodUrlByKey: Record<string, string>,
  enrichedStageByKey: Record<string, EnrichedStage>,
  witness: EnrichmentOwnershipWitness | null,
): EnrichmentRowOverlay {
  return {
    ...(enrichedVodUrlByKey[key] !== undefined
      ? { enrichmentVodUrl: enrichedVodUrlByKey[key] }
      : {}),
    ...(enrichedStageByKey[key] !== undefined ? { enrichmentStage: enrichedStageByKey[key] } : {}),
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

  const { enrichedVodUrlByKey, enrichedStageByKey } = buildEnrichmentOverlay({
    targetSetId: storageKey,
    attachments,
    observations: observationsById,
  });

  const keys = new Set([...Object.keys(enrichedVodUrlByKey), ...Object.keys(enrichedStageByKey)]);
  const result: EnrichmentOverlayForSet = {};
  for (const key of keys) {
    if (!isPathSafeProviderId(key)) {
      continue;
    }
    const witness = await readWitness(database, tenantId, key);
    result[key] = toRowOverlay(key, enrichedVodUrlByKey, enrichedStageByKey, witness);
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
    const { enrichedVodUrlByKey, enrichedStageByKey } = buildEnrichmentOverlay({
      targetSetId,
      attachments,
      observations: observationsById,
    });
    const keys = new Set([...Object.keys(enrichedVodUrlByKey), ...Object.keys(enrichedStageByKey)]);
    for (const key of keys) {
      if (!isPathSafeProviderId(key)) {
        continue;
      }
      result.set(
        key,
        toRowOverlay(key, enrichedVodUrlByKey, enrichedStageByKey, witnessByKey[key] ?? null),
      );
    }
  }
  return result;
}
