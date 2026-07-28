import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Quick 260726-r5 (Phase 24 gap 1/gap 2 constraint verification): a
 * content-based grep-gate confirming this quick task never touched the
 * three explicitly protected coach-chrome surfaces named in its own hard
 * constraints (mirroring Phase 24 CONTEXT.md Area 4.1's binding owner
 * decision) — `useActiveSubject.ts`, `CoachingModeGate.tsx`, and
 * `ClientWorkspaceLayout.tsx` (the `/coach/:clientId` route's own layout).
 * Gap 1's new zone-switcher entry point lives entirely in `Topbar.tsx`/
 * `OwnerWorkspaceChip.tsx`; Gap 2's coach-eviction hook is mounted from
 * `MainLayout.tsx` and reads (never writes) `useActiveSubject()`. None of
 * that work needed to add a workspace/tenant import into any of the three
 * files below — this test fails loudly if a future change accidentally
 * couples them.
 *
 * A content check rather than a `git diff`, so it stays meaningful
 * regardless of which commit or worktree it runs from.
 */
describe('coach chrome integrity (Quick 260726-r5)', () => {
  it('useActiveSubject.ts stays route-derived only — no client-owned-workspace coupling', () => {
    const source = readFileSync(resolve('src/hooks/useActiveSubject.ts'), 'utf-8');
    expect(source).toContain('export function useActiveSubject(): ActiveSubject {');
    expect(source).toContain(
      "location.pathname === '/coach' || location.pathname.startsWith('/coach/')",
    );
    expect(source).not.toContain('useOwnedWorkspaceSubject');
    expect(source).not.toContain('useClientWorkspaces');
    expect(source).not.toContain('tenantId');
  });

  it('CoachingModeGate.tsx stays the opt-in profile gate — untouched by the client-owned workspace family', () => {
    const source = readFileSync(resolve('src/pages/Coaching/CoachingModeGate.tsx'), 'utf-8');
    expect(source).toContain(
      'export function CoachingModeGate({ children }: { children: ReactNode }) {',
    );
    expect(source).toContain('profile?.coachingModeEnabled !== true');
    expect(source).not.toContain('useOwnedWorkspaceSubject');
    expect(source).not.toContain('useClientWorkspaces');
    expect(source).not.toContain('tenantId');
  });

  it('ClientWorkspaceLayout.tsx (the /coach/:clientId route layout) stays untouched by the Gap 2 ejection fix', () => {
    const source = readFileSync(resolve('src/pages/Coaching/ClientWorkspaceLayout.tsx'), 'utf-8');
    expect(source).toContain('export function ClientWorkspaceLayout() {');
    expect(source).not.toContain('useCoachAccessEjection');
    expect(source).not.toContain('QueryCache');
    expect(source).not.toContain('getQueryCache');
  });
});
