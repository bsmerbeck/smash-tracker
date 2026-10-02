import { useTranslation } from 'react-i18next';
import { confidenceTierFor } from '@smash-tracker/shared';
import { CHART_TOKENS } from '@/components/charts/tokens';

/**
 * Plan 39.1-46 (sketch 003 A `tierGlyph`): the two presentational atoms the
 * Matchups stage evidence rows share (the row builder and the stage drill
 * hook live in `../lib/stageSeries.tsx` — a components-only file keeps
 * react-refresh's only-export-components rule quiet).
 */

/** The `●○○ / ●●○ / ●●●` confidence glyph for a sample of `total` games, `○○○` (decorative) under the floor. */
export function TierGlyph({ total }: { total: number }) {
  const { t } = useTranslation();
  const tier = confidenceTierFor(total);
  if (!tier) {
    return (
      <span aria-hidden="true" className="ml-1 text-xs">
        ○○○
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={t(`shared.evidence.sampleCueGlyph.${tier}`, { count: total })}
      className="ml-1 text-xs"
    >
      {tier === 'high' ? '●●●' : tier === 'medium' ? '●●○' : '●○○'}
    </span>
  );
}

/** The reference legend swatch: a 2 x 12px de-emphasis tick (sketch `.lg-base`). */
export function ReferenceSwatch() {
  return (
    <i
      aria-hidden="true"
      className="inline-block"
      style={{ width: 2, height: 12, backgroundColor: CHART_TOKENS.deemphasis }}
    />
  );
}
