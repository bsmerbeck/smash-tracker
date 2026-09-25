import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * D-14 (38-UI-SPEC.md "Uniform Drillable-Row Contract") / plan 38-07 Task 1:
 * the ONE clickable-analytics-row affordance every retrofitted surface uses,
 * so the app has one "this row does something" grammar rather than eight.
 * `noInertRow.test.tsx` (plan 38-07 Task 3) is the committed oracle that
 * checks every named surface actually uses this contract (or a documented
 * exemption).
 *
 * A row is EITHER a navigation (`to`, rendered as a real `<Link>`) or an
 * in-page action (`onActivate`, rendered as a real `<button type="button">`)
 * — never both. Typed as a discriminated union so passing both is a TypeScript
 * compile error (see `DrillableRow.test.tsx`'s type-level check). `expanded`
 * is set only by a row that toggles an inline panel rather than navigating
 * (adds `aria-expanded` to the interactive element) — never combined with
 * `to`, since a navigating row cannot also be "expanded".
 *
 * Two render shapes, chosen by `as` (default `'content'`):
 * - `'content'` (list/card-wrapper hosts, e.g. a `<li>` row): DrillableRow
 *   renders the interactive element itself WRAPPING `children` plus the
 *   trailing chevron — the host places this as its row's sole content.
 * - `'overlay'` (table-row hosts, e.g. `<tr>`/`<td>`): a `<tr>` cannot be
 *   nested inside an `<a>`/`<button>` without breaking table semantics, so
 *   DrillableRow instead renders ONLY an invisible, absolutely-positioned
 *   interactive element covering the row — the same "whole row is one hit
 *   target" technique `FilteredMatchList.tsx` already uses for its VOD/expand
 *   row. The host places this as the first thing inside its first
 *   `<TableCell>` (with `position: relative` on the `<TableRow>`), renders
 *   its own `<TableCell>`s normally (children are unused in this mode), and
 *   renders the trailing chevron itself via the `DrillableRowChevron` export
 *   in whichever cell it belongs.
 *
 * Hover uses the SAME `hover:bg-accent` class `OpponentList`'s existing
 * selectable row already uses, and focus-visible uses the SAME token set as
 * the Matchups matrix cell's focus ring — one hover language and one focus
 * recipe for every clickable analytics element this phase touches. No
 * visible border change at rest: the chevron alone signals interactivity.
 */
export type DrillableRowActivation =
  { to: string; onActivate?: undefined } | { to?: undefined; onActivate: () => void };

export type DrillableRowProps = DrillableRowActivation & {
  children?: ReactNode;
  /** Non-empty accessible name — follows the "{{subject}} — {{context}}, opens details" pattern (`shared.drillableRow.aria`). */
  ariaLabel: string;
  /** Set only for a row that toggles an inline panel rather than navigating. */
  expanded?: boolean;
  className?: string;
  as?: 'content' | 'overlay';
};

/** Tokens shared by the "at rest"/hover/focus-visible contract, so every retrofitted row activates and looks identical. */
const INTERACTIVE_TOKENS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const CONTENT_CLASSES = cn(
  'flex min-w-0 items-center justify-between gap-2 rounded-md py-2 text-left hover:bg-accent',
  INTERACTIVE_TOKENS,
);

const OVERLAY_CLASSES = cn('absolute inset-0', INTERACTIVE_TOKENS);

/**
 * The always-visible trailing chevron (`lucide-react`'s `ChevronRight`,
 * `size-4 text-muted-foreground`) — never a hover-only reveal, which is
 * invisible on touch and fails discoverability. `shrink-0` so it never
 * shrinks; pair it with a `truncate` label so the chevron stays inside the
 * row's hit area at narrow widths. Exported separately so an `as="overlay"`
 * host can place it in its own last cell alongside the invisible overlay.
 */
export function DrillableRowChevron({ className }: { className?: string }) {
  return (
    <ChevronRight
      className={cn('size-4 shrink-0 text-muted-foreground', className)}
      aria-hidden="true"
    />
  );
}

export function DrillableRow(props: DrillableRowProps) {
  const { children, ariaLabel, expanded, className, as = 'content', to, onActivate } = props;

  if (as === 'overlay') {
    if (to != null) {
      return <Link to={to} aria-label={ariaLabel} className={cn(OVERLAY_CLASSES, className)} />;
    }
    return (
      <button
        type="button"
        onClick={onActivate}
        aria-label={ariaLabel}
        aria-expanded={expanded}
        className={cn(OVERLAY_CLASSES, className)}
      />
    );
  }

  if (to != null) {
    return (
      <Link to={to} aria-label={ariaLabel} className={cn(CONTENT_CLASSES, className)}>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        <DrillableRowChevron />
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      className={cn(CONTENT_CLASSES, className)}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DrillableRowChevron />
    </button>
  );
}

/**
 * The unaddressable-target companion (D-14's per-row exemptions): plain
 * text, NO chevron, no link/button semantics — what a host renders instead
 * of `DrillableRow` when a row's target cannot be identified (the
 * unnamed-opponent bucket, an unknown stage, an unknown character). Lets a
 * host express "this row has no destination" positively instead of by
 * omission, and is what `noInertRow.test.tsx`'s exemption predicates check
 * against.
 */
export function DrillableRowStatic({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={className}>{children}</span>;
}
