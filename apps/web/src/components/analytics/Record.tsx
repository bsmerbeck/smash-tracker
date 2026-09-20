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
}: RecordProps) {
  const n = wins + losses;
  const formatter = new Intl.NumberFormat(locale);
  const recordText = `${formatter.format(wins)}${EN_DASH}${formatter.format(losses)}`;
  const showRate = n >= ABSTENTION_FLOOR_GAMES;
  const rate = showRate ? Math.round((wins / n) * 100) : null;
  const tier = confidenceTierFor(n);
  const glyph = CONFIDENCE_GLYPH[tier ?? 'none'];

  return (
    <span className={cn('tabular-nums whitespace-nowrap', className)}>
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
      {cue !== 'none' && cueLabel && (
        <span role="img" aria-label={cueLabel} className="ml-1">
          {cue === 'glyph' ? glyph : cueLabel}
        </span>
      )}
    </span>
  );
}
