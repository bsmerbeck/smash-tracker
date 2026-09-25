import { useTranslation } from 'react-i18next';

/**
 * The no-concatenation guard's own deliberately-broken failing case
 * (UI-SPEC §13.8, Phase 39.1 Plan 09) — reproducing the EXACT shape of the
 * existing `apps/web/src/pages/Trends/components/SettingComparison.tsx`
 * sentence: a `t()` call, a numeric span, and a ternary choosing between
 * two MORE `t()` calls, all composing one sentence out of three pieces
 * instead of a single whole-sentence key with an interpolated value. Never
 * rendered by any real page — this component exists only so
 * `insightCopy.test.ts` has a proven, reproducible bad input to scan.
 * Deliberately excluded from the guard's own live scan (see
 * `insightCopy.test.ts`'s `guardFixtures/` exclusion) so the default suite
 * stays green; the guard's "positive control" test scans this file's raw
 * source directly, bypassing that exclusion, to prove the
 * violation-detection logic actually fires on it.
 */
export function ConcatenatedCopyFixture({ deltaPoints }: { deltaPoints: number }) {
  const { t } = useTranslation();
  return (
    <span>
      {t('trends.setting.youWin')}{' '}
      <span className="font-semibold text-foreground">{deltaPoints}%</span>{' '}
      {deltaPoints >= 0 ? t('trends.setting.moreOnline') : t('trends.setting.moreOffline')}
    </span>
  );
}
