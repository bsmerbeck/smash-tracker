import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Literal per-count lookups, never a template-interpolated class name.
 * A gapped CSS grid — never `flex justify-evenly`/`justify-around`
 * (§13.3's banned idiom) — because a grid with a gap cannot collide. This is
 * the fix for the owner's note 3, "Wins Losses Total Matchups - garbage
 * spacing".
 */
const COLUMN_CLASSES: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
};

/** Column 1 widened to `minmax(0, 1.5fr)` for the lead figure; every other column stays `minmax(0, 1fr)`. */
const LEAD_COLUMN_CLASSES: Record<number, string> = {
  2: 'grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]',
  3: 'grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(0,1fr))]',
  4: 'grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]',
  5: 'grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]',
};

export interface StatRowProps {
  /** Rendered in the given order (lead first) — never re-ordered, 2..5 figures. */
  figures: ReactNode[];
  /** Widens column 1 to `minmax(0, 1.5fr)` for the lead figure. */
  leadWidth?: boolean;
  /**
   * Plan 39.1-32 (item 10, UI-SPEC §7.3): keeps the N columns at EVERY
   * container width — for up to 3 non-lead figures only, where the 860px
   * two-column collapse below would leave a 2+1 orphan (e.g. Matchup
   * Insights' three short streak counts). Ignored with more than 3 figures
   * or with `leadWidth` (the lead-figure spanning behaviour needs the
   * collapse). Absent, every existing caller is byte-unchanged apart from
   * the `data-slot` this component now always carries.
   */
  fixedColumns?: boolean;
  /**
   * Plan 39.1-38: sketch 002-C's KPI row only (`.statrow.kpi .lead{grid-column:
   * 1/-1}`) — under the phone collapse the lead figure spans both columns and
   * the row carries `data-lead-span`. Every other row collapses to a PLAIN
   * two-column grid (sketches 001-C / 003-A draw a 2 x 2 with no spanning lead).
   */
  leadSpanOnPhone?: boolean;
  className?: string;
}

/**
 * The one stat idiom (UIX-04). Below an 860px PAGE container (PageShell's
 * named `@container/page`, the sketches' `@container vp`) it collapses to a
 * plain two-column grid (plan 39.1-38).
 *
 * Root cause of the 39.1 phone defect (real Chrome, 39.1-38-SUMMARY): the row
 * used to be its own `@container`, and an element never queries itself — its
 * `@max-[860px]:grid-cols-2` resolved against ancestors (none were
 * containers) and never applied, while the first-child span resolved against
 * the row and did, so the lead spanned two tracks of the UN-collapsed
 * template (3-up then "90 DAYS" alone). Precedence: the collapse is a variant
 * rule, which Tailwind emits after the N-column base utilities, and the named
 * query cannot match outside a PageShell — so a StatRow with no `page`
 * ancestor keeps its N columns.
 */
export function StatRow({
  figures,
  leadWidth = false,
  fixedColumns = false,
  leadSpanOnPhone = false,
  className,
}: StatRowProps) {
  const count = figures.length;
  const columnClass =
    (leadWidth ? LEAD_COLUMN_CLASSES[count] : COLUMN_CLASSES[count]) ?? 'grid-cols-2';
  const applyFixedColumns = fixedColumns && !leadWidth && count <= 3;
  const applyLeadSpan = leadSpanOnPhone && !applyFixedColumns;

  return (
    <div
      data-slot="stat-row"
      data-fixed-columns={applyFixedColumns ? '' : undefined}
      data-lead-span={applyLeadSpan ? '' : undefined}
      className={cn(
        '@container grid items-start gap-x-6 gap-y-3',
        applyFixedColumns
          ? // A long label (e.g. de "Niederlagenserie") wraps inside its own
            // column instead of overflowing it — both properties are
            // inherited, so StatFigure's label/value text picks them up
            // with no change there.
            'hyphens-auto break-words'
          : '@max-[860px]/page:grid-cols-2',
        columnClass,
        applyLeadSpan && '@max-[860px]/page:[&>*:first-child]:col-span-2',
        className,
      )}
    >
      {figures}
    </div>
  );
}

export type StatFigureState = 'populated' | 'collapsed' | 'thinRecent' | 'none' | 'empty';

export interface StatFigureProps {
  /** `overline` role. */
  label: string;
  /** Present for every state except `empty`, which always renders an em dash instead. */
  value?: ReactNode;
  /** Muted unit suffix, e.g. `±72` — `body` role at weight 500. */
  unitSuffix?: string;
  /** `figure-lg` role instead of `figure` when true. */
  lead?: boolean;
  /** `meta` role — a `<Record>` or a date/caption. */
  support?: ReactNode;
  /** Typically a `<DeltaChip>`. */
  delta?: ReactNode;
  state?: StatFigureState;
  /** Rendered instead of `value`/`support` in the `empty` state — the "unlock" caption. */
  emptyCaption?: ReactNode;
  /** Turns the figure into a focusable `<button aria-pressed>` (the hero's horizon figures). */
  onSelect?: () => void;
  pressed?: boolean;
  className?: string;
}

/**
 * The one stat idiom's figure (UIX-04). The empty state NEVER renders a bare
 * `0` or a blank cell — it renders an em dash plus the caption prop. With
 * `onSelect` the whole figure becomes a button; its pressed indicator is a
 * neutral (never coloured) 2px underline on the label, because a coloured
 * selected state beside win/loss marks reads as "loss" (UI-SPEC §4.3 rule 3).
 */
export function StatFigure({
  label,
  value,
  unitSuffix,
  lead = false,
  support,
  delta,
  state = 'populated',
  emptyCaption,
  onSelect,
  pressed = false,
  className,
}: StatFigureProps) {
  const isEmpty = state === 'empty';
  const isCollapsed = state === 'collapsed';

  const valueNode = isEmpty ? (
    <span
      className={cn(
        lead
          ? 'text-[1.75rem] leading-8 font-semibold tracking-tight'
          : 'text-xl leading-6 font-semibold',
        'text-muted-foreground',
      )}
    >
      {'—'}
    </span>
  ) : (
    <span
      className={cn(
        lead
          ? 'text-[1.75rem] leading-8 font-semibold tracking-tight proportional-nums'
          : 'text-xl leading-6 font-semibold tabular-nums',
        isCollapsed && 'text-muted-foreground',
      )}
    >
      {value}
    </span>
  );

  const labelNode = (
    <span
      className={cn(
        'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase',
        pressed && 'border-b-2 border-foreground',
      )}
    >
      {label}
    </span>
  );

  const body = (
    <>
      {labelNode}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {valueNode}
        {!isEmpty && unitSuffix && (
          <span className="text-sm leading-5 font-medium text-muted-foreground">{unitSuffix}</span>
        )}
        {!isEmpty && delta}
      </div>
      <div className="text-xs leading-4 text-muted-foreground tabular-nums">
        {isEmpty ? emptyCaption : support}
      </div>
    </>
  );

  const wrapperClassName = cn('flex min-w-0 flex-col items-start gap-1', className);

  if (onSelect) {
    return (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onSelect}
        className={cn(wrapperClassName, 'text-left')}
      >
        {body}
      </button>
    );
  }

  return <div className={wrapperClassName}>{body}</div>;
}
