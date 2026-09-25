import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Insight, InsightState, Match } from '@smash-tracker/shared';
import { classify, resolveWindow, toRateValue, wilsonInterval } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { Record } from '@/components/analytics/Record';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { InsightLine } from '@/components/analytics/InsightLine';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import { ComparisonBars, type ComparisonBarsDumbbellRow } from '@/components/charts/ComparisonBars';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { useSubjectPath } from '@/hooks/useSubjectPath';

/** `classify`'s seven-state honesty ladder -> `DeltaChip`'s six-state union (duplicated per this codebase's small-helper-duplication convention). */
function deltaChipStateFor(state: InsightState, deltaPoints: number | null): DeltaChipState {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'steady') return 'steady';
  if (state === 'thin' || state === 'thinRecent') return 'thin';
  if (state === 'collapsed') return 'collapsed';
  return 'none';
}

interface SettingPartition {
  online: Match[];
  offline: Match[];
  unspecified: Match[];
}

/** Mirrors `@smash-tracker/shared`'s `settingGap.ts`'s (unexported) `partitionBySetting` byte-for-byte — ported, not imported, per this codebase's convention (`apps/web` cannot reach a template file's internals). */
function partitionBySetting(matches: Match[]): SettingPartition {
  const online: Match[] = [];
  const offline: Match[] = [];
  const unspecified: Match[] = [];
  for (const match of matches) {
    const type = match.matchType ?? '';
    if (type === 'quickplay' || type.startsWith('online')) {
      online.push(match);
    } else if (type.startsWith('offline')) {
      offline.push(match);
    } else {
      unspecified.push(match);
    }
  }
  return { online, offline, unspecified };
}

export interface SettingComparisonProps {
  matches: Match[];
  horizon: HorizonKey;
  /**
   * Plan 39.1-27 (gap closure, SC4/INS-04): the ONE `settingGap` computation
   * this card shares with `TrendsPage.tsx`'s own page-level terminus — the
   * host page calls `useTrendsCardInsights` once, above every early return,
   * and hands the result down. This card no longer builds its own insight.
   */
  settingGapInsight: Insight | null;
}

/**
 * The Pro desk's right rail, top card (UI-SPEC §8.2 Row 3, TRND-02, D-09):
 * a two-figure `StatRow` (online then offline, ALWAYS in that fixed order),
 * a two-row dumbbell (baseline = that side's all-time rate, recent = that
 * side's rate within the active horizon), then the `SettingGap` engine read
 * as an insight line carrying a counted-games door (plan 39.1-27). Replaces
 * the three concatenated second-person fragments and the bordered
 * `SettingBlock` tiles this file used to declare (UI-SPEC §9.6) — both are
 * deleted in this commit, along with the five
 * `trends.setting.{youWin,moreOnline,moreOffline,even,smallSample}` locale
 * keys (in all six locale files, in the SAME commit).
 */
export function SettingComparison({ matches, horizon, settingGapInsight }: SettingComparisonProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  const { online, offline, unspecified } = useMemo(() => partitionBySetting(matches), [matches]);

  const onlineBaseline = useMemo(() => toRateValue(online), [online]);
  const offlineBaseline = useMemo(() => toRateValue(offline), [offline]);

  const onlineRecent = useMemo(
    () => toRateValue(resolveWindow({ matches: online, horizon, scoped: false, nowMs }).matches),
    [online, horizon, nowMs],
  );
  const offlineRecent = useMemo(
    () => toRateValue(resolveWindow({ matches: offline, horizon, scoped: false, nowMs }).matches),
    [offline, horizon, nowMs],
  );

  const onlineClassify = useMemo(
    () =>
      classify({ recent: onlineRecent, baseline: onlineBaseline, scoped: false, hasAction: false }),
    [onlineRecent, onlineBaseline],
  );
  const offlineClassify = useMemo(
    () =>
      classify({
        recent: offlineRecent,
        baseline: offlineBaseline,
        scoped: false,
        hasAction: false,
      }),
    [offlineRecent, offlineBaseline],
  );

  function buildFigure(
    label: string,
    baseline: ReturnType<typeof toRateValue>,
    recent: ReturnType<typeof toRateValue>,
    gate: ReturnType<typeof classify>,
  ) {
    if (baseline.total === 0) {
      return (
        <StatFigure
          key={label}
          label={label}
          state="empty"
          emptyCaption={t('trends.setting.noData')}
        />
      );
    }
    // WR-C01: `locked` (below the abstention floor) is a different honesty
    // tier than `thin`/`thinRecent` and has no `DeltaChip` representation —
    // omit the chip entirely rather than let it fall through to
    // `deltaChipStateFor`'s `'none'` default, which reads "Thin".
    const chipState =
      gate.state === 'locked' ? null : deltaChipStateFor(gate.state, gate.deltaPoints);
    return (
      <StatFigure
        key={label}
        label={label}
        value={`${Math.round(baseline.rate * 100)}%`}
        support={<Record wins={baseline.wins} losses={baseline.losses} cue="none" />}
        delta={
          chipState === null || chipState === 'collapsed' ? null : (
            <DeltaChip
              state={chipState}
              valueLabel={t(
                chipState === 'up'
                  ? 'analytics.record.deltaUp'
                  : chipState === 'down'
                    ? 'analytics.record.deltaDown'
                    : `insights.chip.${chipState === 'none' ? 'thin' : chipState}`,
                { points: Math.abs(gate.deltaPoints ?? 0) },
              )}
              horizonOwnedByParent
              ariaLabel={t('analytics.dumbbell.rowAria', {
                label,
                recentRecord: `${recent.wins}–${recent.losses}`,
                baselineRecord: `${baseline.wins}–${baseline.losses}`,
              })}
            />
          )
        }
      />
    );
  }

  function buildDumbbellRow(
    key: 'online' | 'offline',
    label: string,
    baseline: ReturnType<typeof toRateValue>,
    recent: ReturnType<typeof toRateValue>,
    gate: ReturnType<typeof classify>,
  ): ComparisonBarsDumbbellRow | null {
    if (baseline.total === 0) {
      return null;
    }
    const collapsed = gate.state === 'collapsed';
    // WR-C01: `locked` (below the abstention floor) is a different honesty
    // tier than `thin`/`thinRecent` and has no `DeltaChip` representation —
    // omit the chip entirely rather than let it fall through to
    // `deltaChipStateFor`'s `'none'` default, which reads "Thin".
    const chipState =
      gate.state === 'locked' ? null : deltaChipStateFor(gate.state, gate.deltaPoints);
    const interval = wilsonInterval(recent.wins, recent.total);
    return {
      key,
      label,
      recentRecordNode: <Record wins={recent.wins} losses={recent.losses} cue="none" />,
      deltaNode:
        collapsed || chipState === null ? null : (
          <DeltaChip
            state={chipState}
            valueLabel={t(
              chipState === 'up'
                ? 'analytics.record.deltaUp'
                : chipState === 'down'
                  ? 'analytics.record.deltaDown'
                  : `insights.chip.${chipState === 'none' ? 'thin' : chipState}`,
              { points: Math.abs(gate.deltaPoints ?? 0) },
            )}
            horizonOwnedByParent
            ariaLabel={t('analytics.dumbbell.rowAria', {
              label,
              recentRecord: `${recent.wins}–${recent.losses}`,
              baselineRecord: `${baseline.wins}–${baseline.losses}`,
            })}
          />
        ),
      baselineRate: baseline.rate * 100,
      recentRate: recent.rate * 100,
      recentRange: [interval.lower * 100, interval.upper * 100],
      recentTotal: recent.total,
      href: subjectPath('/trends'),
      ariaLabel: t('shared.drillableRow.aria', {
        subject: label,
        context: `${recent.wins}–${recent.losses}`,
      }),
      collapsed,
    };
  }

  const dumbbellRows = [
    buildDumbbellRow(
      'online',
      t('trends.setting.online'),
      onlineBaseline,
      onlineRecent,
      onlineClassify,
    ),
    buildDumbbellRow(
      'offline',
      t('trends.setting.offline'),
      offlineBaseline,
      offlineRecent,
      offlineClassify,
    ),
  ].filter((row): row is ComparisonBarsDumbbellRow => row !== null);

  const gapVerdict = settingGapInsight
    ? t(settingGapInsight.copy.key, settingGapInsight.copy.values)
    : null;
  const gapChipKind: ClaimChipKind = settingGapInsight?.kind === 'inference' ? 'trend' : 'fact';

  // Plan 39.1-27 (gap closure, SC4/INS-04): the SettingGap line's own
  // counted-games door — the games descriptor from `buildInsightDoors`,
  // present only when the insight actually counted at least one game.
  const gapGamesDoor = settingGapInsight
    ? buildInsightDoors({ insight: settingGapInsight, subjectPath }).find(
        (door) => door.kind === 'games',
      )
    : undefined;
  const gapDoorNode = gapGamesDoor ? (
    <Link to={gapGamesDoor.href}>{t('insights.door.seeGames', { count: gapGamesDoor.count })}</Link>
  ) : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.setting.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {online.length === 0 && offline.length === 0 && unspecified.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        ) : (
          <>
            <StatRow
              figures={[
                buildFigure(
                  t('trends.setting.online'),
                  onlineBaseline,
                  onlineRecent,
                  onlineClassify,
                ),
                buildFigure(
                  t('trends.setting.offline'),
                  offlineBaseline,
                  offlineRecent,
                  offlineClassify,
                ),
              ]}
            />

            {dumbbellRows.length > 0 && (
              <div className="flex flex-col gap-2">
                <div
                  aria-hidden="true"
                  className="flex items-center justify-between text-[0.6875rem] text-muted-foreground tabular-nums"
                >
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
                <ComparisonBars mode="dumbbell" rows={dumbbellRows} />
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: CHART_TOKENS.deemphasis }}
                    />
                    {t('analytics.dumbbell.legend.allTime')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: CHART_TOKENS.series1 }}
                    />
                    {t('analytics.dumbbell.legend.recent')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-full opacity-40"
                      style={{ backgroundColor: CHART_TOKENS.series1 }}
                    />
                    {t('analytics.dumbbell.legend.range')}
                  </span>
                </div>
              </div>
            )}

            {gapVerdict && (
              <InsightLine
                text={gapVerdict}
                tone={settingGapInsight?.state === 'trend' ? 'notable' : 'steady'}
                chip={
                  settingGapInsight?.state === 'trend' ? (
                    <ClaimChip kind={gapChipKind} label={t(`insights.kind.${gapChipKind}`)} />
                  ) : undefined
                }
                door={gapDoorNode}
              />
            )}

            {unspecified.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('trends.setting.unspecifiedFootnote', { count: unspecified.length })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
