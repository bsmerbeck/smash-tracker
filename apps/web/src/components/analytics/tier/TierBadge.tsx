import { useTranslation } from 'react-i18next';
import { tierLevel, type TierBasis, type TierSource, type TierWord } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  TIER_GLYPH_BAR_COUNT,
  TIER_GLYPH_BAR_GAP_PX,
  TIER_GLYPH_BAR_WIDTH_PX,
  TIER_GLYPH_HEIGHT_PX,
  TIER_GLYPH_TRACK_FILL,
  TIER_GLYPH_WIDTH_PX,
  tierBadgeVariant,
  tierFillVar,
} from './tierTokens';

export interface TierBadgeProps {
  tier: TierWord;
  basis: TierBasis;
  /** Which system asserted the tier; carried as `data-source` for the oracle, never rendered. */
  source?: TierSource;
  /** The pre-localised provenance sentence (Track B rule B1: strings arrive as props). */
  provenance: string;
  /** `compact` keeps the glyph and drops the word in a narrow container; the word stays as the accessible name. */
  size?: 'default' | 'compact';
}

/**
 * DD-01: five bars, the first `level` filled with that level's tier colour and
 * the rest a neutral track. The count of filled bars is the primary ordinal
 * channel, so the amber steps never have to be told apart by colour alone.
 * Decorative: the word beside it carries the tier.
 */
export function TierGlyph({ level }: { level: number }) {
  return (
    <svg
      data-slot="tier-glyph"
      data-level={level}
      width={TIER_GLYPH_WIDTH_PX}
      height={TIER_GLYPH_HEIGHT_PX}
      viewBox={`0 0 ${TIER_GLYPH_WIDTH_PX} ${TIER_GLYPH_HEIGHT_PX}`}
      aria-hidden="true"
    >
      {Array.from({ length: TIER_GLYPH_BAR_COUNT }, (_, index) => {
        const filled = index < level;
        return (
          <rect
            key={index}
            x={index * (TIER_GLYPH_BAR_WIDTH_PX + TIER_GLYPH_BAR_GAP_PX)}
            y={0}
            width={TIER_GLYPH_BAR_WIDTH_PX}
            height={TIER_GLYPH_HEIGHT_PX}
            data-filled={filled ? 'true' : 'false'}
            fill={filled ? tierFillVar(level) : TIER_GLYPH_TRACK_FILL}
          />
        );
      })}
    </svg>
  );
}

/**
 * The tournament tier as a badge (T-05, DD-01, DD-02). Provenance is the badge
 * VARIANT plus the visible provenance line beside it, never a hue: a reader
 * can tell an estimate from a recorded tier with colour vision removed and
 * hover disabled. A tier colour appears only as a glyph bar fill, never as
 * text, background or border. `unknown` draws no glyph and is never styled
 * like `local`.
 */
export function TierBadge({ tier, basis, source, provenance, size = 'default' }: TierBadgeProps) {
  const { t } = useTranslation();
  const word = t(`tiers.label.${tier}`);
  const variant = tierBadgeVariant(basis);
  const level = tierLevel(tier);
  const compact = size === 'compact';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={variant}
          data-slot="tier-badge"
          data-tier={tier}
          data-basis={basis}
          data-variant={variant}
          data-source={source}
          className={cn(basis === 'unknown' && 'text-muted-foreground')}
        >
          {tier !== 'unknown' && <TierGlyph level={level} />}
          <span className={cn(compact && '@max-[220px]:sr-only')}>{word}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{word}</p>
        <p>{provenance}</p>
        {basis === 'estimated' && <p className="opacity-80">{t('tiers.tooltip.estimateCaveat')}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
