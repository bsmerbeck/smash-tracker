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
 * One whole-sentence key per confidence tier (UI-SPEC §9.2 rule 8,
 * Phase 39.1 Plan 11) — `shared.evidence.sampleCue.low|medium|high`
 * (`_one`/`_other`), appended after an existing rate/record line on the
 * same line (never a second line). The tier word is now part of the KEY,
 * never interpolated into the sentence (the pattern rule 8 replaces:
 * `shared.evidence.sampleCue` used to interpolate a translated tier word
 * via a second `t()` call). Renders nothing below the abstention floor —
 * `confidenceTier` is `null` there, and there is no confidence to report
 * below the floor (only a gap, shown by the host's own abstained branch).
 */
export function SampleCue({ sample }: { sample: SampleMeta }) {
  const { t } = useTranslation();
  if (sample.confidenceTier == null) {
    return null;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {t(`shared.evidence.sampleCue.${sample.confidenceTier}`, {
        count: sample.eligibleDenominator,
      })}
    </span>
  );
}

/** UI-SPEC §14.3: the glyph confidence indicator (●○○ / ●●○ / ●●●) — one `<span role="img">` whose `aria-label` is the whole-sentence key per tier (`shared.evidence.sampleCueGlyph.low|medium|high`, `_one`/`_other`). The dots themselves are never read out; this form is used wherever the container is narrower than the words form's 280px threshold. Renders nothing below the abstention floor, mirroring `SampleCue`. */
const CONFIDENCE_GLYPH_DOTS: Record<NonNullable<SampleMeta['confidenceTier']>, string> = {
  low: '●○○',
  medium: '●●○',
  high: '●●●',
};

export function SampleCueGlyph({ sample }: { sample: SampleMeta }) {
  const { t } = useTranslation();
  if (sample.confidenceTier == null) {
    return null;
  }
  return (
    <span
      role="img"
      aria-label={t(`shared.evidence.sampleCueGlyph.${sample.confidenceTier}`, {
        count: sample.eligibleDenominator,
      })}
    >
      {CONFIDENCE_GLYPH_DOTS[sample.confidenceTier]}
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
 * below that threshold or with one homogeneous cohort. Plan 38-12 (38-UAT
 * test 5): `showDetail` also prints the detail sentence as visible muted text
 * after the badge; hosts that omit it keep the tooltip-only form.
 */
export function MixedContextBadge({
  cohort,
  showDetail = false,
}: {
  cohort: CohortComposition;
  showDetail?: boolean;
}) {
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
  const detail = t('shared.evidence.mixedContextDetail', {
    minorityPct,
    minorityLabel,
    majorityLabel,
  });
  const badge = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">{t('shared.evidence.mixedContext')}</Badge>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
  if (!showDetail) {
    return badge;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {badge}
      <span className="text-xs text-muted-foreground">{detail}</span>
    </span>
  );
}

/** Fixed print order of the session-type axis (38-UAT test 5). */
const SESSION_BUCKETS = ['offline', 'online', 'unspecified'] as const;
/** Fixed print order of the provenance axis. */
const SOURCE_BUCKETS = ['manual', 'startgg', 'parrygg'] as const;

/**
 * Plan 38-12 (38-UAT test 5, UI-SPEC "cohort composition … visible without
 * hover"): one muted line printing the cohort's non-zero session-type counts
 * (offline · online · unspecified) and, only when two or more sources are
 * present, the non-zero source counts — for every cohort, mixed or not.
 * Renders nothing for an empty cohort.
 */
export function CohortCompositionLine({ cohort }: { cohort: CohortComposition }) {
  const { t } = useTranslation();
  const part = (bucket: (typeof SESSION_BUCKETS)[number] | (typeof SOURCE_BUCKETS)[number]) =>
    t('shared.evidence.cohortCount', {
      count: cohort[bucket],
      label: t(`shared.evidence.cohort.${bucket}`),
    });
  const sessionParts = SESSION_BUCKETS.filter((b) => cohort[b] > 0).map(part);
  if (sessionParts.length === 0) {
    return null;
  }
  const sources = SOURCE_BUCKETS.filter((b) => cohort[b] > 0);
  const sourceParts = sources.length >= 2 ? sources.map(part) : [];
  return (
    <p data-slot="cohort-composition" className="text-xs text-muted-foreground">
      {[...sessionParts, ...sourceParts].join(' · ')}
    </p>
  );
}
