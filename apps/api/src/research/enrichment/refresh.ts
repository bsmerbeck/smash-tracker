import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import {
  isLiquipediaPageFresh,
  type LiquipediaPageCacheRecord,
} from '../../liquipedia/revisionCache.js';
import { isVodRowCountPlausible } from '../../liquipedia/adapters/vodList.js';
import { isPathSafeTenantId } from '../subjectKind.js';
import {
  deleteEnrichmentAttachment,
  listAttachmentsForSet,
  listEnrichmentObservations,
  readEnrichmentObservation,
  writeEnrichmentObservation,
} from './store.js';
import { applyEnrichmentProjection, buildEnrichmentOverlay } from './projection.js';
import { prepareAndValidateObservation } from './prepareObservation.js';

/**
 * Phase 30.2 Plan 09 (ENR-10, cycle-1 review MEDIUM 8): refresh and
 * correction semantics with a shrink guard — the module that makes "unchanged
 * inputs are a proven no-op" and "a shrinking source is held for review, not
 * trusted" both TRUE properties, not conventions.
 *
 * `planPageRefresh` is a PURE decision: no I/O, no clock beyond a caller-
 * supplied `nowMs` where relevant, no database access. It branches on page
 * class EXACTLY as `isLiquipediaPageFresh` does, and returns FOUR DISTINCT
 * verdicts, each with a stated reason:
 *
 * - `skip-before-fetch` — ONLY reachable for the WIKITEXT class. The
 *   freshness key (revision id + content sha1 + parser version) comes from
 *   the cheap batched probe, so this verdict means NO content request was
 *   ever issued for this page.
 * - `skip-after-fetch` — the ONLY skip a GENERATED page can ever offer,
 *   because its freshness key is the hash of the parse OUTPUT and therefore
 *   cannot exist before the parse-class request has already been made and
 *   its budget already spent. This verdict never claims "before budget" —
 *   conflating the two would let a caller assert a saving the runtime
 *   cannot deliver (cycle-1 review MEDIUM 8).
 * - `refresh` — the freshness key changed (or the parser version bumped,
 *   which invalidates BOTH classes regardless of their own key).
 * - `hold-for-review` — the freshest available data would REDUCE this
 *   page's observation count, or (generated class only) falls outside the
 *   plausibility band `isVodRowCountPlausible` checks. The latest revision
 *   is not necessarily a good revision, and a correction that loses prior
 *   enrichment is indistinguishable from vandalism being accepted as fact.
 *
 * `applyPageRefresh` EXECUTES an already-decided plan. It never re-derives
 * the verdict — that would let a caller drift the decision and the write
 * apart. A `refresh` verdict:
 *
 * - writes ONLY the observations whose content actually differs from what
 *   is stored (a structural, not a byte-for-byte-replace-everything,
 *   comparison) — every other observation for the SAME source page is left
 *   byte-unchanged, because it is never even written;
 * - routes every changed, ALREADY-ATTACHED observation through the SAME
 *   `applyEnrichmentProjection` path plan 08 ships, so the ENR-08 ownership
 *   witness rules apply unchanged — a user-owned VOD is never touched;
 * - moves any set that has disappeared from the source page's fresh
 *   extraction into the review queue by deleting its attachment (never its
 *   observation — `store.ts`'s `deleteEnrichmentAttachment` contract).
 *
 * A `hold-for-review` verdict performs NO WRITE to the enrichment tree at
 * all — the stored enrichment for the page is left completely in place —
 * and persists exactly one review-entry record naming the previous and next
 * counts, at `researchEnrichmentShrinkReviews/{tenantId}/{entryId}`
 * (registered in `apps/api/src/coaching/tenants.ts`'s
 * `TENANT_DELETION_TREES`).
 */

// ---------------------------------------------------------------------------
// Plan — pure decision
// ---------------------------------------------------------------------------

export type PageRefreshVerdict =
  'skip-before-fetch' | 'skip-after-fetch' | 'refresh' | 'hold-for-review';

export interface PageRefreshPlan {
  verdict: PageRefreshVerdict;
  reason: string;
}

interface PlanPageRefreshBaseInput {
  cached: LiquipediaPageCacheRecord | null;
  parserVersion: string;
  /**
   * Supplied only once a fresh extraction has actually produced a count to
   * compare — for the WIKITEXT class that means "the page was not
   * skip-before-fetch, so it was fetched and extracted"; for the GENERATED
   * class it is always available, because the fetch (and therefore the
   * extraction) already happened by construction. Omitted entirely, the
   * shrink/plausibility guard is simply not evaluated (there is nothing yet
   * to compare).
   */
  previousObservationCount?: number;
  nextObservationCount?: number;
  /** Off by default (Task 3 action). When set, permits a shrinking or implausible refresh to proceed, and the caller is expected to record that override was used. */
  allowShrink?: boolean;
}

export interface PlanWikitextRefreshInput extends PlanPageRefreshBaseInput {
  pageClass: 'wikitext';
  /** From the batched head-revision probe — never content. */
  probeRevisionId?: number;
  probeSha1?: string;
}

export interface PlanGeneratedRefreshInput extends PlanPageRefreshBaseInput {
  pageClass: 'generated';
  /** The hash of the output content THIS invocation already fetched — see module header: the fetch is unavoidable for this class. */
  fetchedContentHash: string;
}

export type PlanPageRefreshInput = PlanWikitextRefreshInput | PlanGeneratedRefreshInput;

function planShrinkGuard(
  input: PlanPageRefreshBaseInput,
  pageClass: 'wikitext' | 'generated',
): PageRefreshPlan | null {
  const { previousObservationCount, nextObservationCount, allowShrink } = input;
  if (previousObservationCount == null || nextObservationCount == null) {
    return null;
  }
  if (nextObservationCount < previousObservationCount && !allowShrink) {
    return {
      verdict: 'hold-for-review',
      reason:
        `extracted observation count dropped from ${previousObservationCount} to ${nextObservationCount}; ` +
        'held rather than silently overwritten — the latest revision is not necessarily a good revision, ' +
        'and a correction that loses prior enrichment is indistinguishable from vandalism being accepted ' +
        'as fact (pass allowShrink to override deliberately)',
    };
  }
  if (
    pageClass === 'generated' &&
    !isVodRowCountPlausible(previousObservationCount, nextObservationCount) &&
    !allowShrink
  ) {
    return {
      verdict: 'hold-for-review',
      reason:
        `extracted row count ${nextObservationCount} falls outside the plausibility band around the ` +
        `previous count ${previousObservationCount}; held for review (pass allowShrink to override deliberately)`,
    };
  }
  return null;
}

/**
 * Branches on page class exactly as `isLiquipediaPageFresh` does, and
 * includes the parser version in both branches (Task 3 action) — a
 * generated player VOD page's wikitext is a frozen two-template stub whose
 * revision id long predates its current content, so a revision-keyed
 * refresh would conclude "unchanged" forever and never ingest a new VOD;
 * conversely a bracket page's revision id and content sha1 are the cheap
 * and correct signal.
 */
export function planPageRefresh(input: PlanPageRefreshInput): PageRefreshPlan {
  if (input.pageClass === 'wikitext') {
    const fresh = isLiquipediaPageFresh(
      input.cached,
      { pageClass: 'wikitext', revisionId: input.probeRevisionId, sha1: input.probeSha1 },
      input.parserVersion,
    );
    if (fresh) {
      return {
        verdict: 'skip-before-fetch',
        reason:
          'revision id, content sha1 and parser version all match the batched probe; the cheap probe alone ' +
          'decides this, so no content fetch was ever issued for this page',
      };
    }
  } else {
    const fresh = isLiquipediaPageFresh(
      input.cached,
      { pageClass: 'generated', contentHash: input.fetchedContentHash },
      input.parserVersion,
    );
    if (fresh) {
      return {
        verdict: 'skip-after-fetch',
        reason:
          'output content hash and parser version match the previously stored value; the parse-class fetch ' +
          'was unavoidable and already happened, so this is the weaker, achievable no-op — no re-extraction ' +
          'and no write follow',
      };
    }
  }

  const held = planShrinkGuard(input, input.pageClass);
  if (held) {
    return held;
  }

  return {
    verdict: 'refresh',
    reason:
      input.pageClass === 'wikitext'
        ? 'revision id, sha1 or parser version changed since the last fetch; re-extraction required'
        : 'output content hash or parser version changed since the last fetch; re-extraction required',
  };
}

// ---------------------------------------------------------------------------
// Apply — executes an already-decided plan
// ---------------------------------------------------------------------------

export interface PageRefreshExtractionInput {
  sourcePageTitle: string;
  /** The freshly extracted observations for this page — may be empty. */
  observations: ResearchEnrichmentObservationRecord[];
  allowShrink?: boolean;
}

export interface PageRefreshOutcome {
  verdict: PageRefreshVerdict;
  written: number;
  unchanged: number;
  movedToReview: number;
  reviewEntryId: string | null;
}

/** Structural equality over plain JSON-shaped values — used instead of key-order-sensitive `JSON.stringify` comparison, so a re-serialized (but semantically identical) record is never mistaken for a change. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** One read of the whole tenant attachment tree (mirrors `store.ts`'s `collectAttachedObservationIds` nested-two-level walk), inverted to `observationId -> targetSetId`. */
async function buildAttachmentTargetSetIndex(
  database: Database,
  tenantId: string,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const snapshot = await database.ref(`researchEnrichmentAttachments/${tenantId}`).get();
  const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
  if (raw === null || typeof raw !== 'object') {
    return index;
  }
  for (const [targetSetId, children] of Object.entries(raw)) {
    if (children === null || typeof children !== 'object') {
      continue;
    }
    for (const observationId of Object.keys(children)) {
      index.set(observationId, targetSetId);
    }
  }
  return index;
}

async function reprojectTargetSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
  nowMs: number,
): Promise<void> {
  const attachments = await listAttachmentsForSet(database, tenantId, targetSetId);
  const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {};
  for (const attachment of attachments) {
    const record = await readEnrichmentObservation(database, tenantId, attachment.observationId);
    if (record) {
      observationsById[attachment.observationId] = record;
    }
  }
  const overlay = buildEnrichmentOverlay({
    targetSetId,
    attachments,
    observations: observationsById,
  });
  await applyEnrichmentProjection(database, tenantId, targetSetId, overlay, nowMs);
}

const shrinkReviewEntryRecordSchema = z.object({
  sourcePageTitle: z.string().min(1).max(300),
  previousCount: z.number().int().nonnegative(),
  nextCount: z.number().int().nonnegative(),
  reason: z.string().max(500),
  createdAtMs: z.number().int(),
});

async function writeShrinkReviewEntry(
  database: Database,
  tenantId: string,
  input: {
    sourcePageTitle: string;
    previousCount: number;
    nextCount: number;
    reason: string;
    nowMs: number;
  },
): Promise<string | null> {
  if (!isPathSafeTenantId(tenantId)) {
    return null;
  }
  const entryId = randomUUID();
  if (!isPathSafeProviderId(entryId)) {
    return null;
  }
  const record = shrinkReviewEntryRecordSchema.parse({
    sourcePageTitle: input.sourcePageTitle,
    previousCount: input.previousCount,
    nextCount: input.nextCount,
    reason: input.reason,
    createdAtMs: input.nowMs,
  });
  await database.ref(`researchEnrichmentShrinkReviews/${tenantId}/${entryId}`).set(record);
  return entryId;
}

/**
 * Executes `plan`. A `skip-before-fetch`/`skip-after-fetch` plan performs no
 * work at all (nothing to apply — the caller already proved this page is a
 * no-op). A `hold-for-review` plan performs NO write to the enrichment tree
 * — the stored enrichment for the page is left completely in place — and
 * persists exactly one review-entry record. A `refresh` plan writes only
 * what changed, re-projects every changed attached observation's target set
 * through plan 08's ownership-aware path, and moves any set that vanished
 * from the fresh extraction into the review queue by deleting its
 * attachment (never its observation).
 */
export async function applyPageRefresh(
  database: Database,
  tenantId: string,
  plan: PageRefreshPlan,
  extraction: PageRefreshExtractionInput,
  nowMs: number,
): Promise<PageRefreshOutcome> {
  if (plan.verdict === 'skip-before-fetch' || plan.verdict === 'skip-after-fetch') {
    return {
      verdict: plan.verdict,
      written: 0,
      unchanged: 0,
      movedToReview: 0,
      reviewEntryId: null,
    };
  }

  const priorForPage = (await listEnrichmentObservations(database, tenantId)).filter(
    (record) => record.sourcePageTitle === extraction.sourcePageTitle,
  );

  if (plan.verdict === 'hold-for-review') {
    const reviewEntryId = await writeShrinkReviewEntry(database, tenantId, {
      sourcePageTitle: extraction.sourcePageTitle,
      previousCount: priorForPage.length,
      nextCount: extraction.observations.length,
      reason: plan.reason,
      nowMs,
    });
    return {
      verdict: 'hold-for-review',
      written: 0,
      unchanged: 0,
      movedToReview: 0,
      reviewEntryId,
    };
  }

  // verdict === 'refresh'
  const priorById = new Map(priorForPage.map((record) => [record.observationId, record]));
  const nextIds = new Set(extraction.observations.map((record) => record.observationId));
  const attachmentIndex = await buildAttachmentTargetSetIndex(database, tenantId);

  let written = 0;
  let unchanged = 0;
  const targetSetsToReproject = new Set<string>();

  for (const observation of extraction.observations) {
    const prior = priorById.get(observation.observationId);
    if (prior && deepEqual(prior, observation)) {
      unchanged += 1;
      continue;
    }
    // THE PARITY GATE (30.3 verifier closure 1): this is the only
    // observation-write site outside run.ts's gather, and it must hold the
    // same guarantee — a record the persistence schema would reject fails
    // HERE, loudly, never at a later read (the write boundary itself
    // parses, but the gate's named error and its extraction-time contract
    // are the reliability seam).
    await writeEnrichmentObservation(
      database,
      tenantId,
      prepareAndValidateObservation(observation),
    );
    written += 1;

    const targetSetId = attachmentIndex.get(observation.observationId);
    if (targetSetId) {
      targetSetsToReproject.add(targetSetId);
    }
  }

  let movedToReview = 0;
  for (const prior of priorForPage) {
    if (nextIds.has(prior.observationId)) {
      continue;
    }
    // This set no longer appears on the source page's fresh extraction —
    // move it to review by deleting its attachment; the observation itself
    // is never deleted (store.ts's own contract).
    const targetSetId = attachmentIndex.get(prior.observationId);
    if (targetSetId) {
      await deleteEnrichmentAttachment(database, tenantId, targetSetId, prior.observationId);
      movedToReview += 1;
    }
  }

  for (const targetSetId of targetSetsToReproject) {
    await reprojectTargetSet(database, tenantId, targetSetId, nowMs);
  }

  return { verdict: 'refresh', written, unchanged, movedToReview, reviewEntryId: null };
}
