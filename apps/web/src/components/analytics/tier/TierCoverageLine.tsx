import { useTranslation } from 'react-i18next';
import type { TierSplitCoverage } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';

/**
 * T-05 (UI-SPEC §7.4): how much of the history a tier surface actually covers.
 * Whole-key tokens, ` · ` separated, muted `meta` ink, each token wrapping
 * whole (a token never splits across lines; the line breaks only between tokens). Zero-valued tokens ALWAYS render
 * ("0 recorded"), so partial coverage is visible rather than silently
 * shrinking the denominator. One extra token, "set manually", appears only
 * when at least one tier was overridden by hand: without it `known` would not
 * add up to recorded + estimated on an account that has used overrides.
 * Plain text, no interactive element.
 */
export function TierCoverageLine({
  coverage,
  className,
}: {
  coverage: TierSplitCoverage;
  className?: string;
}) {
  const { t } = useTranslation();
  // The events this line is about: known plus unknown. Side events left out of
  // the split are stated in the card header, so they never sit in this denominator.
  const count = coverage.known + coverage.unknown;
  const token = 'whitespace-nowrap';

  // One leaf element per token, so a token is a whole translated key and the
  // line only ever breaks between tokens (never a concatenated sentence).
  return (
    <p
      data-slot="tier-coverage"
      className={cn('text-xs leading-4 text-muted-foreground tabular-nums', className)}
    >
      <span data-token="known" className={token}>
        {t('tiers.coverage.known', { known: coverage.known, count })}
        {' ·'}
      </span>{' '}
      <span data-token="recorded" className={token}>
        {t('tiers.coverage.recorded', { count: coverage.recorded })}
        {' ·'}
      </span>{' '}
      {coverage.manual > 0 && (
        <>
          <span data-token="manual" className={token}>
            {t('tiers.coverage.manual', { count: coverage.manual })}
            {' ·'}
          </span>{' '}
        </>
      )}
      <span data-token="estimated" className={token}>
        {t('tiers.coverage.estimated', { count: coverage.estimated })}
        {' ·'}
      </span>{' '}
      <span data-token="unknown" className={token}>
        {t('tiers.coverage.unknown', { count: coverage.unknown })}
      </span>
    </p>
  );
}
