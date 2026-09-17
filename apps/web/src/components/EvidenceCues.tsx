import { useTranslation } from 'react-i18next';
import type { CohortComposition, SampleMeta, UnknownBucket } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Phase 36 (EVID-06, EVID-10, D-13): one shared presentational implementation
 * for the three cues every evidence-consuming advisor surface renders from
 * the SAME claim shape — a sample/confidence cue, a forced-last "unknown"
 * bucket row, and a mixed-context badge. Six near-copies of this logic is
 * exactly the drift this phase closes; every surface imports these three
 * exports rather than re-deriving the treatment. See
 * `packages/shared/src/evidence/types.ts` for `SampleMeta`/`UnknownBucket`
 * and `packages/shared/src/evidence/cohort.ts` for `CohortComposition`.
 */

/**
 * `"{{total}} games · {{tier}} confidence"` appended after an existing
 * rate/record line on the same line (never a second line). Renders nothing
 * below the abstention floor — `confidenceTier` is `null` there, and there is
 * no confidence to report below the floor (only a gap, shown by the host's
 * own abstained branch).
 */
export function SampleCue({ sample }: { sample: SampleMeta }) {
  const { t } = useTranslation();
  if (sample.confidenceTier == null) {
    return null;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {t('shared.evidence.sampleCue', {
        total: sample.eligibleDenominator,
        tier: t(`shared.evidence.tier.${sample.confidenceTier}`),
      })}
    </span>
  );
}

/**
 * Forced-last row/li disclosing games the engine could not classify along
 * one axis (D-09, EVID-11) — never rendered for a null bucket (100%
 * known-field coverage), never a new column when `as="tr"` (a single
 * wide cell via `colSpan`, so the host's existing column set is unchanged).
 */
export function UnknownRow({ bucket, as }: { bucket: UnknownBucket | null; as: 'li' | 'tr' }) {
  const { t } = useTranslation();
  if (bucket == null) {
    return null;
  }
  const text = t('shared.evidence.unknownRow', { count: bucket.games });
  if (as === 'tr') {
    return (
      <tr className="text-muted-foreground">
        <td colSpan={100} className="px-2 py-1 text-sm">
          {text}
        </td>
      </tr>
    );
  }
  return <li className="text-sm text-muted-foreground">{text}</li>;
}

/**
 * Outline `Badge` + `Tooltip` disclosing a minority cohort at or above
 * `MIXED_CONTEXT_THRESHOLD` (EVID-02, D-10) — absent, never disabled/greyed,
 * below that threshold or with one homogeneous cohort.
 */
export function MixedContextBadge({ cohort }: { cohort: CohortComposition }) {
  const { t } = useTranslation();
  if (!cohort.mixedContext) {
    return null;
  }
  const minorityPct = Math.round(cohort.minorityShare * 100);
  const minorityLabel = cohort.minorityLabel
    ? t(`shared.evidence.cohort.${cohort.minorityLabel}`)
    : '';
  const majorityLabel = cohort.majorityLabel
    ? t(`shared.evidence.cohort.${cohort.majorityLabel}`)
    : '';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">{t('shared.evidence.mixedContext')}</Badge>
      </TooltipTrigger>
      <TooltipContent>
        {t('shared.evidence.mixedContextDetail', { minorityPct, minorityLabel, majorityLabel })}
      </TooltipContent>
    </Tooltip>
  );
}
