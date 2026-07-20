import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  clientVisibleVersionSchema,
  MAX_REVIEW_SECTIONS,
  reviewDraftSchema,
  REVIEW_DELIVERY_STATES,
  type ClientVisibleVersion,
  type ReviewDeliveryState,
  type ReviewDraft,
  type ReviewSection,
  type ReviewSectionKind,
} from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../services/rtdb.js';

/**
 * Phase 12 (Coach Reviews & Delivery): the coach-authored review authoring
 * service — draft autosave with optimistic-concurrency conflict recovery
 * (REV-02), server-authoritative publish that seals immutable versions
 * (REV-06), preview-as-client via the SAME transform publish uses (REV-05),
 * new-version-on-edit semantics (REV-07), and section hide/add persistence
 * (REV-01). Plain exported functions taking `(database, tenantId, ...)`,
 * called from thin route files (`apps/api/src/routes/coachingReviews.ts`) —
 * mirrors `apps/api/src/coaching/tenants.ts`'s module shape, never a
 * parallel `CoachReviewRtdbService` class.
 *
 * RTDB layout (Claude's Discretion per 12-CONTEXT.md):
 * - `reviewDrafts/{tenantId}/{reviewId}`            -> ReviewDraft (autosave's ONLY write target; never deleted, REV-07)
 * - `reviewVersionIndex/{tenantId}/{reviewId}`      -> { [version: string]: true } (internal-only atomic version-number allocator)
 * - `reviewVersions/{tenantId}/{reviewId}/{version}` -> ClientVisibleVersion (write-once, immutable, REV-06)
 * - `reviewStatus/{tenantId}/{reviewId}`            -> ReviewStatusRecord (status + latestVersion; the review-side state machine, D-05)
 * - `reviewDeliveries/{tenantId}/{reviewId}/{deliveryId}` -> minimal delivery-state read surface (12-04 owns writing this tree; this
 *   plan only reads it, defensively, for the Client Hub `deliveryState` summary and the reviews-list delivery column — see
 *   `getLatestDeliveryState`/`getMostRecentDeliveryStateForTenant` below).
 */

/** The four suggested blocks (D-03) a brand-new review starts with — hidden:false, empty body, no coach-private content. */
export const DEFAULT_REVIEW_SECTIONS: ReviewSection[] = [
  { id: 'summary', kind: 'summary', hidden: false, title: null, body: '' },
  { id: 'strengths', kind: 'strengths', hidden: false, title: null, body: '' },
  { id: 'priorities', kind: 'priorities', hidden: false, title: null, body: '' },
  { id: 'practicePlan', kind: 'practicePlan', hidden: false, title: null, body: '' },
];

/** Review status (D-05): the review-side state machine, kept entirely separate from the 6-state delivery machine. */
export const REVIEW_STATUSES = ['draft', 'published', 'archived'] as const;
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number];

export const reviewStatusRecordSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  latestVersion: z.number().int().positive().nullable(),
});
export type ReviewStatusRecord = z.infer<typeof reviewStatusRecordSchema>;

const reviewDeliveryRecordSchema = z.object({
  status: z.enum(REVIEW_DELIVERY_STATES),
  createdAt: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
type ReviewDeliveryRecord = z.infer<typeof reviewDeliveryRecordSchema>;

/**
 * Thrown by `autosaveDraft` on a stale `expectedRevision` — a `ConflictError`
 * subclass (so it still 409s if a caller lets it bubble to the global error
 * handler) that additionally carries the CURRENT server draft, so the route
 * can hand it back to the composer for conflict-recovery UI (never silently
 * overwriting newer text).
 */
export class DraftConflictError extends ConflictError {
  constructor(
    message: string,
    public readonly serverDraft: ReviewDraft,
  ) {
    super(message);
    this.name = 'DraftConflictError';
  }
}

/**
 * Real RTDB (and `FakeDatabase`, mirroring it) drops any key whose value is
 * an empty array on write — a review with zero (or all-hidden-then-cleared)
 * sections round-trips with NO `sections` key at all. Every READ of a draft
 * record must normalize a missing `sections` key back to `[]` before
 * validating (the same discipline `normalizeVodTimestampsNode` already
 * established for `vodTimestamps`) — WRITE-time payloads are constructed
 * directly and never need this, only the round-trip read does.
 */
function parseDraftRecord(raw: unknown): ReviewDraft {
  const normalized =
    raw !== null && typeof raw === 'object'
      ? {
          ...(raw as Record<string, unknown>),
          sections: (raw as { sections?: unknown }).sections ?? [],
        }
      : raw;
  return reviewDraftSchema.parse(normalized);
}

export interface AutosaveDraftPatch {
  sections?: ReviewSection[] | null;
  coachPrivateNotes?: string | null;
}

/**
 * Autosave (REV-02, D-07): an optimistic-concurrency `.transaction()` on
 * `reviewDrafts/{tenantId}/{reviewId}`. `current === null` (the FIRST
 * autosave on a brand-new review) constructs-and-commits the initial draft
 * at revision 1 — this is NEVER treated as a conflict/abort (CR-01 /
 * Pitfall 1: the exact incident pattern documented in milestone
 * PITFALLS.md). A stale `expectedRevision` aborts WITHOUT writing and
 * throws `DraftConflictError` carrying the current server draft — the
 * on-disk text is never overwritten by a lost update.
 */
export async function autosaveDraft(
  database: Database,
  tenantId: string,
  reviewId: string,
  patch: AutosaveDraftPatch,
  expectedRevision: number,
): Promise<{ revision: number }> {
  const ref = database.ref(`reviewDrafts/${tenantId}/${reviewId}`);
  let conflictDraft: ReviewDraft | null = null;

  const result = await ref.transaction((current) => {
    // CR-01 discipline (mirrors tenants.ts's createClient): reset the
    // conflict-capture variable at the TOP of every callback run — a
    // discarded (hash-mismatch) attempt must never leak its capture into
    // the final outcome.
    conflictDraft = null;

    if (current === null) {
      // First-ever autosave on a brand-new review — construct-and-commit.
      // NEVER treat this as a conflict/abort (CR-01 / Pitfall 1).
      const now = Date.now();
      return reviewDraftSchema.parse({
        revision: 1,
        sections: patch.sections ?? [],
        coachPrivateNotes: patch.coachPrivateNotes ?? null,
        lastAutosavedAt: now,
        createdAt: now,
      } satisfies ReviewDraft);
    }

    const existing = parseDraftRecord(current);
    if (existing.revision !== expectedRevision) {
      conflictDraft = existing;
      return undefined; // abort without writing — never overwrite newer text
    }

    return reviewDraftSchema.parse({
      ...existing,
      ...(patch.sections !== undefined ? { sections: patch.sections ?? [] } : {}),
      ...(patch.coachPrivateNotes !== undefined
        ? { coachPrivateNotes: patch.coachPrivateNotes }
        : {}),
      revision: existing.revision + 1,
      lastAutosavedAt: Date.now(),
    } satisfies ReviewDraft);
  });

  if (!result.committed) {
    throw new DraftConflictError(
      'Draft has been edited since your last save',
      conflictDraft ?? parseDraftRecord(result.snapshot.val()),
    );
  }

  const draft = parseDraftRecord(result.snapshot.val());
  return { revision: draft.revision };
}

/** Coach-facing draft fetch — the only place `coachPrivateNotes` is returned. Throws `NotFoundError` if the review doesn't exist. */
export async function getDraft(
  database: Database,
  tenantId: string,
  reviewId: string,
): Promise<ReviewDraft> {
  const snapshot = await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    throw new NotFoundError(`Review ${reviewId} not found`);
  }
  return parseDraftRecord(snapshot.val());
}

/** Drops the coach-only `hidden` flag — used by BOTH publish and preview so they can never drift (Pitfall re: preview/publish drift). */
function toPublishedSection(section: ReviewSection): Omit<ReviewSection, 'hidden'> {
  const { hidden: _hidden, ...rest } = section;
  return rest;
}

/**
 * The ONE transform every client-visible version is built from — hidden
 * sections structurally excluded (not just flagged), `coachPrivateNotes`
 * has no field to leak (REV-03 structural omission, authored from scratch
 * on `clientVisibleVersionSchema`). Both `publishReview` (durable seal) and
 * `previewClientVersion` (read-only dry run) call this SAME function.
 */
function sealVersionPayload(draft: ReviewDraft): ClientVisibleVersion {
  return clientVisibleVersionSchema.parse({
    sections: draft.sections.filter((section) => !section.hidden).map(toPublishedSection),
    publishedAt: Date.now(),
  });
}

/**
 * Atomically reserves the next version number for a review via a
 * `.transaction()` on `reviewVersionIndex/{tenantId}/{reviewId}` — avoids
 * two concurrent publishes ever computing the same version number.
 */
async function reserveNextVersion(
  database: Database,
  tenantId: string,
  reviewId: string,
): Promise<number> {
  const ref = database.ref(`reviewVersionIndex/${tenantId}/${reviewId}`);
  let nextVersion = 1;
  const result = await ref.transaction((current) => {
    const existing = (current ?? {}) as Record<string, boolean>;
    const versionNumbers = Object.keys(existing)
      .map((key) => Number(key))
      .filter((value) => Number.isInteger(value));
    nextVersion = versionNumbers.length > 0 ? Math.max(...versionNumbers) + 1 : 1;
    return { ...existing, [String(nextVersion)]: true };
  });
  if (!result.committed) {
    throw new ConflictError('Failed to reserve the next review version');
  }
  return nextVersion;
}

/**
 * Publish (D-06, REV-06/07): re-reads the CURRENT draft server-side (never
 * trusts client-supplied content), seals an immutable
 * `reviewVersions/{tenantId}/{reviewId}/{version}` record via one multi-path
 * `update()`, and flips `reviewStatus` to `published`/`latestVersion`. The
 * draft node is left present, untouched, ready for the coach's next edit —
 * never deleted (REV-07). Throws `NotFoundError` if the review has no draft.
 */
export async function publishReview(
  database: Database,
  tenantId: string,
  reviewId: string,
  options: { coachUid: string; sessionId: string },
): Promise<{ version: number }> {
  const draftSnapshot = await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).get();
  if (!draftSnapshot.exists()) {
    throw new NotFoundError(`Review ${reviewId} not found`);
  }
  const draft = parseDraftRecord(draftSnapshot.val());
  const nextVersion = await reserveNextVersion(database, tenantId, reviewId);
  const publishedVersion = sealVersionPayload(draft);

  await database.ref().update({
    [`reviewVersions/${tenantId}/${reviewId}/${nextVersion}`]: publishedVersion,
    [`reviewStatus/${tenantId}/${reviewId}`]: reviewStatusRecordSchema.parse({
      status: 'published',
      latestVersion: nextVersion,
    }),
  });

  // Fire-and-forget, AFTER the durable write above has committed (D-11).
  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: nextVersion === 1 ? 'coach_review_published' : 'review_revision_published',
      actorId: options.coachUid,
      sessionId: options.sessionId,
      causationId: reviewId,
      consentState: 'unknown',
    }),
  );

  return { version: nextVersion };
}

/**
 * Preview-as-client (REV-05): runs the EXACT same `sealVersionPayload`
 * transform `publishReview` uses, read-only — no RTDB write. Throws
 * `NotFoundError` if the review has no draft.
 */
export async function previewClientVersion(
  database: Database,
  tenantId: string,
  reviewId: string,
): Promise<ClientVisibleVersion> {
  const draftSnapshot = await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).get();
  if (!draftSnapshot.exists()) {
    throw new NotFoundError(`Review ${reviewId} not found`);
  }
  const draft = parseDraftRecord(draftSnapshot.val());
  return sealVersionPayload(draft);
}

/**
 * Hide/show a section (D-03: overflow action `Hide section`, never a
 * destructive `×`) — content is preserved in the draft array, never
 * deleted. Bumps the draft's revision like any other draft mutation, so a
 * concurrent autosave with a now-stale `expectedRevision` correctly 409s.
 */
export async function setSectionHidden(
  database: Database,
  tenantId: string,
  reviewId: string,
  sectionId: string,
  hidden: boolean,
): Promise<ReviewDraft> {
  const draft = await getDraft(database, tenantId, reviewId);
  const sectionIndex = draft.sections.findIndex((section) => section.id === sectionId);
  if (sectionIndex === -1) {
    throw new NotFoundError(`Section ${sectionId} not found on review ${reviewId}`);
  }
  const nextDraft = reviewDraftSchema.parse({
    ...draft,
    sections: draft.sections.map((section, index) =>
      index === sectionIndex ? { ...section, hidden } : section,
    ),
    revision: draft.revision + 1,
    lastAutosavedAt: Date.now(),
  } satisfies ReviewDraft);
  await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).set(nextDraft);
  return nextDraft;
}

/**
 * `Add section` (D-03): restores a hidden suggested block IN PLACE
 * (un-hides it, never duplicates) or appends a brand-new section — a
 * `general-{uuid}` id for General Notes, the fixed kind literal for any
 * other optional SSBU-specific add. Enforces `MAX_REVIEW_SECTIONS`.
 */
export async function addSection(
  database: Database,
  tenantId: string,
  reviewId: string,
  input: { kind: ReviewSectionKind; title?: string | null },
): Promise<ReviewDraft> {
  const draft = await getDraft(database, tenantId, reviewId);

  const existingIndex =
    input.kind === 'general'
      ? -1
      : draft.sections.findIndex((section) => section.kind === input.kind);

  let nextSections: ReviewSection[];
  if (existingIndex !== -1) {
    nextSections = draft.sections.map((section, index) =>
      index === existingIndex ? { ...section, hidden: false } : section,
    );
  } else {
    if (draft.sections.length >= MAX_REVIEW_SECTIONS) {
      throw new ForbiddenError(`Review already has the maximum of ${MAX_REVIEW_SECTIONS} sections`);
    }
    const newSection: ReviewSection = {
      id: input.kind === 'general' ? `general-${randomUUID()}` : input.kind,
      kind: input.kind,
      hidden: false,
      title: input.kind === 'general' ? (input.title ?? null) : null,
      body: '',
    };
    nextSections = [...draft.sections, newSection];
  }

  const nextDraft = reviewDraftSchema.parse({
    ...draft,
    sections: nextSections,
    revision: draft.revision + 1,
    lastAutosavedAt: Date.now(),
  } satisfies ReviewDraft);
  await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).set(nextDraft);
  return nextDraft;
}

/** Reads the review-side state machine (D-05); a review with no `reviewStatus` record yet is a fresh, never-published draft. */
export async function getReviewStatus(
  database: Database,
  tenantId: string,
  reviewId: string,
): Promise<ReviewStatusRecord> {
  const snapshot = await database.ref(`reviewStatus/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    return { status: 'draft', latestVersion: null };
  }
  return reviewStatusRecordSchema.parse(snapshot.val());
}

/**
 * Archive a review — sets `reviewStatus.status` to `'archived'`, preserving
 * `latestVersion` if the review had been published. Throws `NotFoundError`
 * if the review (its draft node) doesn't exist.
 */
export async function archiveReview(
  database: Database,
  tenantId: string,
  reviewId: string,
): Promise<void> {
  const draftSnapshot = await database.ref(`reviewDrafts/${tenantId}/${reviewId}`).get();
  if (!draftSnapshot.exists()) {
    throw new NotFoundError(`Review ${reviewId} not found`);
  }
  const current = await getReviewStatus(database, tenantId, reviewId);
  await database
    .ref(`reviewStatus/${tenantId}/${reviewId}`)
    .set(reviewStatusRecordSchema.parse({ ...current, status: 'archived' }));
}

/** The set of `reviewId`s a tenant has (the draft node is created once, at start-review, and lives forever — REV-07). */
async function listReviewIds(database: Database, tenantId: string): Promise<string[]> {
  const snapshot = await database.ref(`reviewDrafts/${tenantId}`).get();
  if (!snapshot.exists()) {
    return [];
  }
  return Object.keys(snapshot.val() as Record<string, unknown>);
}

/**
 * Client Hub `draftCount` (Pitfall 5): the count of non-archived entries
 * under `reviewDrafts/{tenantId}` — every review that isn't archived is
 * live/editable draft work (D-06: editing after publish continues on the
 * SAME draft node toward the next version), so this is "how many reviews
 * this client still has open work on."
 */
export async function countOpenDrafts(database: Database, tenantId: string): Promise<number> {
  const reviewIds = await listReviewIds(database, tenantId);
  const statuses = await Promise.all(
    reviewIds.map((reviewId) => getReviewStatus(database, tenantId, reviewId)),
  );
  return statuses.filter((status) => status.status !== 'archived').length;
}

function latestDeliveryRecord(records: ReviewDeliveryRecord[]): ReviewDeliveryRecord | undefined {
  return records.reduce<ReviewDeliveryRecord | undefined>(
    (latest, record) =>
      latest === undefined || record.createdAt > latest.createdAt ? record : latest,
    undefined,
  );
}

/**
 * The most recent delivery's 6-state status for ONE review, optionally
 * scoped to a single published `version` (D-14, version-scoped reading: the
 * displayed delivery state MUST belong to the DISPLAYED version — never an
 * older version's link). When `version` is passed, candidate records are
 * filtered to `record.version === version` BEFORE picking the latest by
 * `createdAt` — a version with no delivery of its own returns `null` even if
 * an OLDER version has a real delivery. When `version` is omitted, the
 * all-versions behavior is preserved (back-compat for the direct unit test
 * and any future all-versions caller). Returns `null` when there is no
 * matching delivery — the reviews-list route treats a draft-status review's
 * `null` as "—" (D-14) and a published-status review's `null` as
 * `'not-delivered'`. NOTE: `reviewDeliveries` is written by the delivery
 * backend (12-04) — this reads the tree defensively so this route reflects
 * real data with no code change required here.
 */
export async function getLatestDeliveryState(
  database: Database,
  tenantId: string,
  reviewId: string,
  version?: number,
): Promise<ReviewDeliveryState | null> {
  const snapshot = await database.ref(`reviewDeliveries/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const raw = snapshot.val() as Record<string, unknown>;
  const records = Object.values(raw)
    .flatMap((value) => {
      const parsed = reviewDeliveryRecordSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .filter((record) => version === undefined || record.version === version);
  return latestDeliveryRecord(records)?.status ?? null;
}

/**
 * The most recent delivery's 6-state status across ALL of a tenant's
 * reviews — feeds `listClients`' `deliveryState` Hub-row summary (Task 3,
 * Pitfall 5). `null` when the tenant has no deliveries at all yet.
 */
export async function getMostRecentDeliveryStateForTenant(
  database: Database,
  tenantId: string,
): Promise<ReviewDeliveryState | null> {
  const snapshot = await database.ref(`reviewDeliveries/${tenantId}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const raw = snapshot.val() as Record<string, Record<string, unknown>>;
  const records = Object.values(raw).flatMap((deliveries) =>
    Object.values(deliveries).flatMap((value) => {
      const parsed = reviewDeliveryRecordSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  return latestDeliveryRecord(records)?.status ?? null;
}

/** A single row of the coach-side reviews list (Task 2's GET route) — the two independent state machines side by side (D-05). */
export interface ReviewListItem {
  reviewId: string;
  status: ReviewStatusValue;
  latestVersion: number | null;
  revision: number;
  /** `null` = "—" (draft never published, D-14); otherwise the 6-state delivery machine for this review's own lifecycle. */
  deliveryState: ReviewDeliveryState | null;
  createdAt: number;
  lastAutosavedAt: number;
}

/** Lists every review for a tenant with its review status AND delivery state summary (Task 2's GET route). */
export async function listReviews(database: Database, tenantId: string): Promise<ReviewListItem[]> {
  const reviewIds = await listReviewIds(database, tenantId);
  return Promise.all(
    reviewIds.map(async (reviewId) => {
      const [draft, status] = await Promise.all([
        getDraft(database, tenantId, reviewId),
        getReviewStatus(database, tenantId, reviewId),
      ]);
      const deliveryState =
        status.status === 'draft'
          ? null
          : status.latestVersion == null
            ? 'not-delivered'
            : ((await getLatestDeliveryState(database, tenantId, reviewId, status.latestVersion)) ??
              'not-delivered');
      return {
        reviewId,
        status: status.status,
        latestVersion: status.latestVersion,
        revision: draft.revision,
        deliveryState,
        createdAt: draft.createdAt,
        lastAutosavedAt: draft.lastAutosavedAt,
      };
    }),
  );
}
