import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARD_HARNESS_ROUTES, findGuardHarnessRoute } from './guardHarnessRoutes';

/**
 * Plan 39.1-20 Task 3 (review finding C1-H4): asserts the harness route
 * table's shape directly over the exported array, rather than only via the
 * `ROUTE_TABLE_OK` grep-based `<verify>` command — nine entries (the eight
 * real analytics routes plus plan 39.1-09's stretch fixture route), each
 * carrying a non-empty `path`, `initialEntry` and `loadedMarker`, and the
 * two path-parameterized routes (`opponent-hub`, `stage-detail`) carrying a
 * CONCRETE value in `initialEntry`, never the raw `:param` placeholder.
 */
describe('guardHarnessRoutes — the harness route table (plan 39.1-20 Task 3)', () => {
  // REWRITTEN by plan 39.1-51 (was sixteen): the three `*-games` drill routes
  // (OOS-8) make the drill-only results-list hosts measurable — the count rises
  // by exactly three.
  it('has exactly nineteen entries: the eight real analytics routes, the trends-career, trends-casual, dashboard-app and stage-detail-recent oracle routes, the stretch and period-axis fixture routes, the gsp route, (plan 39.1-49) the scout route and (plan 39.1-51) the fighter-analysis-games, match-data-games and trends-games drill routes', () => {
    expect(GUARD_HARNESS_ROUTES).toHaveLength(19);
  });

  // Plan 39.1-51 (OOS-8): the drill-only results-list hosts, drilled with
  // `?from=1` (every game) at the base route's path, in the app shell.
  it.each([
    ['fighter-analysis-games', '/fighter-analysis'],
    ['match-data-games', '/match-data'],
    ['trends-games', '/trends'],
  ])(
    'plan 39.1-51: %s mounts its base page at %s?from=1 in the app shell with the results-list loaded marker',
    (id, basePath) => {
      const route = findGuardHarnessRoute(id);
      const base = GUARD_HARNESS_ROUTES.find((r) => r.path === basePath && r.id !== id);
      expect(route?.path).toBe(basePath);
      expect(route?.initialEntry).toBe(`${basePath}?from=1`);
      expect(route?.shell).toBe('app');
      expect(route?.loadedMarker).toBe('[data-slot="filtered-match-list"] [data-total-rows]');
      expect(base).toBeDefined();
      expect((route?.element as { type?: unknown } | undefined)?.type).toBe(
        (base?.element as { type?: unknown } | undefined)?.type,
      );
    },
  );

  // Plan 39.1-49: the Scout page joins the harness so the all-route
  // table-clip sweep can measure its three multi-host tables.
  it('plan 39.1-49: the scout route mounts ScoutPage at /scout, unshelled, with the expanded Full analysis marker', () => {
    const scout = findGuardHarnessRoute('scout');
    expect(scout?.path).toBe('/scout');
    expect(scout?.initialEntry).toBe('/scout');
    expect(scout?.shell).toBeUndefined();
    expect(scout?.loadedMarker).toBe('[data-slot="scout-full-analysis"][data-state="open"]');
    expect(scout?.element).toBeTruthy();
  });

  // Plan 39.1-39 (mark-count): the stage page on the harness's recent scale.
  it('plan 39.1-39: stage-detail-recent mounts the stage page at /stages/1 in the app shell with the stage loaded marker', () => {
    const recent = findGuardHarnessRoute('stage-detail-recent');
    expect(recent?.path).toBe('/stages/:stageId');
    expect(recent?.initialEntry).toBe('/stages/1');
    expect(recent?.shell).toBe('app');
    expect(recent?.loadedMarker).toBe('[data-slot="stage-detail-body"]');
  });

  // Plan 39.1-39 (record-fit): the Dashboard measured inside the production-
  // geometry shell, where 39.1-36's capture saw the split records overprint.
  it('plan 39.1-39: dashboard-app mounts the Dashboard at /dashboard in the app shell with the dashboard loaded marker', () => {
    const app = findGuardHarnessRoute('dashboard-app');
    expect(app?.path).toBe('/dashboard');
    expect(app?.initialEntry).toBe('/dashboard');
    expect(app?.shell).toBe('app');
    expect(app?.loadedMarker).toBe('[data-slot="dashboard-body"]');
  });

  it('CR-01: carries the period-axis tick fixture route', () => {
    expect(findGuardHarnessRoute('period-axis-ticks-fixture')?.loadedMarker).toBe(
      '[data-guard-loaded="period-axis-ticks-fixture"]',
    );
  });

  it('every entry carries a non-empty path, initialEntry, element and loadedMarker', () => {
    for (const route of GUARD_HARNESS_ROUTES) {
      expect(route.id.length).toBeGreaterThan(0);
      expect(route.path.length).toBeGreaterThan(0);
      expect(route.initialEntry.length).toBeGreaterThan(0);
      expect(route.loadedMarker.length).toBeGreaterThan(0);
      expect(route.element).toBeTruthy();
    }
  });

  it('the eight real analytics route ids are all present', () => {
    const ids = GUARD_HARNESS_ROUTES.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'dashboard',
        'fighter-analysis',
        'matchups',
        'match-data',
        'trends',
        'trends-career',
        'opponents',
        'opponent-hub',
        'stage-detail',
      ]),
    );
  });

  it('the two path-parameterized routes substitute a concrete value, never the raw :param placeholder', () => {
    const opponentHub = GUARD_HARNESS_ROUTES.find((r) => r.id === 'opponent-hub')!;
    const stageDetail = GUARD_HARNESS_ROUTES.find((r) => r.id === 'stage-detail')!;
    expect(opponentHub.path).toBe('/opponents/:opponentTag');
    expect(opponentHub.initialEntry).not.toMatch(/:opponentTag/);
    expect(stageDetail.path).toBe('/stages/:stageId');
    expect(stageDetail.initialEntry).not.toMatch(/:stageId/);
  });

  it('findGuardHarnessRoute resolves every declared id and returns undefined for an unknown one', () => {
    for (const route of GUARD_HARNESS_ROUTES) {
      expect(findGuardHarnessRoute(route.id)?.id).toBe(route.id);
    }
    expect(findGuardHarnessRoute('not-a-real-route')).toBeUndefined();
    expect(findGuardHarnessRoute(null)).toBeUndefined();
  });

  // REWRITTEN by plan 39.1-51: the three `*-games` drill routes join the shell.
  it('plans 39.1-30/34/35/39/51: exactly the matchups, trends-career, trends-casual, dashboard-app, stage-detail-recent, gsp and three *-games entries opt into the MainLayout-geometry app shell', () => {
    const shelled = GUARD_HARNESS_ROUTES.filter((r) => r.shell === 'app');
    expect(shelled.map((r) => r.id).sort()).toEqual([
      'dashboard-app',
      'fighter-analysis-games',
      'gsp',
      'match-data-games',
      'matchups',
      'stage-detail-recent',
      'trends-career',
      'trends-casual',
      'trends-games',
    ]);
  });

  // Plan 39.1-39 (OWNER DECISION 2026-09-25) made gsp a capture-only route.
  // REWRITTEN by plan 39.1-49 (orchestrator 2026-09-26): OOS-9 (the GspHero
  // figures leave their cards at 390) needs a committed failing oracle, and a
  // capture is not one — so gsp is now a guard:layout route at 390x844 only,
  // on the harness's seeded gsp scale.
  it('plan 39.1-49: the gsp route mounts the GSP page at /gsp in the app shell, and guard:layout declares it at 390x844 on the gsp scale', () => {
    const gsp = findGuardHarnessRoute('gsp');
    expect(gsp?.path).toBe('/gsp');
    expect(gsp?.initialEntry).toBe('/gsp');
    expect(gsp?.shell).toBe('app');
    expect(gsp?.loadedMarker).toBe('[data-slot="gsp-body"]');
    const oracleSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/guardLayout.mjs'),
      'utf8',
    );
    const oracleBlock = oracleSource.slice(
      oracleSource.indexOf('export const LAYOUT_ORACLE_ROUTES'),
      oracleSource.indexOf('const HARD_TIMEOUT_MS'),
    );
    expect(oracleBlock.length).toBeGreaterThan(1000);
    expect(oracleBlock).toMatch(/id: 'stage-detail'/);
    expect(oracleBlock).toMatch(/id: 'gsp'/);
    const gspBlock = oracleBlock.slice(oracleBlock.indexOf("id: 'gsp'"));
    expect(gspBlock).toMatch(/scale: 'gsp'/);
    expect(gspBlock).toMatch(/viewports: \['390x844'\]/);
  });

  it('plan 39.1-35: trends-casual mounts the Trends page at its real path with the trends loaded marker', () => {
    const casual = findGuardHarnessRoute('trends-casual');
    expect(casual?.path).toBe('/trends');
    expect(casual?.initialEntry).toBe('/trends');
    expect(casual?.loadedMarker).toBe('[data-slot="trends-hero-body"]');
  });

  it('plan 39.1-34: trends-career mounts the Trends page at its real path with the trends loaded marker', () => {
    const career = findGuardHarnessRoute('trends-career');
    expect(career?.path).toBe('/trends');
    expect(career?.initialEntry).toBe('/trends');
    expect(career?.loadedMarker).toBe('[data-slot="trends-hero-body"]');
  });
});
