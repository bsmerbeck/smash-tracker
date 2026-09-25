import { CHART_TOKENS } from '@/components/charts/tokens';
import { cn } from '@/lib/utils';

export type DeltaChipState = 'up' | 'down' | 'steady' | 'thin' | 'none' | 'collapsed';

export interface DeltaChipProps {
  state: DeltaChipState;
  /** Fully composed by the host — the chip never localises (Track B rule B1). */
  valueLabel: string;
  /** e.g. "last 30" — rendered muted after the value. */
  horizonLabel?: string;
  /** Accessible label spelling out both records and both sample sizes. */
  ariaLabel: string;
  /** Set when the enclosing figure's overline already carries the horizon (see the guard below). */
  horizonOwnedByParent?: boolean;
}

/**
 * The mark-role colour lookup — the ONE source `DeltaChip` reads (UIX-05). A
 * mark role resolves to a token; it is never something a caller can pass in,
 * which is what makes the "tokenised once" contract checkable — the
 * component below declares no colour prop.
 */
const MARK_COLOR = { win: CHART_TOKENS.win, loss: CHART_TOKENS.loss, steady: CHART_TOKENS.steady };

type GlyphState = Exclude<DeltaChipState, 'collapsed'>;

const GLYPH_COLOR: Record<GlyphState, string> = {
  up: MARK_COLOR.win,
  down: MARK_COLOR.loss,
  steady: MARK_COLOR.steady,
  thin: MARK_COLOR.steady,
  none: MARK_COLOR.steady,
};

/** One shape per state (UI-SPEC §7.5) — inline SVG, never a text glyph character (DD-05). */
function Glyph({ state, color }: { state: GlyphState; color: string }) {
  switch (state) {
    case 'up':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M4 0 L8 8 L0 8 Z" fill={color} />
        </svg>
      );
    case 'down':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M0 0 L8 0 L4 8 Z" fill={color} />
        </svg>
      );
    case 'steady':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <rect x="0" y="3" width="8" height="2" fill={color} />
        </svg>
      );
    case 'thin':
    case 'none':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <circle cx="4" cy="4" r="3" fill="none" stroke={color} strokeWidth="1.5" />
        </svg>
      );
  }
}

/**
 * The six delta states (INS-02): up, down, steady, thin, none, collapsed.
 * The numeric value stays in the default foreground ink — only the 8px
 * glyph and the 16% background tint carry a data colour. A delta is NEVER
 * shown without its horizon (D-06/T-39.1-06-04): without `horizonLabel` or
 * `horizonOwnedByParent` this renders nothing rather than a bare number.
 */
export function DeltaChip({
  state,
  valueLabel,
  horizonLabel,
  ariaLabel,
  horizonOwnedByParent = false,
}: DeltaChipProps) {
  if (state === 'collapsed') {
    return null;
  }

  if (!horizonLabel && !horizonOwnedByParent) {
    if (process.env.NODE_ENV === 'development') {
      throw new Error('DeltaChip: a delta must carry a horizon label or set horizonOwnedByParent');
    }
    console.error('DeltaChip: refusing to render a bare delta without a horizon label');
    return null;
  }

  const color = GLYPH_COLOR[state];
  const isTinted = state === 'up' || state === 'down';
  const backgroundStyle = isTinted
    ? { backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)` }
    : undefined;

  return (
    <span
      tabIndex={0}
      aria-label={ariaLabel}
      style={backgroundStyle}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums whitespace-nowrap',
        !isTinted && 'bg-muted/40',
      )}
    >
      <Glyph state={state} color={color} />
      <span className="text-foreground">{valueLabel}</span>
      {horizonLabel && <span className="text-muted-foreground">{`· ${horizonLabel}`}</span>}
    </span>
  );
}
