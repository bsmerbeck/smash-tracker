import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';
import { CANONICAL_TENANT_TREES, TENANT_DELETION_TREES } from './tenants.js';

const TENANT_ID = 'tenant-1';
const COACH_A_TOKEN = 'coach-a-token';
const COACH_A_UID = 'coach-a';
const COACH_B_TOKEN = 'coach-b-token';
const COACH_B_UID = 'coach-b';

const MINIMAL_MATCH_BODY = {
  fighter_id: 1,
  opponent_id: 8,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'someplayer',
  notes: 'test',
  matchType: 'online-friendly',
  win: true,
};

/**
 * Phase 11 (TEN-03's hard gate): one entry per subject-resolved route from
 * Plan 02 (`X-Active-Subject: client:{tenantId}` header, membership checked
 * by `resolveSubject`) PLUS every `/api/coaching/clients/:id/*` route this
 * plan (Plan 03) adds, which gates on membership directly inside
 * `apps/api/src/coaching/tenants.ts` (no header — the tenant id is the URL
 * param). This array is the canonical, living checklist of "routes proven
 * to deny a foreign coach" (RESEARCH.md Pitfall 3) — a same-subject route
 * missing from it has no proof of coverage.
 */
const SAME_SUBJECT_ROUTES = [
  { method: 'GET', path: '/api/matches', usesSubjectHeader: true },
  { method: 'POST', path: '/api/matches', usesSubjectHeader: true, body: MINIMAL_MATCH_BODY },
  { method: 'GET', path: '/api/playlists', usesSubjectHeader: true },
  { method: 'GET', path: '/api/opponent-notes', usesSubjectHeader: true },
  { method: 'GET', path: '/api/opponents/aliases', usesSubjectHeader: true },
  { method: 'GET', path: '/api/opponents', usesSubjectHeader: true },
  { method: 'GET', path: '/api/stage-favorites', usesSubjectHeader: true },
  { method: 'GET', path: '/api/users/me/fighters', usesSubjectHeader: true },
  {
    method: 'PATCH',
    path: `/api/coaching/clients/${TENANT_ID}/archive`,
    usesSubjectHeader: false,
  },
  { method: 'DELETE', path: `/api/coaching/clients/${TENANT_ID}`, usesSubjectHeader: false },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/export`,
    usesSubjectHeader: false,
  },
  // Phase 12 Plan 03 (Coach Reviews & Delivery): every coach-side review
  // route, gated the same way as the archive/delete/export routes above —
  // a direct membership check on the URL's `:clientId`, no header.
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/reviews`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews`,
    usesSubjectHeader: false,
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/draft`,
    usesSubjectHeader: false,
  },
  {
    method: 'PATCH',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/draft`,
    usesSubjectHeader: false,
    body: { expectedRevision: 0 },
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/preview`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/publish`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/sections/summary/hide`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/sections/summary/show`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/sections`,
    usesSubjectHeader: false,
    body: { kind: 'general' },
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/archive`,
    usesSubjectHeader: false,
  },
  // Phase 12 Plan 04 (Coach Reviews & Delivery): every coach-side delivery
  // route, gated the SAME way (a direct membership check on the URL's
  // `:clientId`, no header) as the review routes above.
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/deliveries`,
    usesSubjectHeader: false,
    body: { version: 1 },
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/deliveries`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/deliveries/delivery-1/revoke`,
    usesSubjectHeader: false,
  },
  // Phase 20 Plan 02 (Coaching Workflow, SESS-01/02): every coach-side
  // training-session route, gated the SAME way (a direct membership check
  // on the URL's `:clientId`, no header) as the review/delivery routes
  // above.
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/sessions`,
    usesSubjectHeader: false,
    body: { date: 1000, summary: 'test session' },
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/sessions`,
    usesSubjectHeader: false,
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1`,
    usesSubjectHeader: false,
  },
  {
    method: 'PATCH',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1`,
    usesSubjectHeader: false,
    body: { summary: 'updated' },
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1/homework/item-1/toggle`,
    usesSubjectHeader: false,
    body: { done: true },
  },
  // Phase 20 Plan 03 (Coaching Workflow, Training Sessions & VOD-less
  // Reviews, SESS-01/02): every coach-side session-delivery route, gated
  // the SAME way (a direct membership check on the URL's `:clientId`, no
  // header) as the review/delivery and session routes above.
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1/deliveries`,
    usesSubjectHeader: false,
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1/deliveries`,
    usesSubjectHeader: false,
  },
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/sessions/session-1/deliveries/delivery-1/revoke`,
    usesSubjectHeader: false,
  },
  // Phase 23 Plan 04 (Claim Credential & Atomic Ownership Transition,
  // CRED-01/CRED-03): the coach-side claim-invitation routes, gated the
  // SAME way (a direct role-aware membership check on the URL's
  // `:clientId`, no header) as the review/session/delivery routes above.
  {
    method: 'POST',
    path: `/api/coaching/clients/${TENANT_ID}/claim-invitations`,
    usesSubjectHeader: false,
  },
  {
    method: 'DELETE',
    path: `/api/coaching/clients/${TENANT_ID}/claim-invitations`,
    usesSubjectHeader: false,
  },
  {
    method: 'GET',
    path: `/api/coaching/clients/${TENANT_ID}/claim-invitations`,
    usesSubjectHeader: false,
  },
  // Phase 23 Plan 06 (CLAIM-03/CTRL-02): the client-owner delegation-revoke
  // route, gated by a role-aware membership check on the URL's `:tenantId`
  // — a foreign coach with no membership record is denied before role is
  // even considered.
  {
    method: 'DELETE',
    path: `/api/client-workspaces/${TENANT_ID}/delegations/${COACH_A_UID}`,
    usesSubjectHeader: false,
  },
] as const;

/**
 * Phase 23 conclusion (RESEARCH.md Pitfall 5), recorded here so a future
 * reader does not have to re-derive it: `claimInvitations` is keyed by HMAC
 * digest, not by tenantId, so it does NOT have the `{tree}/{tenantId}` shape
 * the hard-delete cascade below iterates, and is deliberately NOT a
 * canonical tenant tree — `deleteClient` instead has an explicit extra step
 * (plan 06) that nulls the pointed-at digest record, mirroring the existing
 * `shareTokens/{token}` step. `activeClaimInvitationByTenant` DOES have that
 * shape and IS added to `CANONICAL_TENANT_TREES` (plan 06) together with its
 * `TREE_TO_ROUTE_PATH` entry below — the conclusion recorded here is now
 * applied, not just noted. The plan-02 rate-limit counter trees
 * (`claimRedemptionAttempts*`, `claimIssuanceAttempts`) are keyed by uid, IP
 * hash, and coachUid respectively and are not tenant trees.
 */

/**
 * `CANONICAL_TENANT_TREES` (the delete-cascade's own source of truth,
 * `tenants.ts`) mapped to the same-subject route this harness proves is
 * membership-gated for that tree. Importing the array directly (rather than
 * hand-copying its tree names) keeps this map — and therefore this test —
 * from silently drifting if the cascade's tree list ever changes
 * (RESEARCH.md Open Question 2 / Pitfall 3).
 */
const TREE_TO_ROUTE_PATH: Record<(typeof CANONICAL_TENANT_TREES)[number], string> = {
  matches: '/api/matches',
  playlists: '/api/playlists',
  opponents: '/api/opponents',
  opponentAliases: '/api/opponents/aliases',
  opponentNotes: '/api/opponent-notes',
  stageFavorites: '/api/stage-favorites',
  primaryFighters: '/api/users/me/fighters',
  secondaryFighters: '/api/users/me/fighters',
  // Phase 12 Plan 03: reviewDrafts is written by the draft-fetch route;
  // reviewVersions/reviewVersionIndex/reviewStatus are all written together
  // by publish (mirrors primaryFighters/secondaryFighters both pointing at
  // the same route above).
  reviewDrafts: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/draft`,
  reviewVersions: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/publish`,
  reviewVersionIndex: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/publish`,
  reviewStatus: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/publish`,
  // Phase 12 Plan 04: written by the create-delivery route.
  reviewDeliveries: `/api/coaching/clients/${TENANT_ID}/reviews/review-1/deliveries`,
  // Phase 20 Plan 02: trainingSessions is written by the create-session
  // route.
  trainingSessions: `/api/coaching/clients/${TENANT_ID}/sessions`,
  // Phase 20 Plan 03: written by the create-session-delivery route.
  sessionDeliveries: `/api/coaching/clients/${TENANT_ID}/sessions/session-1/deliveries`,
  // Phase 23 Plan 06: the pointer is written by the coach-side
  // claim-invitation issuance route added in plan 04.
  activeClaimInvitationByTenant: `/api/coaching/clients/${TENANT_ID}/claim-invitations`,
};

describe('CANONICAL_TENANT_TREES stays in lockstep with the harness route list', () => {
  it('every tree the hard-delete cascade touches has a covered same-subject route', () => {
    for (const tree of CANONICAL_TENANT_TREES) {
      const expectedPath = TREE_TO_ROUTE_PATH[tree];
      expect(SAME_SUBJECT_ROUTES.some((route) => route.path === expectedPath)).toBe(true);
    }
  });
});

/**
 * Phase 29 Plan 10 (RTEN-05A, cycle-2 finding C2-HIGH-10): ONE additive
 * block proving `TENANT_DELETION_TREES` (the hard-delete cascade's actual
 * manifest, `apps/api/src/coaching/tenants.ts`) is a documented superset of
 * `CANONICAL_TENANT_TREES` above — the two blocks above (`TREE_TO_ROUTE_PATH`
 * and its lockstep `it`) stay byte-unchanged; this is intentionally a
 * SEPARATE describe block, not folded into them, so a future admin-only
 * tree can be added here without ever being asked to also produce a
 * same-subject route it structurally cannot have.
 */
const DELETION_TREES_WITHOUT_A_SAME_SUBJECT_ROUTE: Record<string, string> = {
  researchEntitlements:
    'apps/api/src/research/entitlements.ts grant/revoke routes are admin-only ' +
    "and answer the research family's uniform 404 (RESEARCH_FAMILY_REJECTION) " +
    'by design — they can never satisfy a covered same-subject 403 route.',
  // Phase 30 Plan 01 (ING-03/ING-05/ING-07/ING-08, D-02): five new
  // tenant-keyed research trees, registered ahead of any writer. Every one
  // is reached only through the admin-only research route family
  // (Phase 29's dual gate), which answers the same uniform 404
  // (RESEARCH_FAMILY_REJECTION) as researchEntitlements above — none can
  // ever satisfy a covered same-subject 403 route.
  researchSource:
    'the lossless provider-set tier (ING-03) is reached only through the admin-only ' +
    "research backfill routes (plan 30-07), which answer the research family's " +
    'uniform 404 by design — it can never satisfy a covered same-subject 403 route.',
  researchSupplements:
    'the manual/VOD supplement overlay tier (ING-08) is reached only through the ' +
    'admin-only research supplement routes (plan 30-07), which answer the research ' +
    "family's uniform 404 by design — it can never satisfy a covered same-subject " +
    '403 route.',
  researchIdentity:
    'the admin-confirmed player-ID identity mapping (ING-07) is reached only through ' +
    'the admin-only research identity routes (plan 30-07), which answer the research ' +
    "family's uniform 404 by design — it can never satisfy a covered same-subject " +
    '403 route.',
  researchIngestionRuns:
    'backfill run state and staged counters (ING-02) are reached only through the ' +
    'admin-only research backfill trigger/advance/status routes (plan 30-07), which ' +
    "answer the research family's uniform 404 by design — they can never satisfy a " +
    'covered same-subject 403 route.',
  researchCoverage:
    'the published completeness snapshot (ING-05) is reached only through the ' +
    'admin-only research coverage route (plan 30-07), which answers the research ' +
    "family's uniform 404 by design — it can never satisfy a covered same-subject " +
    '403 route.',
};

describe('TENANT_DELETION_TREES is a documented superset of CANONICAL_TENANT_TREES', () => {
  it('contains every member of CANONICAL_TENANT_TREES', () => {
    for (const tree of CANONICAL_TENANT_TREES) {
      expect((TENANT_DELETION_TREES as readonly string[]).includes(tree)).toBe(true);
    }
  });

  it('every extra member (present in the deletion manifest but absent from the content manifest) carries a written, non-empty reason', () => {
    const contentTrees = new Set<string>(CANONICAL_TENANT_TREES);
    const extraTrees = TENANT_DELETION_TREES.filter((tree) => !contentTrees.has(tree));

    expect(extraTrees.length).toBeGreaterThan(0);
    for (const tree of extraTrees) {
      const reason = DELETION_TREES_WITHOUT_A_SAME_SUBJECT_ROUTE[tree] ?? '';
      expect(
        reason,
        `TENANT_DELETION_TREES member "${tree}" has no exceptions-table reason`,
      ).toBeTruthy();
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe.each(SAME_SUBJECT_ROUTES)('foreign-client authorization: $method $path', (route) => {
  it("returns 403 when a second coach targets the first coach's client", async () => {
    // Phase 23 Plan 04: without a claim config the new claim-invitation
    // routes answer 503 from the whole-scope gate, and this harness would
    // assert 403 against a 503 — silently proving nothing. Configure it so
    // the assertion is meaningful for every route in the table above.
    const { app, auth, database } = buildTestApp({
      claimCode: { hmacSecret: 'test-claim-secret' },
    });
    auth.registerToken(COACH_A_TOKEN, { uid: COACH_A_UID, email: 'a@test.com' });
    auth.registerToken(COACH_B_TOKEN, { uid: COACH_B_UID, email: 'b@test.com' });
    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });
    database.seed(`coachClients/${COACH_A_UID}/${TENANT_ID}`, {
      label: 'Coach A client',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`clientMembers/${TENANT_ID}/${COACH_A_UID}`, {
      role: 'custodian',
      joinedAt: 1,
    });
    // NOTE: coach-b's membership deliberately absent.

    const response = await app.inject({
      method: route.method,
      url: route.path,
      headers: {
        authorization: `Bearer ${COACH_B_TOKEN}`,
        ...(route.usesSubjectHeader ? { 'x-active-subject': `client:${TENANT_ID}` } : {}),
      },
      payload: 'body' in route ? route.body : undefined,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('positive control: the owning coach is not blanket-blocked', () => {
  it('a subject-resolved route (GET /api/matches) returns non-403 for the member coach', async () => {
    // Phase 23 Plan 04: build with the same claim-configured app shape as
    // the describe.each block above, so the whole file exercises one
    // consistently-configured app.
    const { app, auth, database } = buildTestApp({
      claimCode: { hmacSecret: 'test-claim-secret' },
    });
    auth.registerToken(COACH_A_TOKEN, { uid: COACH_A_UID, email: 'a@test.com' });
    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });
    database.seed(`coachClients/${COACH_A_UID}/${TENANT_ID}`, {
      label: 'Coach A client',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`clientMembers/${TENANT_ID}/${COACH_A_UID}`, { role: 'custodian', joinedAt: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: {
        authorization: `Bearer ${COACH_A_TOKEN}`,
        'x-active-subject': `client:${TENANT_ID}`,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('a /coaching/clients/:id route (PATCH archive) returns non-403 for the owning coach', async () => {
    const { app, auth, database } = buildTestApp({
      claimCode: { hmacSecret: 'test-claim-secret' },
    });
    auth.registerToken(COACH_A_TOKEN, { uid: COACH_A_UID, email: 'a@test.com' });
    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });
    database.seed(`coachClients/${COACH_A_UID}/${TENANT_ID}`, {
      label: 'Coach A client',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`clientMembers/${TENANT_ID}/${COACH_A_UID}`, { role: 'custodian', joinedAt: 1 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${TENANT_ID}/archive`,
      headers: { authorization: `Bearer ${COACH_A_TOKEN}` },
    });

    expect(response.statusCode).toBe(204);
  });
});

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, T-29-05-08): a
 * SIBLING enumeration, deliberately NOT folded into `SAME_SUBJECT_ROUTES`
 * above — these are admin-gated COLLECTION routes (no tenant id in the URL,
 * no `X-Active-Subject` header), not same-subject content routes gated by
 * membership on a URL param. There is no tenant to target on a collection
 * route, so "foreign" here means "an authenticated caller who is NOT in
 * `RESEARCH_ADMIN_UIDS`", not "a second coach targeting a peer's tenant".
 * Extended in lockstep with this harness's own stated purpose (module
 * comment above `SAME_SUBJECT_ROUTES`): a research route missing from this
 * list would have no proof of coverage.
 */
const RESEARCH_ADMIN_COLLECTION_ROUTES = [
  { method: 'POST', path: '/api/research/tenants', body: { label: 'Test tenant' } },
  { method: 'GET', path: '/api/research/tenants' },
] as const;

describe.each(RESEARCH_ADMIN_COLLECTION_ROUTES)(
  'research route family authorization: $method $path',
  (route) => {
    it('returns the family uniform rejection for an authenticated caller not in RESEARCH_ADMIN_UIDS', async () => {
      const { app, auth } = buildTestApp({
        research: { adminUids: new Set(['some-other-admin']) },
      });
      auth.registerToken(COACH_B_TOKEN, { uid: COACH_B_UID, email: 'b@test.com' });

      const response = await app.inject({
        method: route.method,
        url: route.path,
        headers: { authorization: `Bearer ${COACH_B_TOKEN}` },
        payload: 'body' in route ? route.body : undefined,
      });

      expect(response.statusCode).toBe(404);
    });
  },
);
