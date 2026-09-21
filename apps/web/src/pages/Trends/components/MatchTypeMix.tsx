import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import {
  ACCOUNT_SCOPE,
  INSIGHT_TEMPLATES,
  resolveWindow,
  toRateValue,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InsightLine } from '@/components/analytics/InsightLine';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { Record } from '@/components/analytics/Record';
import { ShareBar, type ShareBarSegment } from '@/components/charts/inlineMarks';

/** The four buckets matches are grouped into for the mix read, in stack/legend/fixed-fill order. */
export const MATCH_TYPE_BUCKETS = ['tourney', 'friendly', 'quickplay', 'unspecified'] as const;
export type MatchTypeBucket = (typeof MATCH_TYPE_BUCKETS)[number];

const BUCKET_LABEL_KEYS: Record<MatchTypeBucket, string> = {
  tourney: 'trends.mix.tourney',
  friendly: 'trends.mix.friendly',
  quickplay: 'trends.mix.quickplay',
  unspecified: 'trends.mix.unspecified',
};

const MIX_SHIFT_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'mixShift')!;
const VOLUME_FORM_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'volumeForm')!;

/** Buckets a stored `matchType` literal into one of the four mix categories. */
export function bucketMatchType(matchType: Match['matchType']): MatchTypeBucket {
  const type = matchType ?? '';
  if (type === 'online-tourney' || type === 'offline-tourney') return 'tourney';
  if (type === 'online-friendly' || type === 'offline-friendly') return 'friendly';
  if (type === 'quickplay') return 'quickplay';
  return 'unspecified';
}

function partitionByBucket(matches: Match[]): Record<MatchTypeBucket, Match[]> {
  const out: Record<MatchTypeBucket, Match[]> = {
    tourney: [],
    friendly: [],
    quickplay: [],
    unspecified: [],
  };
  for (const match of matches) {
    out[bucketMatchType(match.matchType)].push(match);
  }
  return out;
}

function buildSegments(matches: Match[], t: (key: string) => string): ShareBarSegment[] {
  const byBucket = partitionByBucket(matches);
  return MATCH_TYPE_BUCKETS.filter((bucket) => byBucket[bucket].length > 0).map((bucket) => {
    const rate = toRateValue(byBucket[bucket]);
    return {
      key: bucket,
      label: t(BUCKET_LABEL_KEYS[bucket]),
      count: rate.total,
      record: <Record wins={rate.wins} losses={rate.losses} cue="none" />,
    };
  });
}

export interface MatchTypeMixProps {
  matches: Match[];
  horizon: HorizonKey;
}

/**
 * The Pro desk's right rail, bottom card (UI-SPEC §8.2 Row 3, DD-10, DD-15):
 * an optional `MixShift` fact line, two stacked `ShareBar`s (all time and
 * the active recent horizon, each with localised labels and per-bucket
 * records), then the `VolumeForm` read as an insight line. The legacy
 * canvas bar chart is gone — this file leaves BOTH the chart-kit boundary
 * guard's allowlist and the ESLint restricted-import ignore array in the
 * SAME commit (DD-10).
 */
export function MatchTypeMix({ matches, horizon }: MatchTypeMixProps) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  const allTimeSegments = useMemo(() => buildSegments(matches, t), [matches, t]);
  const recentMatches = useMemo(
    () => resolveWindow({ matches, horizon, scoped: false, nowMs }).matches,
    [matches, horizon, nowMs],
  );
  const recentSegments = useMemo(() => buildSegments(recentMatches, t), [recentMatches, t]);

  const mixShiftInsight = useMemo(
    () => MIX_SHIFT_TEMPLATE.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs })[0] ?? null,
    [matches, horizon, nowMs],
  );
  const volumeFormInsight = useMemo(
    () => VOLUME_FORM_TEMPLATE.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs })[0] ?? null,
    [matches, horizon, nowMs],
  );

  const showMixShift = mixShiftInsight != null && mixShiftInsight.state !== 'hidden';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.mix.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        ) : (
          <>
            {showMixShift && (
              <InsightLine
                text={t(mixShiftInsight!.copy.key, mixShiftInsight!.copy.values)}
                tone="notable"
                chip={<ClaimChip kind="fact" label={t('insights.kind.fact')} />}
              />
            )}

            <ShareBar
              segments={allTimeSegments}
              total={matches.length}
              headerLabel={t('trends.mix.allTime')}
              shareSuffix={(pct) => `${pct}%`}
              emptyNode={t('analytics.share.empty')}
              ariaSummary={t('analytics.share.aria', { count: matches.length })}
            />

            <ShareBar
              segments={recentSegments}
              total={recentMatches.length}
              headerLabel={t(`trends.mix.recentHeader.${horizon}`)}
              shareSuffix={(pct) => `${pct}%`}
              emptyNode={t('analytics.share.empty')}
              ariaSummary={t('analytics.share.aria', { count: recentMatches.length })}
            />

            {volumeFormInsight && (
              <InsightLine
                text={t(volumeFormInsight.copy.key, volumeFormInsight.copy.values)}
                tone={volumeFormInsight.state === 'trend' ? 'notable' : 'steady'}
                chip={
                  volumeFormInsight.state === 'trend' ? (
                    <ClaimChip kind="trend" label={t('insights.kind.trend')} />
                  ) : undefined
                }
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
