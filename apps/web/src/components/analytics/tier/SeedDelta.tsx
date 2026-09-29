import { useTranslation } from 'react-i18next';
import { CHART_TOKENS } from '@/components/charts/tokens';

export interface SeedDeltaProps {
  seed?: number | null;
  placement?: number | null;
  locale?: string;
}

const MISSING = '—';
/** U+2212, the true minus sign (DD-19), never a hyphen. */
const MINUS = '−';

type DeltaShape = 'up' | 'down' | 'even';

const SHAPE_COLOR: Record<DeltaShape, string> = {
  up: CHART_TOKENS.win,
  down: CHART_TOKENS.loss,
  even: CHART_TOKENS.steady,
};

/** The 8x8 glyph: up = placed better than seeded, down = fell short, bar = matched. Inline SVG, never a text arrow. */
function Glyph({ shape }: { shape: DeltaShape }) {
  const fill = SHAPE_COLOR[shape];
  return (
    <svg data-slot="seed-delta-glyph" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      {shape === 'up' && <path d="M4 0 L8 8 L0 8 Z" fill={fill} />}
      {shape === 'down' && <path d="M0 0 L8 0 L4 8 Z" fill={fill} />}
      {shape === 'even' && <rect x="0" y="3" width="8" height="2" fill={fill} />}
    </svg>
  );
}

/**
 * Seed delta (DD-19, UI-SPEC §7.11): `seed - placement`, so a positive number
 * means the player placed better than their seed. A glyph carries the
 * direction (`--win` / `--loss` marks, flat when equal) and the signed integer
 * stays in the foreground ink; nothing here is a coloured badge. `—` whenever
 * the seed or the placement is missing, because a delta is never inferred.
 * Reading order for assistive technology is one sentence: "Seed 8 → 3".
 */
export function SeedDelta({ seed, placement, locale = 'en' }: SeedDeltaProps) {
  const { t } = useTranslation();

  if (seed == null || placement == null) {
    return (
      <span data-slot="seed-delta" data-state="missing" className="text-muted-foreground">
        {MISSING}
      </span>
    );
  }

  const delta = seed - placement;
  const shape: DeltaShape = delta > 0 ? 'up' : delta < 0 ? 'down' : 'even';
  const formatter = new Intl.NumberFormat(locale);
  const magnitude = formatter.format(Math.abs(delta));
  const signed = delta > 0 ? `+${magnitude}` : delta < 0 ? `${MINUS}${magnitude}` : '0';
  const label = t('tournaments.table.seedDeltaAria', { seed, placement });

  return (
    <span
      data-slot="seed-delta"
      data-state={shape}
      aria-label={label}
      title={label}
      role="img"
      className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums"
    >
      <Glyph shape={shape} />
      <span className="text-foreground">{signed}</span>
    </span>
  );
}
