import type { ReactNode } from 'react';

export interface PageFilterRowProps {
  /** The page title — rendered as the page's one `h1`, on the `figure` role (20px / 600). */
  title?: string;
  /** The page's picker(s), after the title. */
  leading?: ReactNode;
  /** Right-aligned after the spacer — the HorizonSwitch. */
  trailing?: ReactNode;
}

/**
 * Plan 39.1-38 (design-audit item 6 / P5; UI-SPEC §6.1, §10.4; sketch 001-C /
 * 002-C `.filters`): the ONE unboxed page filter row — title, picker(s), a
 * spacer, the HorizonSwitch. No Card, border, background or padding of its
 * own: the page opens on content, not chrome. Range and source stay in the
 * app Topbar (`AnalyticsFilterControls`), never duplicated here. Strings
 * arrive as props.
 */
export function PageFilterRow({ title, leading, trailing }: PageFilterRowProps) {
  return (
    <div data-slot="page-filter-row" className="flex flex-wrap items-end gap-x-4 gap-y-2">
      {title !== undefined && (
        <h1 className="text-xl leading-6 font-semibold tracking-tight">{title}</h1>
      )}
      {leading}
      <span aria-hidden="true" className="flex-1" />
      {trailing}
    </div>
  );
}
