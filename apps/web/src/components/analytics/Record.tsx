import { ABSTENTION_FLOOR_GAMES, confidenceTierFor } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';

export type RecordUnit = 'games' | 'sets';
export type RecordCue = 'glyph' | 'words' | 'none';

export interface RecordProps {
  wins: number;
  losses: number;
  unit?: RecordUnit;
  /** Confidence cue form. Default `'glyph'`: the `●●○` tier glyph with its sentence as `aria-label`. */
  cue?: RecordCue;
  /** Bolds the `W–L` segment. */
  emphasis?: boolean;
  locale?: string;
  /** Accessible sentence for the confidence cue — `Record` never localises this itself (Track B rule B1). */
  cueLabel?: string;
  className?: string;
  /**
   * Plan 39.1-39 (UI-SPEC §7.4 "wraps whole", §6.5 rule 2): opt-in — the
   * record wraps WHOLE tokens (the W–L; the middot + rate; the middot + count
   * and unit; the cue) inside its host cell instead of spilling past it as
   * one unbreakable line. A token never splits. Absent, every existing
   * caller renders byte-identically (apart from `data-slot="record"`).
   */
  wrap?: boolean;
}

const EN_DASH = '–';
const MIDDOT = '·';

/** `●○○ / ●●○ / ●●●` (and `○○○` below the abstention floor) — UI-SPEC §14.3. Never read aloud; the sentence lives on `aria-label`. */
const CONFIDENCE_GLYPH: Record<'high' | 'medium' | 'low' | 'none', string> = {
  high: '●●●',
  medium: '●●○',
  low: '●○○',
  none: '○○○',
};

/**
 * The one record format everywhere (UIX-04): `W–L · rate · n`, en dash
 * between wins and losses, integer percent rate, thousands grouped through
 * one `Intl.NumberFormat(locale)`. Below `ABSTENTION_FLOOR_GAMES` the rate is
 * omitted — record + n only.
 */
export function Record({
  wins,
  losses,
  unit,
  cue = 'glyph',
  emphasis = false,
  locale = 'en',
  cueLabel,
  className,
  wrap = false,
}: RecordProps) {
  const n = wins + losses;
  const formatter = new Intl.NumberFormat(locale);
  const recordText = `${formatter.format(wins)}${EN_DASH}${formatter.format(losses)}`;
  const showRate = n >= ABSTENTION_FLOOR_GAMES;
  const rate = showRate ? Math.round((wins / n) * 100) : null;
  const tier = confidenceTierFor(n);
  const glyph = CONFIDENCE_GLYPH[tier ?? 'none'];

  const cueNode =
    cue !== 'none' && cueLabel ? (
      <span role="img" aria-label={cueLabel} className={wrap ? 'whitespace-nowrap' : 'ml-1'}>
        {cue === 'glyph' ? glyph : cueLabel}
      </span>
    ) : null;

  if (wrap) {
    return (
      <span
        data-slot="record"
        className={cn(
          'inline-flex flex-wrap items-baseline gap-x-1 gap-y-0.5 tabular-nums',
          className,
        )}
      >
        <span className={cn('whitespace-nowrap', emphasis && 'font-semibold')}>{recordText}</span>
        {showRate && (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">{MIDDOT}</span>
            {` ${rate}%`}
          </span>
        )}
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">{MIDDOT}</span>
          {` ${formatter.format(n)}`}
          {unit && <span className="text-muted-foreground">{` ${unit}`}</span>}
        </span>
        {cueNode}
      </span>
    );
  }

  return (
    <span data-slot="record" className={cn('tabular-nums whitespace-nowrap', className)}>
      <span className={cn(emphasis && 'font-semibold')}>{recordText}</span>
      {showRate && (
        <>
          <span className="text-muted-foreground">{` ${MIDDOT} `}</span>
          <span>{`${rate}%`}</span>
        </>
      )}
      <span className="text-muted-foreground">{` ${MIDDOT} `}</span>
      <span>{formatter.format(n)}</span>
      {unit && <span className="text-muted-foreground">{` ${unit}`}</span>}
      {cueNode}
    </span>
  );
}
