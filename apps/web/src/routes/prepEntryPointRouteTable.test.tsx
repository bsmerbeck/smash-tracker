import { describe, expect, it } from 'vitest';
import { renderSubjectAnalyticsRoutes } from './subjectAnalyticsRoutes';

/**
 * Plan 39-12 (PREP-05, D-10, review C1-M5): the route-table half of the
 * own-account-only contract. The dashboard and the opponent hub ARE mounted
 * under the coach and workspace prefixes (`AppRouter.tsx` renders
 * `renderSubjectAnalyticsRoutes()` inside both subject layouts), which is why
 * `DashboardPrepActionSlot` and `HubPrepBriefCard` each carry a runtime thin
 * gate. Tournament detail and the prep page are NOT in that list, so they are
 * unreachable under a coach or workspace prefix by construction — this test
 * is what stands in for a runtime gate on the tournaments family. Asserted
 * through the EXPORTED renderer and each element's `props.path`; the
 * descriptor list itself stays module-private.
 */
function subjectMountedPaths(): string[] {
  return renderSubjectAnalyticsRoutes().map((element) => {
    const props = element.props as { path?: unknown };
    return String(props.path);
  });
}

describe('prep entry points vs the subject-mounted route table (D-10)', () => {
  it('reads a non-empty path set from the exported renderer', () => {
    expect(subjectMountedPaths().length).toBeGreaterThan(0);
  });

  it('mounts the dashboard and the opponent hub under every subject family (so both need a runtime gate)', () => {
    const paths = subjectMountedPaths();
    expect(paths).toContain('dashboard');
    expect(paths).toContain('opponents/:opponentTag');
  });

  it('never mounts a tournaments or prep path under a subject family (tournament detail and the prep page stay uid-only)', () => {
    for (const path of subjectMountedPaths()) {
      expect(path).not.toMatch(/tournament/i);
      expect(path).not.toMatch(/(^|\/)prep($|\/)/);
    }
  });
});
