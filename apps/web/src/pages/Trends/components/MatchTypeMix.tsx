import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import { resolveWindow, toRateValue } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InsightLine } from '@/components/analytics/InsightLine';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { Record } from '@/components/analytics/Record';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import { ShareBar, type ShareBarSegment } from '@/components/charts/inlineMarks';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildMixShiftVerdict } from '../lib/useTrendsCardInsights';

/** The four buckets matches are grouped into for the mix read, in stack/legend/fixed-fill order. */
export const MATCH_TYPE_BUCKETS = ['tourney', 'friendly', 'quickplay', 'unspecified'] as const;
export type MatchTypeBucket = (typeof MATCH_TYPE_BUCKETS)[number];

const BUCKET_LABEL_KEYS: Record<MatchTypeBucket, string> = {
  tourney: 'trends.mix.tourney',
  friendly: 'trends.mix.friendly',
  quickplay: 'trends.mix.quickplay',
  unspecified: 'trends.mix.unspecified',
};

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
  /**
   * Plan 39.1-27 (gap closure, SC4/INS-04): the ONE `mixShift`/`volumeForm`
   * computation this card shares with `TrendsPage.tsx`'s own page-level
   * terminus — the host page calls `useTrendsCardInsights` once, above
   * every early return, and hands the result down. This card no longer
   * builds either insight itself.
   */
  mixShiftInsight: Insight | null;
  volumeFormInsight: Insight | null;
}

/**
 * The Pro desk's right rail, bottom card (UI-SPEC §8.2 Row 3, DD-10, DD-15):
 * an optional `MixShift` fact line, two stacked `ShareBar`s (all time and
 * the active recent horizon, each with localised labels and per-bucket
 * records), then the `VolumeForm` read as an insight line — each carrying a
 * counted-games door (plan 39.1-27). The legacy canvas bar chart is gone —
 * this file leaves BOTH the chart-kit boundary guard's allowlist and the
 * ESLint restricted-import ignore array in the SAME commit (DD-10).
 */
export function MatchTypeMix({
  matches,
  horizon,
  mixShiftInsight,
  volumeFormInsight,
}: MatchTypeMixProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
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

  const showMixShift = mixShiftInsight != null && mixShiftInsight.state !== 'hidden';

  // Plan 39.1-27 (gap closure, SC4/INS-04): each line's own counted-games
  // door — the games descriptor from `buildInsightDoors`, present only when
  // the insight actually counted at least one game.
  const mixShiftGamesDoor = mixShiftInsight
    ? buildInsightDoors({ insight: mixShiftInsight, subjectPath }).find(
        (door) => door.kind === 'games',
      )
    : undefined;
  const mixShiftDoorNode = mixShiftGamesDoor ? (
    <Link to={mixShiftGamesDoor.href}>
      {t('insights.door.seeGames', { count: mixShiftGamesDoor.count })}
    </Link>
  ) : undefined;

  const volumeFormGamesDoor = volumeFormInsight
    ? buildInsightDoors({ insight: volumeFormInsight, subjectPath }).find(
        (door) => door.kind === 'games',
      )
    : undefined;
  const volumeFormDoorNode = volumeFormGamesDoor ? (
    <Link to={volumeFormGamesDoor.href}>
      {t('insights.door.seeGames', { count: volumeFormGamesDoor.count })}
    </Link>
  ) : undefined;

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
                text={buildMixShiftVerdict(mixShiftInsight!, t)}
                tone="notable"
                chip={<ClaimChip kind="fact" label={t('insights.kind.fact')} />}
                door={mixShiftDoorNode}
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
                door={volumeFormDoorNode}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
