import { describe, expect, it, vi } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';

async function createClient(app: ReturnType<typeof buildTestApp>['app'], label = 'Alex') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label },
  });
  return response.json().clientId as string;
}

describe('/api/coaching/clients/:clientId/reviews', () => {
  it('runs the full draft -> autosave -> preview -> publish -> re-version lifecycle', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);

    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(createResponse.statusCode).toBe(201);
    const { reviewId, revision } = createResponse.json();
    expect(revision).toBe(1);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({ reviewId, status: 'draft', deliveryState: null }),
    ]);

    const draftResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
    });
    expect(draftResponse.statusCode).toBe(200);
    const draft = draftResponse.json();
    expect(draft.sections).toHaveLength(4);
    expect(draft).toHaveProperty('coachPrivateNotes');

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
      payload: {
        expectedRevision: 1,
        sections: [{ ...draft.sections[0], body: 'Great neutral game today.' }],
      },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().revision).toBe(2);

    const previewResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/preview`,
      headers: authHeader(),
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview.sections).toEqual([
      expect.objectContaining({ body: 'Great neutral game today.' }),
    ]);
    expect(preview).not.toHaveProperty('coachPrivateNotes');

    const publishResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
      headers: authHeader(),
    });
    expect(publishResponse.statusCode).toBe(200);
    expect(publishResponse.json()).toEqual({ version: 1 });

    const listAfterPublish = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(listAfterPublish.json()).toEqual([
      expect.objectContaining({
        status: 'published',
        latestVersion: 1,
        deliveryState: 'not-delivered',
      }),
    ]);

    // Revise -> re-publish -> v2.
    await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
      payload: { expectedRevision: 2, coachPrivateNotes: 'watch their ledgetrap habit' },
    });
    const secondPublish = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
      headers: authHeader(),
    });
    expect(secondPublish.json()).toEqual({ version: 2 });
  });

  it('publish never accepts a client-supplied sections field (server-authoritative, T-12-06)', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = (
      await app.inject({
        method: 'POST',
        url: `/api/coaching/clients/${clientId}/reviews`,
        headers: authHeader(),
      })
    ).json();

    const publishResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
      headers: authHeader(),
      payload: { sections: [{ id: 'injected', kind: 'summary', hidden: false, body: 'hacked' }] },
    });

    expect(publishResponse.statusCode).toBe(200);
    const previewAfter = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/preview`,
      headers: authHeader(),
    });
    // The published version reflects the SERVER-side draft (the 4 default
    // sections), never the injected body.
    expect(previewAfter.json().sections).toHaveLength(4);
    expect(JSON.stringify(previewAfter.json())).not.toContain('hacked');
  });

  it('maps a stale expectedRevision to 409 with the server draft attached, never overwriting newer text', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = (
      await app.inject({
        method: 'POST',
        url: `/api/coaching/clients/${clientId}/reviews`,
        headers: authHeader(),
      })
    ).json();

    // A newer autosave lands first, bumping the server to revision 2.
    await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
      payload: { expectedRevision: 1, coachPrivateNotes: 'newest text' },
    });

    // A second tab, still holding the stale revision 1, tries to save.
    const staleResponse = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
      payload: { expectedRevision: 1, coachPrivateNotes: 'a stale overwrite' },
    });

    expect(staleResponse.statusCode).toBe(409);
    const body = staleResponse.json();
    expect(body.serverDraft.coachPrivateNotes).toBe('newest text');

    const draftResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
    });
    expect(draftResponse.json().coachPrivateNotes).toBe('newest text');
  });

  it('hides a section (content preserved) and restores it via /show', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = (
      await app.inject({
        method: 'POST',
        url: `/api/coaching/clients/${clientId}/reviews`,
        headers: authHeader(),
      })
    ).json();

    const hideResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/sections/summary/hide`,
      headers: authHeader(),
    });
    expect(hideResponse.statusCode).toBe(200);
    const hiddenSection = hideResponse
      .json()
      .sections.find((s: { id: string }) => s.id === 'summary');
    expect(hiddenSection.hidden).toBe(true);

    const showResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/sections/summary/show`,
      headers: authHeader(),
    });
    expect(showResponse.statusCode).toBe(200);
    const restoredSection = showResponse
      .json()
      .sections.find((s: { id: string }) => s.id === 'summary');
    expect(restoredSection.hidden).toBe(false);
  });

  it('adds a General Notes section via POST /sections', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = (
      await app.inject({
        method: 'POST',
        url: `/api/coaching/clients/${clientId}/reviews`,
        headers: authHeader(),
      })
    ).json();

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/sections`,
      headers: authHeader(),
      payload: { kind: 'general', title: 'Extra thoughts' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sections).toHaveLength(5);
    const general = body.sections.find((s: { kind: string }) => s.kind === 'general');
    expect(general.id).toMatch(/^general-/);
    expect(general.title).toBe('Extra thoughts');
  });

  it('archives a review', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = (
      await app.inject({
        method: 'POST',
        url: `/api/coaching/clients/${clientId}/reviews`,
        headers: authHeader(),
      })
    ).json();

    const archiveResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/archive`,
      headers: authHeader(),
    });
    expect(archiveResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(listResponse.json()).toEqual([expect.objectContaining({ status: 'archived' })]);
  });

  it('404s a draft fetch for a nonexistent review', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/ghost-review/draft`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('emits coach_review_draft_started after the durable write, empty content-free payload', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rows = Object.values(dump.eventLedger ?? {}).flatMap((day) => Object.values(day));
    const draftStarted = rows.find(
      (row) => (row as { eventName: string }).eventName === 'coach_review_draft_started',
    ) as { payload: unknown } | undefined;
    expect(draftStarted).toBeDefined();
    expect(draftStarted?.payload).toEqual({});
  });
});

/** Records the ORDER of every `.ref(path)` call against `database`, without disturbing behavior. */
function recordRefCalls(database: FakeDatabase): { paths: string[] } {
  const paths: string[] = [];
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    paths.push(path ?? '(root)');
    return originalRef(path);
  });
  return { paths };
}

/**
 * RTEN-04 (D-06): `requireMembership` (plan 29-04's preHandler gate, a
 * DIFFERENT plan's authorization decision) already fails closed (403, no
 * handler invocation, no write) on an unresolvable-kind tenant before this
 * route's handler body — and therefore this guard — ever runs. That makes
 * "unresolvable-kind subject, write still succeeds" structurally
 * unreachable via THIS route (see `29-07-SUMMARY.md`'s reachability note;
 * `apps/api/src/coaching/reviews.ts`'s `publishReview` — a plain function
 * not gated by `requireMembership` internally — is where this plan proves
 * that exact scenario end to end). The reachable state this guard must be
 * proven correct for is `research` (an allowlisted admin CAN reach this
 * handler on their own research tenant, since `assertTenantAccess` permits
 * the `research` outcome for an allowlisted uid).
 */
describe('coach_review_draft_started RTEN-04 (D-06): research-subject telemetry suppression', () => {
  it('an allowlisted research admin starting a review on their own research tenant: zero coach_review_draft_started rows, and the draft write still succeeds', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    const clientId = await createClient(app);
    database.seed(`clientTenants/${clientId}/kind`, 'research');

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(201);
    const { reviewId } = response.json();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
    const rows = Object.values(dump.eventLedger ?? {}).flatMap((day) => Object.values(day));
    expect(
      rows.filter(
        (row) => (row as { eventName: string }).eventName === 'coach_review_draft_started',
      ),
    ).toHaveLength(0);

    // The autosave write itself still succeeded.
    const draftResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
      headers: authHeader(),
    });
    expect(draftResponse.statusCode).toBe(200);
  });

  it('resolves the subject kind BEFORE the autosave mutation — review finding 29-06 MEDIUM', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);

    const { paths } = recordRefCalls(database);
    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(201);
    const { reviewId } = response.json();

    const kindReadIndex = paths.indexOf(`clientTenants/${clientId}/kind`);
    const draftWriteIndex = paths.indexOf(`reviewDrafts/${clientId}/${reviewId}`);
    expect(kindReadIndex).toBeGreaterThanOrEqual(0);
    expect(draftWriteIndex).toBeGreaterThanOrEqual(0);
    expect(kindReadIndex).toBeLessThan(draftWriteIndex);
  });
});
