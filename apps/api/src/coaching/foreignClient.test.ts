import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';
import { CANONICAL_TENANT_TREES } from './tenants.js';

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
] as const;

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
};

describe('CANONICAL_TENANT_TREES stays in lockstep with the harness route list', () => {
  it('every tree the hard-delete cascade touches has a covered same-subject route', () => {
    for (const tree of CANONICAL_TENANT_TREES) {
      const expectedPath = TREE_TO_ROUTE_PATH[tree];
      expect(SAME_SUBJECT_ROUTES.some((route) => route.path === expectedPath)).toBe(true);
    }
  });
});

describe.each(SAME_SUBJECT_ROUTES)('foreign-client authorization: $method $path', (route) => {
  it("returns 403 when a second coach targets the first coach's client", async () => {
    const { app, auth, database } = buildTestApp();
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
    const { app, auth, database } = buildTestApp();
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
    const { app, auth, database } = buildTestApp();
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
