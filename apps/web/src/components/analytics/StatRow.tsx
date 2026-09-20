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
  className?: string;
}

/**
 * The one stat idiom (UIX-04). Below an 860px container it collapses to two
 * columns, with the lead figure (when present) spanning both — implemented
 * with a container query so it responds to the CARD'S width, not the
 * viewport's.
 */
export function StatRow({ figures, leadWidth = false, className }: StatRowProps) {
  const count = figures.length;
  const columnClass =
    (leadWidth ? LEAD_COLUMN_CLASSES[count] : COLUMN_CLASSES[count]) ?? 'grid-cols-2';

  return (
    <div
      className={cn(
        '@container grid items-start gap-x-6 gap-y-3 @max-[860px]:grid-cols-2',
        columnClass,
        leadWidth && '@max-[860px]:[&>*:first-child]:col-span-2',
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
