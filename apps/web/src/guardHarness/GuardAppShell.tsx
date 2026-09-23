import type { ReactNode } from 'react';

/**
 * Plan 39.1-30 (T-39.1-30-01/T-39.1-30-03): a MainLayout-geometry wrapper for
 * the layout-oracle harness, opted into by routes whose `GuardHarnessRouteEntry`
 * carries `shell: 'app'` (Matchups only, this plan). The harness's default
 * mount (`main.tsx`, unwrapped) measures a route's content at the RAW viewport
 * width, but production always renders inside `MainLayout`'s 256px sidebar +
 * `main.flex-1.p-4.sm:p-6` gutter — so at 1024px the harness's own 1024px is
 * production's ~1330px content width, and the oracle would be measuring a
 * width the real page never renders at. This file reproduces exactly the
 * geometry — never the real components — so no auth, no real Topbar/Sidebar,
 * no Firebase.
 *
 * Geometry ported from (never imported from, this is a harness-only file
 * under `src/guardHarness/`, excluded from the production build per
 * `guardHarnessProductionBuild.guard.test.ts`):
 *   - `apps/web/src/layouts/MainLayout.tsx` ~95-108: a 56px (`h-14`) topbar
 *     row, then a flex row of the sidebar `aside` and a
 *     `flex min-w-0 flex-1 flex-col` column holding `main.flex-1.p-4.sm:p-6`.
 *   - `apps/web/src/layouts/Sidebar.tsx` ~47-57: the EXPANDED (stored
 *     default) sidebar is `hidden lg:block w-64 shrink-0 border-r`.
 *
 * Plain `aria-hidden` placeholder blocks stand in for Topbar/Sidebar content
 * — their own internals (nav links, profile block) contribute no width or
 * height this oracle measures; only the geometry (widths, the topbar's
 * height) matters for content-width fidelity.
 */
export function GuardAppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <div
        aria-hidden="true"
        className="h-14 shrink-0 border-b"
        data-slot="guard-app-shell-topbar"
      />
      <div className="flex flex-1">
        <aside
          aria-hidden="true"
          className="hidden w-64 shrink-0 border-r lg:block"
          data-slot="guard-app-shell-sidebar"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
