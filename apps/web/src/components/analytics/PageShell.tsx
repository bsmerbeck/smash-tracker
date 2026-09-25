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
 */
export function PageShell({ filterRow, children }: PageShellProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {filterRow}
      {children}
    </div>
  );
}
