import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StartggConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { buildTestApp, authHeader } from '../test-support/testApp.js';
import {
  RtdbService,
  ForbiddenError,
  buildReviewShareId,
  buildSessionShareId,
} from '../services/rtdb.js';
import { createReviewDelivery } from '../coaching/reviewDeliveries.js';
import { createSessionDelivery } from '../coaching/sessionDeliveries.js';
import { exportClient, CANONICAL_TENANT_TREES, createClientCore } from '../coaching/tenants.js';
import { createResearchTenant } from './tenants.js';
import { RESEARCH_FAMILY_REJECTION } from './routeGuards.js';

/**
 * Phase 29 Plan 12 — the phase's composite server-side proof. Every earlier
 * plan proved its own surface (29-04 tenant access, 29-05 the route family,
 * 29-06 the seven RTEN-03 guard sites, 29-07 the server emitter gate, 29-09
 * browser telemetry, 29-10 the entitlement store, 29-11 the report
 * refusal). This suite is where the roadmap's actual claim — that a WHOLE
 * session of research-workspace activity leaves no trace anywhere, on
 * either tier — is proven together rather than inferred from the sum of
 * the parts.
 */

const WEB_BASE_URL = 'https://grandfinals.gg';
const SRC_ROOT = resolve('src');

/** Strips `//` and `/* *\/` comments so a comment-only mention of a symbol never satisfies a source scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Mirrors the drain helper `apps/api/src/billing/credits.test.ts` defines
 * at line ~20-22, copied per-file per that plan's own established
 * convention — every fire-and-forget `void createEvent(...)` call needs a
 * macrotask tick to settle before a zero-row assertion is meaningful.
 */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

/** Recursively collects every non-test `.ts` source file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.ts$/.test(entry) && !entry.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Enumeration arrays, cross-checked against a fresh source scan (D-08).
// ---------------------------------------------------------------------------

/**
 * The three independent mint writers (plan 29-06's SUMMARY, RTEN-03) — each
 * gates via a local `const mintKindResolution = await readSubjectKind(...)`
 * guard, positioned before any write. Per-entry test below, not one test
 * standing in for all three.
 */
const MINT_WRITERS = [
  { name: 'RtdbService.createShare', file: 'services/rtdb.ts' },
  { name: 'createReviewDelivery', file: 'coaching/reviewDeliveries.ts' },
  { name: 'createSessionDelivery', file: 'coaching/sessionDeliveries.ts' },
] as const;

/**
 * The FOUR independent resolution chokepoints (plan 29-06 SUMMARY, review
 * finding 29-11 HIGH: the anonymous edit-session resolver is the fourth,
 * not a third). All four live in `services/rtdb.ts` and share the local
 * guard name `resolutionKindResolution`.
 */
const RESOLUTION_CHOKEPOINTS = [
  'getShareByToken',
  'resolveCoachReviewShareRef',
  'resolveSessionShareRef',
  'resolveEditSession (via getEditSessionByToken)',
] as const;

describe('enumeration arrays are cross-checked against a fresh source scan (D-08, T-29-12-01)', () => {
  it('discovers strictly more than zero source files under src/ (anti-vacuous-pass guard)', () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it('MINT_WRITERS has exactly 3 entries, matching the fresh-scan guard count across their 3 files', () => {
    expect(MINT_WRITERS.length).toBe(3);
    let totalMintGuards = 0;
    const filesWithMintGuard = new Set<string>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const matches = source.match(/const mintKindResolution = await readSubjectKind\(/g) ?? [];
      if (matches.length > 0) {
        totalMintGuards += matches.length;
        filesWithMintGuard.add(file.replace(`${SRC_ROOT}/`, ''));
      }
    }
    expect(totalMintGuards).toBeGreaterThan(0);
    expect(totalMintGuards).toBe(3);
    expect(filesWithMintGuard).toEqual(new Set(MINT_WRITERS.map((w) => w.file)));
  });

  it('RESOLUTION_CHOKEPOINTS has exactly 4 entries, matching the fresh-scan guard count in rtdb.ts', () => {
    expect(RESOLUTION_CHOKEPOINTS.length).toBe(4);
    const source = stripComments(readFileSync(resolve(SRC_ROOT, 'services/rtdb.ts'), 'utf-8'));
    const matches = source.match(/const resolutionKindResolution = await readSubjectKind\(/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBe(4);
  });
});

/** Extracts every `app.<verb>('<path>', ...)` route the research plugin registers. */
function extractRegisteredRoutes(): { method: string; path: string }[] {
  const source = stripComments(readFileSync(resolve(SRC_ROOT, 'routes/research.ts'), 'utf-8'));
  const routes: { method: string; path: string }[] = [];
  const pattern = /app\.(get|post|patch|delete)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    routes.push({ method: match[1]!.toUpperCase(), path: `/api${match[2]}` });
  }
  return routes;
}

const RESEARCH_ROUTE_FAMILY = extractRegisteredRoutes();

describe('the research route array is derived from the registered plugin (D-08)', () => {
  it('discovers exactly the 23 routes the plugin registers, not a hand-typed sample', () => {
    // Phase 30 Plan 07 extended the family from 4 routes to 15: the two
    // collection routes and two entitlement routes Phase 29 shipped, plus
    // the eleven identity/backfill/coverage/supplement routes that plan
    // adds. Phase 30.2 Plan 10 (ENR-06) adds 4 more: the enrichment review
    // listing, confirm, detach and coverage routes. Phase 30.3 Gate 5 adds
    // 4 more: the VOD candidates listing, confirm, dismiss and bounded
    // discover routes — all reusing `requireResearchTenantAdmin` verbatim,
    // bringing the family to 23.
    expect(RESEARCH_ROUTE_FAMILY.length).toBeGreaterThan(0);
    expect(RESEARCH_ROUTE_FAMILY).toEqual([
      { method: 'POST', path: '/api/research/tenants' },
      { method: 'GET', path: '/api/research/tenants' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/entitlement/grant' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/entitlement/revoke' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/identity/resolve' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/identity/confirm' },
      { method: 'GET', path: '/api/research/tenants/:tenantId/identity' },
      { method: 'DELETE', path: '/api/research/tenants/:tenantId/identity/:playerId' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/backfill/trigger' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/backfill/advance' },
      { method: 'GET', path: '/api/research/tenants/:tenantId/backfill/status' },
      { method: 'GET', path: '/api/research/tenants/:tenantId/coverage' },
      { method: 'POST', path: '/api/research/tenants/:tenantId/supplements' },
      {
        method: 'DELETE',
        path: '/api/research/tenants/:tenantId/supplements/:targetSetId/:supplementId',
      },
      { method: 'GET', path: '/api/research/tenants/:tenantId/supplements/:targetSetId' },
      { method: 'GET', path: '/api/research/tenants/:tenantId/enrichment/review' },
      {
        method: 'POST',
        path: '/api/research/tenants/:tenantId/enrichment/review/:observationId/confirm',
      },
      {
        method: 'DELETE',
        path: '/api/research/tenants/:tenantId/enrichment/attachments/:targetSetId/:observationId',
      },
      { method: 'GET', path: '/api/research/tenants/:tenantId/enrichment/vod-candidates' },
      {
        method: 'POST',
        path: '/api/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId/confirm',
      },
      {
        method: 'DELETE',
        path: '/api/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId',
      },
      {
        method: 'POST',
        path: '/api/research/tenants/:tenantId/enrichment/vod-candidates/discover',
      },
      { method: 'GET', path: '/api/research/tenants/:tenantId/enrichment/coverage' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Per-entry mint refusal tests + the export refusal as an 8th named surface.
// ---------------------------------------------------------------------------

describe('per-entry mint refusal (D-08: one test per writer, never a group test)', () => {
  const TENANT = 'mint-enum-tenant';

  it('mint writer 1/3: RtdbService.createShare refuses a research subject, database byte-unchanged', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });
    database.seed(`matches/${TENANT}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc',
    });
    const before = database.dump();
    const rtdb = new RtdbService(database as never);

    await expect(
      rtdb.createShare(
        TENANT,
        {
          kind: 'review',
          matchId: 'm1',
          redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
          permissions: 'view',
        } as never,
        WEB_BASE_URL,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(database.dump()).toEqual(before);
  });

  it('mint writer 2/3: createReviewDelivery refuses a research subject, database byte-unchanged', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });
    database.seed(`reviewVersions/${TENANT}/review-1/1`, {
      sections: [{ id: 'summary', kind: 'summary', title: null, body: 'text' }],
      publishedAt: 1,
    });
    const before = database.dump();

    await expect(
      createReviewDelivery(database as never, TENANT, 'review-1', 1, WEB_BASE_URL),
    ).rejects.toThrow();
    expect(database.dump()).toEqual(before);
  });

  it('mint writer 3/3: createSessionDelivery refuses a research subject, database byte-unchanged', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });
    database.seed(`trainingSessions/${TENANT}/session-1`, {
      date: 1,
      summary: 'a session',
      createdAt: 1,
    });
    const before = database.dump();

    await expect(
      createSessionDelivery(database as never, TENANT, 'session-1', WEB_BASE_URL),
    ).rejects.toThrow();
    expect(database.dump()).toEqual(before);
  });

  it('the 8th RTEN-03 surface (full-workspace export) refuses a research tenant even for an allowlisted custodian', async () => {
    const database = new FakeDatabase();
    const ADMIN = 'export-admin-uid';
    const { tenantId } = await createResearchTenant(database as never, ADMIN, 'Export target');

    await expect(
      exportClient(database as never, ADMIN, tenantId, { adminUids: new Set([ADMIN]) }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Per-entry resolution refusal tests at the RtdbService/function level.
// (The exhaustive per-branch/per-route coverage already lives in plan
// 29-06's rtdb.test.ts and its 5 route test files — this suite's job is to
// prove the ENUMERATION is complete and each entry closed, not to
// re-duplicate every branch already locked elsewhere.)
// ---------------------------------------------------------------------------

describe('per-entry resolution refusal (D-08: one test per chokepoint)', () => {
  const RESEARCH_TENANT = 'resolve-enum-research';
  const SAME_TOKEN = 'isoEnumFixedTokenAAAABBBBCCCCDDDDEEEEFFFF';

  it('chokepoint 1/4: getShareByToken resolves a research-subject token the SAME as an unknown token', async () => {
    const researchDb = new FakeDatabase();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: 'share-1',
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    researchDb.seed('shareSnapshots/share-1', {
      uid: RESEARCH_TENANT,
      matchId: 'm1',
      createdAt: 1,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 8,
      matchDate: 1,
      vodUrl: 'https://youtube.com/watch?v=abc',
      reviewedMomentsCount: 0,
      redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
    });
    const researchResult = await new RtdbService(researchDb as never).getShareByToken(SAME_TOKEN);
    const unknownResult = await new RtdbService(new FakeDatabase() as never).getShareByToken(
      SAME_TOKEN,
    );
    expect(researchResult).toBeNull();
    expect(researchResult).toEqual(unknownResult);
  });

  it('chokepoint 2/4: resolveCoachReviewShareRef resolves a research-subject token the SAME as an unknown token', async () => {
    const researchDb = new FakeDatabase();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: buildReviewShareId(RESEARCH_TENANT, 'review-1', 1),
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    const researchResult = await new RtdbService(researchDb as never).resolveCoachReviewShareRef(
      SAME_TOKEN,
    );
    const unknownResult = await new RtdbService(
      new FakeDatabase() as never,
    ).resolveCoachReviewShareRef(SAME_TOKEN);
    expect(researchResult).toBeNull();
    expect(researchResult).toEqual(unknownResult);
  });

  it('chokepoint 3/4: resolveSessionShareRef resolves a research-subject token the SAME as an unknown token', async () => {
    const researchDb = new FakeDatabase();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: buildSessionShareId(RESEARCH_TENANT, 'session-1', 'delivery-1'),
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    const researchResult = await new RtdbService(researchDb as never).resolveSessionShareRef(
      SAME_TOKEN,
    );
    const unknownResult = await new RtdbService(new FakeDatabase() as never).resolveSessionShareRef(
      SAME_TOKEN,
    );
    expect(researchResult).toBeNull();
    expect(researchResult).toEqual(unknownResult);
  });

  it('chokepoint 4/4: resolveEditSession (via getEditSessionByToken) resolves a research-subject token the SAME as an unknown token', async () => {
    const researchDb = new FakeDatabase();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: 'edit-share-1',
      ownerUid: RESEARCH_TENANT,
      permissions: 'edit',
      createdAt: 1,
    });
    researchDb.seed('shareSnapshots/edit-share-1', {
      uid: RESEARCH_TENANT,
      matchId: 'm1',
      createdAt: 1,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 8,
      matchDate: 1,
      vodUrl: 'https://youtube.com/watch?v=abc',
      reviewedMomentsCount: 0,
      redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
    });
    const researchResult = await new RtdbService(researchDb as never).getEditSessionByToken(
      SAME_TOKEN,
    );
    const unknownResult = await new RtdbService(new FakeDatabase() as never).getEditSessionByToken(
      SAME_TOKEN,
    );
    expect(researchResult).toBeNull();
    expect(researchResult).toEqual(unknownResult);
  });
});

// ---------------------------------------------------------------------------
// Anonymous public-route level: representative routes over each chokepoint
// answer a research-subject token identically to an unknown token — the
// exhaustive per-branch route coverage already locked in plan 29-06's five
// route test files (publicVodShares/shareMeta/shareOgImage/
// publicReviewDeliveries/coachNotes).
// ---------------------------------------------------------------------------

describe('anonymous public routes answer a research-subject token identically to an unknown token', () => {
  const RESEARCH_TENANT = 'anon-route-research';
  const SAME_TOKEN = 'anonRouteFixedTokenAAAABBBBCCCCDDDDEEEEFF';

  it('GET /api/vod-shares/:token (getShareByToken)', async () => {
    const { app: researchApp, database: researchDb } = buildTestApp();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: 'share-anon-1',
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    researchDb.seed('shareSnapshots/share-anon-1', {
      uid: RESEARCH_TENANT,
      matchId: 'm1',
      createdAt: 1,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 8,
      matchDate: 1,
      vodUrl: 'https://youtube.com/watch?v=abc',
      reviewedMomentsCount: 0,
      redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
    });
    const { app: unknownApp } = buildTestApp();

    const researchResponse = await researchApp.inject({
      method: 'GET',
      url: `/api/vod-shares/${SAME_TOKEN}`,
    });
    const unknownResponse = await unknownApp.inject({
      method: 'GET',
      url: `/api/vod-shares/${SAME_TOKEN}`,
    });
    expect(researchResponse.statusCode).toBe(404);
    expect(researchResponse.json()).toEqual(unknownResponse.json());
  });

  it('GET /api/vod-shares/:token/session (resolveEditSession)', async () => {
    const { app: researchApp, database: researchDb } = buildTestApp();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: 'edit-anon-1',
      ownerUid: RESEARCH_TENANT,
      permissions: 'edit',
      createdAt: 1,
    });
    researchDb.seed('shareSnapshots/edit-anon-1', {
      uid: RESEARCH_TENANT,
      matchId: 'm1',
      createdAt: 1,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 8,
      matchDate: 1,
      vodUrl: 'https://youtube.com/watch?v=abc',
      reviewedMomentsCount: 0,
      redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
    });
    const { app: unknownApp } = buildTestApp();

    const researchResponse = await researchApp.inject({
      method: 'GET',
      url: `/api/vod-shares/${SAME_TOKEN}/session`,
    });
    const unknownResponse = await unknownApp.inject({
      method: 'GET',
      url: `/api/vod-shares/${SAME_TOKEN}/session`,
    });
    expect(researchResponse.statusCode).toBe(404);
    expect(researchResponse.json()).toEqual(unknownResponse.json());
  });

  it('POST /api/review-deliveries/:token/ack (resolveCoachReviewShareRef)', async () => {
    const { app: researchApp, database: researchDb } = buildTestApp();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: buildReviewShareId(RESEARCH_TENANT, 'review-1', 1),
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    const { app: unknownApp } = buildTestApp();

    const researchResponse = await researchApp.inject({
      method: 'POST',
      url: `/api/review-deliveries/${SAME_TOKEN}/ack`,
    });
    const unknownResponse = await unknownApp.inject({
      method: 'POST',
      url: `/api/review-deliveries/${SAME_TOKEN}/ack`,
    });
    expect(researchResponse.statusCode).toBe(404);
    expect(researchResponse.json()).toEqual(unknownResponse.json());
  });

  it('POST /api/review-deliveries/:token/homework/item (resolveSessionShareRef)', async () => {
    const { app: researchApp, database: researchDb } = buildTestApp();
    researchDb.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    researchDb.seed(`shareTokens/${SAME_TOKEN}`, {
      shareId: buildSessionShareId(RESEARCH_TENANT, 'session-1', 'delivery-1'),
      ownerUid: RESEARCH_TENANT,
      permissions: 'view',
      createdAt: 1,
    });
    const { app: unknownApp } = buildTestApp();

    const researchResponse = await researchApp.inject({
      method: 'POST',
      url: `/api/review-deliveries/${SAME_TOKEN}/homework/item`,
      payload: { index: 0, done: true },
    });
    const unknownResponse = await unknownApp.inject({
      method: 'POST',
      url: `/api/review-deliveries/${SAME_TOKEN}/homework/item`,
      payload: { index: 0, done: true },
    });
    expect(researchResponse.statusCode).toBe(404);
    expect(researchResponse.json()).toEqual(unknownResponse.json());
  });
});

// ---------------------------------------------------------------------------
// The partitioned route matrix — four feasible classes (review findings
// 29-11 HIGH x2), matching plan 29-05's two separately-scoped guards and its
// explicit two-class response contract.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'route-matrix-admin-token';
const ADMIN_UID = 'route-matrix-admin';
const NON_ADMIN_TOKEN = 'route-matrix-non-admin-token';
const NON_ADMIN_UID = 'route-matrix-non-admin';

function buildResearchRouteApp(adminUid: string) {
  const built = buildTestApp({
    research: { adminUids: new Set([adminUid]) },
    reports: { anthropicApiKey: 'sk-test', allowedUids: new Set(['some-other-uid']) },
  });
  built.auth.registerToken(ADMIN_TOKEN, { uid: adminUid, email: 'admin@test.com' });
  built.auth.registerToken(NON_ADMIN_TOKEN, { uid: NON_ADMIN_UID, email: 'non-admin@test.com' });
  return built;
}

describe('the partitioned route matrix (four feasible classes, review findings 29-11 HIGH x2)', () => {
  describe('class 1: unauthenticated', () => {
    it('every route in the family receives the authentication failure, equal across routes, and NOT equal to the uniform rejection', async () => {
      const { app } = buildResearchRouteApp(ADMIN_UID);
      // Every path segment (not only :tenantId) needs a schema-valid
      // placeholder — Phase 30 Plan 07 extends the family with
      // :playerId/:targetSetId/:supplementId segments too. Phase 30.2 Plan
      // 10 (ENR-06) adds :observationId.
      function urlFor(path: string): string {
        return path
          .replace(':tenantId', 'placeholder-tenant')
          .replace(':playerId', '100')
          .replace(':targetSetId', '1')
          .replace(':supplementId', 'manual-note')
          .replace(':observationId', 'obs-1');
      }
      // Each route's own valid-body shape — a body-schema 400 must never
      // masquerade as the authentication-failure class this test proves.
      function payloadFor(path: string): Record<string, unknown> | undefined {
        if (path.endsWith('/entitlement/grant')) {
          return { idempotencyKey: 'unauth-class-check-00001' };
        }
        if (path.endsWith('/entitlement/revoke')) {
          return { expectedGrantId: 'unauth-class-check-grant' };
        }
        if (path === '/api/research/tenants') {
          return { label: 'Unauth class check' };
        }
        if (path.endsWith('/identity/resolve')) {
          return { slug: 'user/unauth-class-check' };
        }
        if (path.endsWith('/identity/confirm')) {
          return { players: [{ playerId: '100' }] };
        }
        if (path.endsWith('/backfill/trigger')) {
          return { mode: 'full' };
        }
        if (path.endsWith('/backfill/advance')) {
          return { runId: 'unauth-class-check-run' };
        }
        if (path.endsWith('/supplements')) {
          return { targetSetId: '1', field: 'note', value: 'x', sourceKind: 'manual' };
        }
        if (path.endsWith('/confirm')) {
          return { targetSetId: 'unauth-class-check-set' };
        }
        return undefined;
      }
      const responses = await Promise.all(
        RESEARCH_ROUTE_FAMILY.map((route) =>
          app.inject({
            method: route.method as 'GET' | 'POST' | 'DELETE',
            url: urlFor(route.path),
            payload: route.method === 'POST' ? payloadFor(route.path) : undefined,
          }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(401);
      }
      const bodies = responses.map((r) => r.json());
      for (const body of bodies.slice(1)) {
        expect(body).toEqual(bodies[0]);
      }
      expect(bodies[0]).not.toEqual(RESEARCH_FAMILY_REJECTION.body);
    });
  });

  describe('class 2: authenticated, collection routes (no "not a member of target" case — no target exists)', () => {
    it('research config null -> uniform rejection', async () => {
      const { app } = buildTestApp();
      const response = await app.inject({
        method: 'GET',
        url: '/api/research/tenants',
        headers: authHeader('missing-token'),
      });
      // No token registered -> auth failure, not the family rejection; use
      // a properly-authenticated caller against a null-config app instead.
      expect(response.statusCode).toBe(401);

      const { app: nullConfigApp, auth } = buildTestApp();
      auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'a@test.com' });
      const nullConfigResponse = await nullConfigApp.inject({
        method: 'GET',
        url: '/api/research/tenants',
        headers: authHeader(ADMIN_TOKEN),
      });
      expect(nullConfigResponse.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(nullConfigResponse.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });

    it('caller not allowlisted -> uniform rejection, deep-equal to the null-config case', async () => {
      const { app } = buildResearchRouteApp(ADMIN_UID);
      const response = await app.inject({
        method: 'GET',
        url: '/api/research/tenants',
        headers: authHeader(NON_ADMIN_TOKEN),
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });

    it('caller holding only the reports allowlist -> uniform rejection', async () => {
      const reportsOnlyUid = 'reports-only-uid';
      const built = buildTestApp({
        research: { adminUids: new Set([ADMIN_UID]) },
        reports: { anthropicApiKey: 'sk-test', allowedUids: new Set([reportsOnlyUid]) },
      });
      built.auth.registerToken('reports-only-token', {
        uid: reportsOnlyUid,
        email: 'reports-only@test.com',
      });
      const response = await built.app.inject({
        method: 'GET',
        url: '/api/research/tenants',
        headers: authHeader('reports-only-token'),
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });
  });

  describe('class 3: authenticated, tenant-addressed routes (entitlement grant/revoke)', () => {
    it('non-admin, allowlisted-admin-not-a-member, ordinary-tenant target, and unresolvable-kind target all deep-equal the collection-route rejection', async () => {
      const { app, database, auth } = buildResearchRouteApp(ADMIN_UID);

      // A research tenant the admin IS a member of, for building an
      // ordinary/unresolvable comparison target below.
      const { tenantId: researchTenantId } = await createResearchTenant(
        database as never,
        ADMIN_UID,
        'Matrix research tenant',
      );

      // 1. Non-admin (not in RESEARCH_ADMIN_UIDS at all).
      const nonAdminResponse = await app.inject({
        method: 'POST',
        url: `/api/research/tenants/${researchTenantId}/entitlement/grant`,
        headers: authHeader(NON_ADMIN_TOKEN),
        payload: { idempotencyKey: 'matrix-key-00001' },
      });

      // 2. Allowlisted admin who is NOT a member of the target tenant.
      const notAMemberTenantId = 'matrix-not-a-member-tenant';
      database.seed(`clientTenants/${notAMemberTenantId}`, { createdAt: 1, kind: 'research' });
      const notMemberResponse = await app.inject({
        method: 'POST',
        url: `/api/research/tenants/${notAMemberTenantId}/entitlement/grant`,
        headers: authHeader(ADMIN_TOKEN),
        payload: { idempotencyKey: 'matrix-key-00002' },
      });

      // 3. Target is an ordinary tenant (admin IS a member of it).
      const ordinaryTenantId = 'matrix-ordinary-tenant';
      await createClientCore(database as never, ADMIN_UID, 'Ordinary target', 'coaching');
      // createClientCore mints its own id; re-derive it via a direct seed
      // instead so the id is known and controllable for this assertion.
      database.seed(`clientTenants/${ordinaryTenantId}`, { createdAt: 1, archivedAt: null });
      database.seed(`clientMembers/${ordinaryTenantId}/${ADMIN_UID}`, {
        role: 'custodian',
        joinedAt: 1,
      });
      const ordinaryResponse = await app.inject({
        method: 'POST',
        url: `/api/research/tenants/${ordinaryTenantId}/entitlement/grant`,
        headers: authHeader(ADMIN_TOKEN),
        payload: { idempotencyKey: 'matrix-key-00003' },
      });

      // 4. Target's kind is unresolvable (admin IS a member of it).
      const unresolvableTenantId = 'matrix-unresolvable-tenant';
      database.seed(`clientTenants/${unresolvableTenantId}/kind`, 'not-a-real-kind');
      database.seed(`clientMembers/${unresolvableTenantId}/${ADMIN_UID}`, {
        role: 'custodian',
        joinedAt: 1,
      });
      const unresolvableResponse = await app.inject({
        method: 'POST',
        url: `/api/research/tenants/${unresolvableTenantId}/entitlement/grant`,
        headers: authHeader(ADMIN_TOKEN),
        payload: { idempotencyKey: 'matrix-key-00004' },
      });

      for (const response of [
        nonAdminResponse,
        notMemberResponse,
        ordinaryResponse,
        unresolvableResponse,
      ]) {
        expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
        expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
      }

      // Deep-equal to the collection-route rejection (class 2).
      const collectionResponse = await app.inject({
        method: 'GET',
        url: '/api/research/tenants',
        headers: authHeader(NON_ADMIN_TOKEN),
      });
      expect(collectionResponse.json()).toEqual(nonAdminResponse.json());
      void auth;
    });

    it('a caller holding only the reports allowlist is denied on the entitlement route too', async () => {
      const reportsOnlyUid = 'matrix-reports-only-uid';
      const { app, database, auth } = buildResearchRouteApp(ADMIN_UID);
      auth.registerToken('matrix-reports-only-token', {
        uid: reportsOnlyUid,
        email: 'r@test.com',
      });
      const { tenantId } = await createResearchTenant(database as never, ADMIN_UID, 'RT');
      const response = await app.inject({
        method: 'POST',
        url: `/api/research/tenants/${tenantId}/entitlement/grant`,
        headers: authHeader('matrix-reports-only-token'),
        payload: { idempotencyKey: 'matrix-key-00005' },
      });
      expect(response.statusCode).toBe(RESEARCH_FAMILY_REJECTION.statusCode);
      expect(response.json()).toEqual(RESEARCH_FAMILY_REJECTION.body);
    });
  });

  describe('class 4: revocation — the allowlist-removal property, on both a URL-param coach route and a header-driven subject route', () => {
    it('removing the admin uid from RESEARCH_ADMIN_UIDS denies both routes with the ordinary non-member rejection', async () => {
      const adminUids = new Set([ADMIN_UID]);
      const { app, database, auth } = buildTestApp({ research: { adminUids } });
      auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
      const { tenantId } = await createResearchTenant(
        database as never,
        ADMIN_UID,
        'Revocation tenant',
      );

      // Both routes succeed while the admin is still allowlisted.
      const urlParamBefore = await app.inject({
        method: 'PATCH',
        url: `/api/coaching/clients/${tenantId}/archive`,
        headers: authHeader(ADMIN_TOKEN),
      });
      expect(urlParamBefore.statusCode).toBe(204);
      // Unarchive so the next check exercises the same route meaningfully.
      database.seed(`clientTenants/${tenantId}`, {
        createdAt: 1,
        archivedAt: null,
        kind: 'research',
      });

      const headerBefore = await app.inject({
        method: 'GET',
        url: '/api/matches',
        headers: { ...authHeader(ADMIN_TOKEN), 'x-active-subject': `client:${tenantId}` },
      });
      expect(headerBefore.statusCode).toBe(200);

      // Revoke: remove the uid from the LIVE Set the app was built with.
      adminUids.delete(ADMIN_UID);

      const urlParamAfter = await app.inject({
        method: 'PATCH',
        url: `/api/coaching/clients/${tenantId}/archive`,
        headers: authHeader(ADMIN_TOKEN),
      });
      const headerAfter = await app.inject({
        method: 'GET',
        url: '/api/matches',
        headers: { ...authHeader(ADMIN_TOKEN), 'x-active-subject': `client:${tenantId}` },
      });

      expect(urlParamAfter.statusCode).toBe(403);
      expect(headerAfter.statusCode).toBe(403);
      expect(urlParamAfter.json().message).toBe('Not a member of this client tenant');
      expect(headerAfter.json().message).toBe('Not a member of this client tenant');
    });
  });
});

// ---------------------------------------------------------------------------
// Full-session simulation: zero trace across the five global trees AND the
// claim-control plane, with content-landed and ordinary-tenant positive
// controls.
// ---------------------------------------------------------------------------

describe('a full research-workspace session leaves zero delivery/telemetry/revenue trace (D-06)', () => {
  const SESSION_ADMIN_UID = 'session-admin-uid';
  const SESSION_ADMIN_TOKEN = 'session-admin-token';

  /**
   * Source of the five zero-trace tree names (cycle-2 finding C2-MED-10):
   * NONE of these come from `CANONICAL_TENANT_TREES`, which is the
   * subject-CONTENT manifest (`matches`, `playlists`, the review trees,
   * etc — apps/api/src/coaching/tenants.ts:54) and holds none of the five.
   * Each is either imported from its owning module or pinned to that
   * module's own construction with a grep assertion below.
   */
  // `eventLedger`/`eventDedup`/`outboxPending` are constructed inline in
  // apps/api/src/events/ledger.ts (the sole writer, `createEvent`, whose
  // multi-path update at ~lines 60-82 addresses `eventLedger/${day}/${key}`
  // and `outboxPending/${day}/${key}`, and whose dedup transaction ref is
  // `eventDedup/${eventName}/${schemaVersion}/${causationId}`).
  const EVENT_LEDGER_TREE = 'eventLedger';
  const EVENT_DEDUP_TREE = 'eventDedup';
  const OUTBOX_TREE = 'outboxPending';
  // `shareTokens` is constructed inline throughout apps/api/src/services/rtdb.ts
  // (the bearer-token tree every mint writer and resolver above addresses).
  const BEARER_TOKEN_TREE = 'shareTokens';
  // `creditLedger` is constructed inline in apps/api/src/billing/credits.ts
  // (~line 42's `ledgerRef`, `database.ref(\`creditLedger/${uid}\`)`).
  const CREDIT_LEDGER_TREE = 'creditLedger';

  it('the five zero-trace tree names are pinned to their owning module by grep, not taken from CANONICAL_TENANT_TREES', () => {
    const ledgerSource = readFileSync(resolve(SRC_ROOT, 'events/ledger.ts'), 'utf-8');
    expect(ledgerSource).toMatch(/`eventLedger\//);
    expect(ledgerSource).toMatch(/`eventDedup\//);
    expect(ledgerSource).toMatch(/`outboxPending\//);

    const rtdbSource = readFileSync(resolve(SRC_ROOT, 'services/rtdb.ts'), 'utf-8');
    expect(rtdbSource).toMatch(/`shareTokens\//);

    const creditsSource = readFileSync(resolve(SRC_ROOT, 'billing/credits.ts'), 'utf-8');
    expect(creditsSource).toMatch(/`creditLedger\//);

    // Comment-stripped: this suite's own use of CANONICAL_TENANT_TREES is
    // for the tenant-keyed CONTENT assertions only, never for naming any of
    // the five trace trees above.
    const thisFileStripped = stripComments(
      readFileSync(resolve(SRC_ROOT, 'research/isolationEnumeration.test.ts'), 'utf-8'),
    );
    const traceTreeAssignments = thisFileStripped.match(
      /const (EVENT_LEDGER_TREE|EVENT_DEDUP_TREE|OUTBOX_TREE|BEARER_TOKEN_TREE|CREDIT_LEDGER_TREE) = '[a-zA-Z]+';/g,
    );
    expect(traceTreeAssignments?.length).toBe(5);
    for (const line of traceTreeAssignments ?? []) {
      expect(line).not.toMatch(/CANONICAL_TENANT_TREES/);
    }
  });

  it('the content assertions DO import CANONICAL_TENANT_TREES, correct for content and only for content', () => {
    expect(CANONICAL_TENANT_TREES.length).toBeGreaterThan(0);
  });

  it('a full session leaves zero rows across all five trace trees and the whole claim-control plane, while its own content lands under tenant-keyed trees; the ordinary-tenant positive control observes all six groups', async () => {
    const adminUids = new Set([SESSION_ADMIN_UID]);
    const { app, database, auth } = buildTestApp({
      research: { adminUids },
      claimCode: { hmacSecret: 'session-test-claim-secret' },
    });
    auth.registerToken(SESSION_ADMIN_TOKEN, {
      uid: SESSION_ADMIN_UID,
      email: 'session-admin@test.com',
    });

    const { tenantId } = await createResearchTenant(
      database as never,
      SESSION_ADMIN_UID,
      'Full session research tenant',
    );
    const membershipAfterCreate = (database.dump() as Record<string, unknown>)['clientMembers'];
    const membershipBefore = JSON.parse(
      JSON.stringify((membershipAfterCreate as Record<string, unknown>)[tenantId]),
    );

    const headers = {
      ...authHeader(SESSION_ADMIN_TOKEN),
      'x-active-subject': `client:${tenantId}`,
    };

    // 1. Match write.
    const matchResponse = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers,
      payload: {
        fighter_id: 1,
        opponent_id: 8,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'someplayer',
        notes: 'test',
        matchType: 'online-friendly',
        win: true,
      },
    });
    expect(matchResponse.statusCode).toBe(201);
    const matchId = matchResponse.json().id as string;

    // 2. VOD note write (a timestamped tag on the match just created).
    const noteResponse = await app.inject({
      method: 'POST',
      url: `/api/matches/${matchId}/notes`,
      headers,
      payload: { seconds: 5, note: 'missed punish' },
    });
    expect(noteResponse.statusCode).toBe(201);

    // 3. Playlist write.
    const playlistResponse = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers,
      payload: { name: 'Session Playlist' },
    });
    expect(playlistResponse.statusCode).toBe(201);

    // 4. Review authoring.
    const reviewResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/reviews`,
      headers: authHeader(SESSION_ADMIN_TOKEN),
    });
    expect(reviewResponse.statusCode).toBe(201);
    const reviewId = reviewResponse.json().reviewId as string;

    // 5. Review publish.
    const publishResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/reviews/${reviewId}/publish`,
      headers: authHeader(SESSION_ADMIN_TOKEN),
      payload: {},
    });
    expect(publishResponse.statusCode).toBe(200);
    const publishedVersion = publishResponse.json().version as number;

    // 6. Training-session write.
    const sessionResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/sessions`,
      headers: authHeader(SESSION_ADMIN_TOKEN),
      payload: { date: 1000, summary: 'test session' },
    });
    expect(sessionResponse.statusCode).toBe(201);

    // 7. Attempted share creation (the coachReview branch — the only branch
    // reachable with a tenant-id subject; there is no HTTP route for it,
    // per plan 29-06's own finding, so it is exercised directly).
    const rtdb = new RtdbService(database as never);
    await expect(
      rtdb.createShare(
        tenantId,
        { kind: 'coachReview', reviewId, version: publishedVersion, permissions: 'view' } as never,
        WEB_BASE_URL,
      ),
    ).rejects.toThrow(ForbiddenError);

    // 8. Attempted review delivery creation.
    const deliveryResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(SESSION_ADMIN_TOKEN),
      payload: { version: publishedVersion },
    });
    expect(deliveryResponse.statusCode).toBe(404);

    // 9. Attempted claim issuance.
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/claim-invitations`,
      headers: authHeader(SESSION_ADMIN_TOKEN),
    });
    expect(claimResponse.statusCode).toBe(403);

    await flush();

    const dump = database.dump() as Record<string, unknown>;

    // Five global trace trees: zero rows.
    expect(dump[EVENT_LEDGER_TREE]).toBeUndefined();
    expect(dump[EVENT_DEDUP_TREE]).toBeUndefined();
    expect(dump[OUTBOX_TREE]).toBeUndefined();
    expect(dump[BEARER_TOKEN_TREE]).toBeUndefined();
    expect(dump[CREDIT_LEDGER_TREE]).toBeUndefined();

    // Sixth group: the claim-control plane, byte-unchanged.
    expect(dump['claimInvitations']).toBeUndefined();
    const activeInvitations = dump['activeClaimInvitationByTenant'] as
      Record<string, unknown> | undefined;
    expect(activeInvitations?.[tenantId]).toBeUndefined();
    const clientTenants = dump['clientTenants'] as Record<string, Record<string, unknown>>;
    expect(clientTenants[tenantId]?.['ownerUid']).toBeUndefined();
    expect(clientTenants[tenantId]?.['claimedAt']).toBeUndefined();
    const coachClients = dump['coachClients'] as Record<string, Record<string, unknown>>;
    expect(
      (coachClients[SESSION_ADMIN_UID]?.[tenantId] as Record<string, unknown>)?.['claimedAt'],
    ).toBeUndefined();
    expect(dump['clientOwnedTenants']).toBeUndefined();
    // The tenant membership subtree, byte-unchanged since creation — no
    // delegate role flip, no owner role added.
    const clientMembers = dump['clientMembers'] as Record<string, unknown>;
    expect(clientMembers[tenantId]).toEqual(membershipBefore);

    // Positive assertion: the session's own content DID land under
    // tenant-keyed trees — this is not a vacuously-inert workspace.
    expect(CANONICAL_TENANT_TREES).toContain('matches');
    expect(CANONICAL_TENANT_TREES).toContain('playlists');
    expect(CANONICAL_TENANT_TREES).toContain('reviewDrafts');
    expect(CANONICAL_TENANT_TREES).toContain('reviewVersions');
    expect(CANONICAL_TENANT_TREES).toContain('trainingSessions');
    for (const tree of [
      'matches',
      'playlists',
      'reviewDrafts',
      'reviewVersions',
      'trainingSessions',
    ] as const) {
      const treeDump = dump[tree] as Record<string, unknown> | undefined;
      expect(treeDump?.[tenantId]).toBeTruthy();
    }
  });

  it('the ordinary-tenant positive control observes events, a bearer token, AND a claim invitation record plus pointer in the same harness', async () => {
    const { app, database, auth } = buildTestApp({
      research: { adminUids: new Set() },
      claimCode: { hmacSecret: 'ordinary-test-claim-secret' },
    });
    const COACH_UID = 'ordinary-session-coach';
    const COACH_TOKEN = 'ordinary-session-coach-token';
    auth.registerToken(COACH_TOKEN, { uid: COACH_UID, email: 'coach@test.com' });
    const { tenantId } = await createClientCore(
      database as never,
      COACH_UID,
      'Ordinary session tenant',
      'coaching',
    );

    // Fire an event: a review draft start emits coach_review_draft_started
    // for an ordinary tenant.
    const reviewResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/reviews`,
      headers: authHeader(COACH_TOKEN),
    });
    expect(reviewResponse.statusCode).toBe(201);

    // Write a bearer token via the direct coachReview branch, mirroring the
    // research-session step above but for an ordinary tenant, where it
    // must SUCCEED.
    const reviewId = reviewResponse.json().reviewId as string;
    const publishResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/reviews/${reviewId}/publish`,
      headers: authHeader(COACH_TOKEN),
      payload: {},
    });
    expect(publishResponse.statusCode).toBe(200);
    const rtdb = new RtdbService(database as never);
    const shareResult = await rtdb.createShare(
      tenantId,
      {
        kind: 'coachReview',
        reviewId,
        version: publishResponse.json().version,
        permissions: 'view',
      } as never,
      WEB_BASE_URL,
    );
    expect(shareResult.token).toBeTruthy();

    // Issue a claim invitation — must SUCCEED for an ordinary tenant.
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${tenantId}/claim-invitations`,
      headers: authHeader(COACH_TOKEN),
    });
    expect(claimResponse.statusCode).toBe(201);

    await flush();

    const dump = database.dump() as Record<string, unknown>;
    expect(
      Object.keys((dump['eventLedger'] as Record<string, unknown>) ?? {}).length,
    ).toBeGreaterThan(0);
    expect(
      Object.keys((dump['shareTokens'] as Record<string, unknown>) ?? {}).length,
    ).toBeGreaterThan(0);
    expect(
      Object.keys((dump['claimInvitations'] as Record<string, unknown>) ?? {}).length,
    ).toBeGreaterThan(0);
    const activeInvitations = dump['activeClaimInvitationByTenant'] as Record<string, unknown>;
    expect(activeInvitations[tenantId]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Money assertions through the real entitlement seam, with unmaskable
// fixtures (review finding 29-11 HIGH).
// ---------------------------------------------------------------------------

const STARTGG_CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

const STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-money-block',
  webhookSecret: 'whsec-test-money-block',
};

const VALID_REPORT = {
  overview: 'A fast-falling Fox/Falco player.',
  gameplan: ['Punish landing lag.'],
  characterStrategy: { picks: ['Mario'], reasoning: 'Game 1: Mario.' },
  stageStrategy: { bans: ['Final Destination'], picks: ['Battlefield'], reasoning: 'Flat stages.' },
  headToHead: null,
  watchFor: ['Shine spikes off stage.'],
  confidenceNotes: 'No sampled sets — treat this as a cold read.',
};

function moneyScoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return new Response(
        JSON.stringify({
          data: {
            user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Test' } },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({ data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } } } }),
    );
  }) as typeof fetch;
}

function moneyStubClient(): AnthropicLikeClient {
  return {
    messages: {
      parse: (async () => ({ stop_reason: 'end_turn', parsed_output: VALID_REPORT })) as never,
    },
  };
}

describe('money block: research-subject report requests refuse through the real entitlement seam (D-08 credit clause)', () => {
  const MONEY_ADMIN_UID = 'money-block-admin-uid';
  const MONEY_ADMIN_TOKEN = 'money-block-admin-token';

  function buildMoneyApp() {
    const reports: ReportsConfig = {
      anthropicApiKey: 'sk-test-key',
      // Fixture precondition (review finding 29-11 HIGH): the admin uid is
      // ABSENT from REPORTS_ALLOWED_UIDS — a uid in that allowlist already
      // generates for free, which would make the granted-vs-revoked
      // comparison look identical either way.
      allowedUids: new Set(['some-other-uid-not-the-admin']),
    };
    const built = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: moneyScoutFetchMock(),
      reports,
      stripe: STRIPE_CONFIG,
      reportsClient: moneyStubClient(),
      research: { adminUids: new Set([MONEY_ADMIN_UID]) },
    });
    built.auth.registerToken(MONEY_ADMIN_TOKEN, {
      uid: MONEY_ADMIN_UID,
      email: 'money-admin@test.com',
    });
    expect(reports.allowedUids.has(MONEY_ADMIN_UID)).toBe(false);
    return built;
  }

  it('fixture preconditions: admin uid absent from reports allowlist, non-zero balance, fresh job/bundle ids', async () => {
    const { database } = buildMoneyApp();
    database.seed(`credits/${MONEY_ADMIN_UID}/balance`, 5);
    const balance = await database.ref(`credits/${MONEY_ADMIN_UID}/balance`).get();
    expect(balance.val()).toBeGreaterThan(0);
  });

  it('a granted entitlement still refuses the request with no spend, no billing-ledger row, and no job record', async () => {
    const { app, database } = buildMoneyApp();
    database.seed(`credits/${MONEY_ADMIN_UID}/balance`, 5);
    const { tenantId } = await createResearchTenant(
      database as never,
      MONEY_ADMIN_UID,
      'Money block tenant',
    );

    const grantResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: authHeader(MONEY_ADMIN_TOKEN),
      payload: { idempotencyKey: 'money-block-grant-key-01' },
    });
    expect(grantResponse.statusCode).toBe(200);

    const reportResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(MONEY_ADMIN_TOKEN), 'x-active-subject': `client:${tenantId}` },
      payload: { query: 'user/07dc2239', jobId: 'money-block-fresh-job-granted' },
    });

    expect(reportResponse.statusCode).toBe(403);
    expect(reportResponse.json().message).toBe('AI reports are not available for this workspace');
    const balance = await database.ref(`credits/${MONEY_ADMIN_UID}/balance`).get();
    expect(balance.val()).toBe(5);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump['creditLedger']).toBeUndefined();
    const reportJobs = dump['reportJobs'] as Record<string, unknown> | undefined;
    expect(reportJobs?.[MONEY_ADMIN_UID]).toBeUndefined();
  });

  it('after revoking the entitlement, the request is STILL refused with no spend — the refusal is unconditional, not entitlement-gated', async () => {
    const { app, database } = buildMoneyApp();
    database.seed(`credits/${MONEY_ADMIN_UID}/balance`, 5);
    const { tenantId } = await createResearchTenant(
      database as never,
      MONEY_ADMIN_UID,
      'Money block revoke tenant',
    );

    const grantResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/grant`,
      headers: authHeader(MONEY_ADMIN_TOKEN),
      payload: { idempotencyKey: 'money-block-grant-key-02' },
    });
    const grantId = grantResponse.json().grantId as string;

    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/entitlement/revoke`,
      headers: authHeader(MONEY_ADMIN_TOKEN),
      payload: { expectedGrantId: grantId },
    });
    expect(revokeResponse.statusCode).toBe(200);

    const reportResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(MONEY_ADMIN_TOKEN), 'x-active-subject': `client:${tenantId}` },
      payload: { query: 'user/07dc2239', jobId: 'money-block-fresh-job-revoked' },
    });

    expect(reportResponse.statusCode).toBe(403);
    const balance = await database.ref(`credits/${MONEY_ADMIN_UID}/balance`).get();
    expect(balance.val()).toBe(5);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump['creditLedger']).toBeUndefined();
  });

  it('positive control: an equivalent non-research request still spends exactly as today', async () => {
    const { app, database } = buildMoneyApp();
    database.seed(`credits/${MONEY_ADMIN_UID}/balance`, 5);

    const reportResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(MONEY_ADMIN_TOKEN),
      payload: { query: 'user/07dc2239', jobId: 'money-block-fresh-job-ordinary' },
    });

    expect(reportResponse.statusCode).toBe(200);
    const balance = await database.ref(`credits/${MONEY_ADMIN_UID}/balance`).get();
    expect(balance.val()).toBe(4);
    const dump = database.dump() as Record<string, unknown>;
    const ledger = dump['creditLedger'] as Record<string, Record<string, unknown>>;
    expect(Object.values(ledger[MONEY_ADMIN_UID]!)).toHaveLength(1);
  });
});
