import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import type { ReviewSection } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { NotFoundError } from '../services/rtdb.js';
import {
  addSection,
  archiveReview,
  autosaveDraft,
  countOpenDrafts,
  DEFAULT_REVIEW_SECTIONS,
  DraftConflictError,
  getDraft,
  getLatestDeliveryState,
  getMostRecentDeliveryStateForTenant,
  getReviewStatus,
  listReviews,
  previewClientVersion,
  publishReview,
  setSectionHidden,
} from './reviews.js';
import { createClient, listClients } from './tenants.js';

const TENANT_ID = 'tenant-1';
const COACH_UID = 'coach-1';
const SESSION_ID = 'session-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return {
    id: 'summary',
    kind: 'summary',
    hidden: false,
    title: null,
    body: 'Solid neutral game today.',
    ...overrides,
  };
}

describe('autosaveDraft', () => {
  it('constructs and commits the initial draft on a brand-new review (CR-01, Pitfall 1) — never an abort', async () => {
    const database = new FakeDatabase();

    const result = await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection()], coachPrivateNotes: null },
      0,
    );

    expect(result.revision).toBe(1);
    const draft = await getDraft(asDatabase(database), TENANT_ID, 'review-1');
    expect(draft).toMatchObject({
      revision: 1,
      sections: [makeSection()],
      coachPrivateNotes: null,
    });
    expect(typeof draft.createdAt).toBe('number');
    expect(typeof draft.lastAutosavedAt).toBe('number');
  });

  it('increments revision and merges the patch when expectedRevision matches', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection()], coachPrivateNotes: null },
      0,
    );

    const result = await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { coachPrivateNotes: 'Watch out for their ledgetrap setups.' },
      1,
    );

    expect(result.revision).toBe(2);
    const draft = await getDraft(asDatabase(database), TENANT_ID, 'review-1');
    expect(draft.revision).toBe(2);
    expect(draft.coachPrivateNotes).toBe('Watch out for their ledgetrap setups.');
    // Sections were omitted from this patch — must be preserved, not wiped.
    expect(draft.sections).toEqual([makeSection()]);
  });

  it('aborts without writing and throws DraftConflictError on a stale expectedRevision — on-disk text unchanged', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ body: 'original text' })], coachPrivateNotes: null },
      0,
    );

    const attempt = autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ body: 'a stale concurrent edit' })] },
      0, // stale — the server is already at revision 1
    );

    await expect(attempt).rejects.toThrow(DraftConflictError);
    const draft = await getDraft(asDatabase(database), TENANT_ID, 'review-1');
    expect(draft.revision).toBe(1);
    expect(draft.sections[0]?.body).toBe('original text');

    try {
      await autosaveDraft(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        { sections: [makeSection({ body: 'another stale edit' })] },
        0,
      );
      expect.unreachable('expected DraftConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(DraftConflictError);
      expect((err as DraftConflictError).serverDraft.revision).toBe(1);
      expect((err as DraftConflictError).serverDraft.sections[0]?.body).toBe('original text');
    }
  });
});

describe('publishReview / previewClientVersion', () => {
  it('previewClientVersion returns the same shape publishReview would seal, computed read-only with no write', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      {
        sections: [
          makeSection({ id: 'summary', kind: 'summary', body: 'Great set overall.' }),
          makeSection({ id: 'strengths', kind: 'strengths', hidden: true, body: 'never shown' }),
        ],
        coachPrivateNotes: 'private eyes only',
      },
      0,
    );

    const preview = await previewClientVersion(asDatabase(database), TENANT_ID, 'review-1');
    expect(preview.sections).toEqual([
      { id: 'summary', kind: 'summary', title: null, body: 'Great set overall.' },
    ]);
    expect(preview).not.toHaveProperty('coachPrivateNotes');

    // Deep clone: `dump()` returns a live reference into the store, not a
    // snapshot — a raw assignment would alias the post-publish state.
    const dumpBeforePublish = JSON.parse(JSON.stringify(database.dump())) as Record<
      string,
      unknown
    >;
    const published = await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    expect(published.version).toBe(1);

    const dump = database.dump() as {
      reviewVersions?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const sealed = dump.reviewVersions?.[TENANT_ID]?.['review-1']?.['1'];
    expect(sealed).toMatchObject({ sections: preview.sections });
    // Publish must not have mutated anything the preview read from.
    expect(dumpBeforePublish).not.toHaveProperty('reviewVersions');
  });

  it('filters out hidden sections, seals write-once, and sets reviewStatus to published+latestVersion', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ hidden: true })], coachPrivateNotes: null },
      0,
    );

    const published = await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    expect(published.version).toBe(1);
    const status = await getReviewStatus(asDatabase(database), TENANT_ID, 'review-1');
    expect(status).toEqual({ status: 'published', latestVersion: 1 });

    // The sealed version's `sections` array is empty (the one section was
    // hidden) — real RTDB (and FakeDatabase, mirroring it) drops any key
    // whose value is an empty array on write, so the key is simply absent.
    const dump = database.dump() as {
      reviewVersions?: Record<string, Record<string, Record<string, { sections?: unknown[] }>>>;
    };
    expect(dump.reviewVersions?.[TENANT_ID]?.['review-1']?.['1']?.sections).toBeUndefined();

    // The draft node is reset for the next edit, never deleted (REV-07).
    const draft = await getDraft(asDatabase(database), TENANT_ID, 'review-1');
    expect(draft.sections).toHaveLength(1);
  });

  it('throws NotFoundError when publishing a review with no draft', async () => {
    const database = new FakeDatabase();
    await expect(
      publishReview(asDatabase(database), TENANT_ID, 'ghost-review', {
        coachUid: COACH_UID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  // REV-01: publishReview has no citation/source gate — a draft whose
  // sections cite zero VODs (no `{{cite:...}}` tokens anywhere in their
  // bodies) must publish exactly like any other draft. This locks the
  // already-permissive behavior so a future accidental "require >=1 source"
  // gate would fail this test.
  it('REV-01: publishes successfully a draft whose sections carry zero citation tokens (no VOD sources)', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      {
        sections: [
          makeSection({ id: 'summary', kind: 'summary', body: 'No VODs for this client yet.' }),
          makeSection({ id: 'strengths', kind: 'strengths', body: 'Solid neutral fundamentals.' }),
        ],
        coachPrivateNotes: null,
      },
      0,
    );

    const published = await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    expect(published.version).toBe(1);
    const status = await getReviewStatus(asDatabase(database), TENANT_ID, 'review-1');
    expect(status).toEqual({ status: 'published', latestVersion: 1 });
  });

  it('editing after publish and re-publishing produces version N+1 while version N stays byte-for-byte unchanged', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ body: 'version one text' })], coachPrivateNotes: null },
      0,
    );
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    const dumpAfterV1 = database.dump() as {
      reviewVersions: Record<string, Record<string, Record<string, unknown>>>;
    };
    const v1Snapshot = dumpAfterV1.reviewVersions[TENANT_ID]!['review-1']!['1'];

    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ body: 'version two text' })] },
      1,
    );
    const secondPublish = await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    expect(secondPublish.version).toBe(2);
    const dumpAfterV2 = database.dump() as {
      reviewVersions: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(dumpAfterV2.reviewVersions[TENANT_ID]!['review-1']!['1']).toEqual(v1Snapshot);
    expect(
      (dumpAfterV2.reviewVersions[TENANT_ID]!['review-1']!['2'] as { sections: ReviewSection[] })
        .sections[0]?.body,
    ).toBe('version two text');
  });

  it('emits coach_review_published for v1 and review_revision_published for v2', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection()], coachPrivateNotes: null },
      0,
    );
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', {}, 1);
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rows = Object.values(dump.eventLedger ?? {}).flatMap((day) => Object.values(day));
    const names = rows.map((row) => (row as { eventName: string }).eventName);
    expect(names).toContain('coach_review_published');
    expect(names).toContain('review_revision_published');
    for (const row of rows) {
      expect((row as { payload: unknown }).payload).toEqual({});
    }
  });

  // Phase 13 (ONBD-05, D-08): the coach-cause payload rides in `payload`,
  // never `causationId`, and only when the coach's saved intent is
  // coach_clients — applies to coach_review_published (v1) here; the v2+
  // review_revision_published branch shares the same emission call site.
  it('stamps payload.onboardingCause=coach_clients on coach_review_published when the coach saved that intent', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${COACH_UID}/onboardingIntent`, 'coach_clients');
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection()], coachPrivateNotes: null },
      0,
    );

    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rows = Object.values(dump.eventLedger ?? {}).flatMap((day) => Object.values(day));
    const row = rows.find(
      (r) => (r as { eventName: string }).eventName === 'coach_review_published',
    );
    expect(row).toMatchObject({ payload: { onboardingCause: 'coach_clients' } });
  });
});

describe('section hide/add', () => {
  it('hides a section, preserving its content (Undo-able, D-03)', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ body: 'keep this text' })], coachPrivateNotes: null },
      0,
    );

    const draft = await setSectionHidden(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      'summary',
      true,
    );

    expect(draft.sections[0]).toMatchObject({ hidden: true, body: 'keep this text' });
    expect(draft.revision).toBe(2);
  });

  it('restores a hidden suggested section in place instead of duplicating it', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [makeSection({ hidden: true })], coachPrivateNotes: null },
      0,
    );

    const draft = await addSection(asDatabase(database), TENANT_ID, 'review-1', {
      kind: 'summary',
    });

    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0]).toMatchObject({ hidden: false, id: 'summary' });
  });

  it('adds a new General Notes section with a general-{uuid} id', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);

    const draft = await addSection(asDatabase(database), TENANT_ID, 'review-1', {
      kind: 'general',
      title: 'Extra thoughts',
    });

    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0]?.id).toMatch(/^general-/);
    expect(draft.sections[0]).toMatchObject({
      kind: 'general',
      title: 'Extra thoughts',
      hidden: false,
    });
  });
});

describe('archiveReview', () => {
  it('sets status to archived, preserving latestVersion', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    await archiveReview(asDatabase(database), TENANT_ID, 'review-1');

    const status = await getReviewStatus(asDatabase(database), TENANT_ID, 'review-1');
    expect(status).toEqual({ status: 'archived', latestVersion: 1 });
  });

  it('throws NotFoundError for a review with no draft', async () => {
    const database = new FakeDatabase();
    await expect(archiveReview(asDatabase(database), TENANT_ID, 'ghost-review')).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('listReviews / countOpenDrafts / delivery-state reads', () => {
  it('lists reviews with review status and "—" (null) delivery for never-published drafts (D-14)', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);

    const rows = await listReviews(asDatabase(database), TENANT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reviewId: 'review-1', status: 'draft', deliveryState: null });
  });

  it('reports not-delivered (not null) for a published review with no delivery yet', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    const rows = await listReviews(asDatabase(database), TENANT_ID);

    expect(rows[0]).toMatchObject({ status: 'published', deliveryState: 'not-delivered' });
  });

  it('countOpenDrafts counts non-archived reviews only', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-2', { sections: [] }, 0);
    await archiveReview(asDatabase(database), TENANT_ID, 'review-2');

    await expect(countOpenDrafts(asDatabase(database), TENANT_ID)).resolves.toBe(1);
  });

  it('getLatestDeliveryState/getMostRecentDeliveryStateForTenant read the most recent seeded delivery record', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-a`, {
      status: 'delivered',
      createdAt: 100,
      version: 1,
    });
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-b`, {
      status: 'acknowledged',
      createdAt: 200,
      version: 1,
    });

    await expect(getLatestDeliveryState(asDatabase(database), TENANT_ID, 'review-1')).resolves.toBe(
      'acknowledged',
    );
    await expect(
      getMostRecentDeliveryStateForTenant(asDatabase(database), TENANT_ID),
    ).resolves.toBe('acknowledged');
  });

  it('getLatestDeliveryState filters to a single version when a version argument is passed, and preserves the all-versions default when omitted (D-14)', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-v1`, {
      status: 'acknowledged',
      createdAt: 200,
      version: 1,
    });
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-v2`, {
      status: 'delivered',
      createdAt: 100,
      version: 2,
    });

    await expect(
      getLatestDeliveryState(asDatabase(database), TENANT_ID, 'review-1', 2),
    ).resolves.toBe('delivered');
    await expect(
      getLatestDeliveryState(asDatabase(database), TENANT_ID, 'review-1', 1),
    ).resolves.toBe('acknowledged');
    // No version argument -> latest by createdAt across all versions (back-compat, unchanged).
    await expect(getLatestDeliveryState(asDatabase(database), TENANT_ID, 'review-1')).resolves.toBe(
      'acknowledged',
    );
  });

  it('listReviews shows "not-delivered" (never a stale older link) for a Published v2 row whose only delivery pins v1 (D-14, UAT test 12)', async () => {
    const database = new FakeDatabase();
    const { revision } = await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [] },
      0,
    );
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-a`, {
      status: 'acknowledged',
      createdAt: 100,
      version: 1,
    });
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, revision);
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });

    const rows = await listReviews(asDatabase(database), TENANT_ID);

    expect(rows[0]).toMatchObject({
      reviewId: 'review-1',
      latestVersion: 2,
      deliveryState: 'not-delivered',
    });
  });

  it('listReviews shows the real delivery state when the delivery pins the DISPLAYED (latest) version (D-14)', async () => {
    const database = new FakeDatabase();
    const { revision } = await autosaveDraft(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      { sections: [] },
      0,
    );
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, revision);
    await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/delivery-v2`, {
      status: 'delivered',
      createdAt: 100,
      version: 2,
    });

    const rows = await listReviews(asDatabase(database), TENANT_ID);

    expect(rows[0]).toMatchObject({
      reviewId: 'review-1',
      latestVersion: 2,
      deliveryState: 'delivered',
    });
  });
});

describe('DEFAULT_REVIEW_SECTIONS', () => {
  it('has exactly the four D-03 suggested blocks, all visible with empty bodies', () => {
    expect(DEFAULT_REVIEW_SECTIONS).toHaveLength(4);
    expect(DEFAULT_REVIEW_SECTIONS.map((section) => section.kind)).toEqual([
      'summary',
      'strengths',
      'priorities',
      'practicePlan',
    ]);
    for (const section of DEFAULT_REVIEW_SECTIONS) {
      expect(section.hidden).toBe(false);
      expect(section.body).toBe('');
    }
  });
});

describe('listClients() draftCount/deliveryState wiring (Task 3, Pitfall 5)', () => {
  it('reports draftCount >= 1 for a tenant with an open (non-archived) draft', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    await autosaveDraft(asDatabase(database), tenantId, 'review-1', { sections: [] }, 0);

    const rows = await listClients(asDatabase(database), COACH_UID);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.draftCount).toBeGreaterThanOrEqual(1);
  });

  it('reports deliveryState "acknowledged" for a tenant whose most recent delivery is acknowledged', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    await autosaveDraft(asDatabase(database), tenantId, 'review-1', { sections: [] }, 0);
    await publishReview(asDatabase(database), tenantId, 'review-1', {
      coachUid: COACH_UID,
      sessionId: SESSION_ID,
    });
    database.seed(`reviewDeliveries/${tenantId}/review-1/delivery-1`, {
      status: 'acknowledged',
      createdAt: 10,
      version: 1,
    });

    const rows = await listClients(asDatabase(database), COACH_UID);

    expect(rows[0]?.deliveryState).toBe('acknowledged');
  });

  it('keeps draftCount 0 and deliveryState null for a client with no reviews at all', async () => {
    const database = new FakeDatabase();
    await createClient(asDatabase(database), COACH_UID, 'Alex', { sessionId: SESSION_ID });

    const rows = await listClients(asDatabase(database), COACH_UID);

    expect(rows[0]).toMatchObject({ draftCount: 0, deliveryState: null });
  });
});
