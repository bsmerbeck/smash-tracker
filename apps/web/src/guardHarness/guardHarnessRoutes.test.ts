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
  it('has exactly nine entries: the eight real analytics routes plus the stretch fixture route', () => {
    expect(GUARD_HARNESS_ROUTES).toHaveLength(9);
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

  it('plan 39.1-30: only the matchups entry opts into the MainLayout-geometry app shell', () => {
    const shelled = GUARD_HARNESS_ROUTES.filter((r) => r.shell === 'app');
    expect(shelled).toHaveLength(1);
    expect(shelled[0]!.id).toBe('matchups');
  });
});
