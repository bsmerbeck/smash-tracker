import type { ReactNode } from 'react';
import { CHART_TOKENS } from './tokens';

/**
 * The inline-mark chart-kit sub-family (kit README, VIZ-02): `RecordBar`,
 * `ShareBar` and `MiniStrip` — small plain-DOM marks embedded inline beside
 * text (a `StatFigure`, a table row) rather than a standalone chart.
 *
 * Plain DOM only, exactly like `ComparisonBars.tsx` and `FormStrip.tsx`: this
 * file never imports `recharts` and is deliberately NOT a member of
 * `chartKitBoundary.test.ts`'s `KIT_CHART_PRIMITIVES` — none of these three
 * marks render a Recharts element, so the structural frame rule does not
 * apply to them. Every label and legend string is a prop; this file
 * localises nothing (Track B rule B1).
 */

/** The mark-role colour lookup — the ONE source `RecordBar`/`MiniStrip` read a win/loss colour from (UIX-05). */
const MARK_COLOR = { win: CHART_TOKENS.win, loss: CHART_TOKENS.loss };

/**
 * `ShareBar`'s four fixed fills, in FIXED order (identity + context keys,
 * never a status colour — match type is nominal, not good/bad). A segment's
 * fill is its ARRAY POSITION in the (already host-ordered) `segments` prop,
 * never its size — this is what keeps a category's colour identical across
 * renders that have different sibling categories present, as long as the
 * host keeps that category at the same relative position in its own fixed
 * canonical ordering.
 */
const FIXED_FILLS = [
  CHART_TOKENS.series1,
  CHART_TOKENS.series2,
  CHART_TOKENS.deemphasis,
  CHART_TOKENS.deemphasisStrong,
];

const RECORD_BAR_HEIGHT_PX = 6;
const RECORD_BAR_RADIUS_PX = 1;
const SHARE_BAR_HEIGHT_PX = 12;
const SHARE_BAR_MIN_SEGMENT_WIDTH_PX = 6;
const SHARE_BAR_MAX_SEGMENTS = 4;
const MINI_STRIP_TICK_WIDTH_PX = 5;
const MINI_STRIP_TICK_HEIGHT_PX = 12;
const MINI_STRIP_TICK_BAR_HEIGHT_PX = 6;
const MINI_STRIP_TICK_RADIUS_PX = 1;

/**
 * `RecordBar` — 64×6px, two segments flexed by wins and losses, always W
 * then L, 2px gap. Decorative (`aria-hidden`): the adjacent `Record` text is
 * the accessible content.
 */
export function RecordBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  const lossPct = total > 0 ? (losses / total) * 100 : 0;
  return (
    <span
      aria-hidden="true"
      data-slot="record-bar"
      className="inline-flex w-16 gap-0.5"
      style={{ height: RECORD_BAR_HEIGHT_PX }}
    >
      <span
        data-slot="record-bar-win"
        style={{
          width: `${winPct}%`,
          backgroundColor: MARK_COLOR.win,
          borderRadius: RECORD_BAR_RADIUS_PX,
        }}
      />
      <span
        data-slot="record-bar-loss"
        style={{
          width: `${lossPct}%`,
          backgroundColor: MARK_COLOR.loss,
          borderRadius: RECORD_BAR_RADIUS_PX,
        }}
      />
    </span>
  );
}

export interface ShareBarSegment {
  key: string;
  /** Localised category label — the row's single flexible truncating slot. */
  label: ReactNode;
  /** Raw count contributing to `total`. Position in the array (not count) decides the fixed fill. */
  count: number;
  record?: ReactNode;
  delta?: ReactNode;
  href?: string;
}

export interface ShareBarProps {
  /** In the host's fixed canonical category order. At most 4 render; a 5th+ folds into the 4th. */
  segments: ShareBarSegment[];
  total: number;
  headerLabel: ReactNode;
  /** Formats the already-computed integer percent, e.g. `(pct) => \`${pct}% of games\`` — pre-localised by the host. */
  shareSuffix: (percent: number) => ReactNode;
  onSelectSegment?: (segment: ShareBarSegment) => void;
  /** Rendered instead of the bar and rows at 0 games in scope. */
  emptyNode: ReactNode;
  /** `role="img"` summary for the bar. */
  ariaSummary: string;
  /** Label for the merged 4th row when a 5th+ category folds into it — falls back to the 4th segment's own label when omitted. */
  foldedLabel?: ReactNode;
}

/**
 * Integer percents computed from counts (never from an already-rounded
 * percentage), distributed by the largest-remainder method so the printed
 * shares always sum to exactly 100 when `total > 0`.
 */
function computeIntegerShares(counts: number[], total: number): number[] {
  if (total <= 0) {
    return counts.map(() => 0);
  }
  const raw = counts.map((count) => (count / total) * 100);
  const floors = raw.map((value) => Math.floor(value));
  const remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  const result = [...floors];
  for (let i = 0; i < remainder; i++) {
    const target = byFraction[i % byFraction.length]!.index;
    result[target] = (result[target] ?? 0) + 1;
  }
  return result;
}

/**
 * `ShareBar` — one stacked row, at most 4 segments, in a FIXED fill order
 * (identity, not status — match type is nominal). A 5th+ category folds
 * into the 4th (its count is added to the 4th's share; its own label/
 * record/delta never render). 0 games renders no bar/rows, just the header
 * line plus the host's empty node. One category at 100% renders exactly one
 * segment and one row, never a 0% row for an absent category.
 */
export function ShareBar({
  segments,
  total,
  headerLabel,
  shareSuffix,
  onSelectSegment,
  emptyNode,
  ariaSummary,
  foldedLabel,
}: ShareBarProps) {
  const rendered: ShareBarSegment[] =
    segments.length > SHARE_BAR_MAX_SEGMENTS
      ? [
          ...segments.slice(0, SHARE_BAR_MAX_SEGMENTS - 1),
          {
            ...segments[SHARE_BAR_MAX_SEGMENTS - 1]!,
            label: foldedLabel ?? segments[SHARE_BAR_MAX_SEGMENTS - 1]!.label,
            count: segments
              .slice(SHARE_BAR_MAX_SEGMENTS - 1)
              .reduce((sum, segment) => sum + segment.count, 0),
          },
        ]
      : segments;

  const shares = computeIntegerShares(
    rendered.map((segment) => segment.count),
    total,
  );

  return (
    <div className="flex flex-col gap-2" data-slot="share-bar-root">
      <div className="text-xs text-muted-foreground">{headerLabel}</div>
      {rendered.length === 0 ? (
        <div data-slot="share-bar-empty">{emptyNode}</div>
      ) : (
        <>
          <div
            role="img"
            aria-label={ariaSummary}
            className="flex gap-0.5"
            style={{ height: SHARE_BAR_HEIGHT_PX }}
            data-slot="share-bar"
          >
            {rendered.map((segment, index) => (
              <span
                key={segment.key}
                data-slot="share-bar-segment"
                className="rounded-sm"
                style={{
                  width: `${shares[index]}%`,
                  minWidth: SHARE_BAR_MIN_SEGMENT_WIDTH_PX,
                  backgroundColor: FIXED_FILLS[index],
                }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {rendered.map((segment, index) => {
              const rowContent = (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: FIXED_FILLS[index] }}
                  />
                  <span className="min-w-0 flex-1 truncate">{segment.label}</span>
                  <span className="shrink-0">{shareSuffix(shares[index]!)}</span>
                  {segment.record}
                  {segment.delta}
                </>
              );
              return (
                <li key={segment.key} data-slot="share-bar-row">
                  {onSelectSegment ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left"
                      onClick={() => onSelectSegment(segment)}
                    >
                      {rowContent}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">{rowContent}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export interface MiniStripGame {
  key: string;
  won: boolean;
}

/**
 * `MiniStrip` — `FormStrip`'s tick marks at 5×12px, no labels, no
 * interaction, `role="img"` with the host's summary label. Formalises
 * `WinLossPips`, which it replaces. At 0 games it renders nothing.
 */
export function MiniStrip({ games, ariaLabel }: { games: MiniStripGame[]; ariaLabel: string }) {
  if (games.length === 0) {
    return null;
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5"
      data-slot="mini-strip"
    >
      {games.map((game) => (
        <span
          key={game.key}
          data-slot={game.won ? 'mini-strip-tick-win' : 'mini-strip-tick-loss'}
          style={{
            display: 'inline-flex',
            width: MINI_STRIP_TICK_WIDTH_PX,
            height: MINI_STRIP_TICK_HEIGHT_PX,
            alignItems: game.won ? 'flex-start' : 'flex-end',
          }}
        >
          <span
            style={{
              width: MINI_STRIP_TICK_WIDTH_PX,
              height: MINI_STRIP_TICK_BAR_HEIGHT_PX,
              backgroundColor: game.won ? MARK_COLOR.win : MARK_COLOR.loss,
              borderRadius: MINI_STRIP_TICK_RADIUS_PX,
            }}
          />
        </span>
      ))}
    </span>
  );
}
