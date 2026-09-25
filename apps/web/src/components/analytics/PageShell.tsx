import type { ReactNode } from 'react';

export interface PageShellProps {
  /** The single filter row (UI-SPEC §10.4) — always the first thing on the page. */
  filterRow?: ReactNode;
  children: ReactNode;
}

/**
 * The page container primitive (UIX-01). Renders inside `MainLayout`'s
 * existing `<main className="flex-1 p-4 sm:p-6">` gutter — `MainLayout.tsx`
 * is NOT edited by this plan (UI-SPEC §6.1). `PageShell` composes with that
 * gutter, it never replaces it: it is the first child rendered inside it.
 * Caps content at 1440px so ultra-wide monitors get margin, not 1,900px
 * charts. Declares no height of its own.
 *
 * Plan 39.1-38: also the NAMED inline-size container `page` — the sketches'
 * `@container vp` viewport container — that StatRow's two-column collapse
 * and Fighter Analysis' vs-list pair key on (`@max-[860px]/page:` /
 * `@min-[860px]/page:`). No fixed-position element renders inside a PageShell
 * (checked by grep in 39.1-38-SUMMARY), so the containment changes no fixed
 * descendant's containing block; Radix portals render to `body`.
 */
export function PageShell({ filterRow, children }: PageShellProps) {
  return (
    <div
      data-slot="page-shell"
      className="@container/page mx-auto flex w-full max-w-[1440px] flex-col gap-6"
    >
      {filterRow}
      {children}
    </div>
  );
}
