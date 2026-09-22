import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  Fighter,
  HorizonKey,
  Insight,
  InsightKind,
  Match,
  PeriodPoint,
} from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  PERIOD_TREND_MIN_PERIODS,
  buildPeriodSeries,
  classify,
  confidenceTierFor,
  resolveWindow,
  toRateValue,
  trimmedEventKey,
} from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendLine } from '@/components/charts/TrendLine';
import { FormStrip, type FormStripEvent, type FormStripSet } from '@/components/charts/FormStrip';
import { ShareBar, type ShareBarSegment } from '@/components/charts/inlineMarks';
import { CHART_H_COMPACT } from '@/components/charts/tokens';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { Record } from '@/components/analytics/Record';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import { formStripEventKeyForMatch } from '@/pages/Matchups/components/MatchupChart';
import { useFighterName } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import type { DrillDownAxes } from '@/lib/drillDownParams';
import { getMatchTypeRecords } from '@/lib/stats';
import { formatPercent } from '@/lib/formatPercent';

/**
 * The three recent-window figures the hero's `StatRow` renders as buttons —
 * a SECOND control for the same page-level persisted horizon `useHorizon`
 * owns (D-06). Order is fixed, matching UI-SPEC §8.1's stat row.
 */
const RECENT_HORIZON_KEYS: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90'];

/** `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated per this codebase's small-helper-duplication convention (see `MatchupChart.tsx`'s `claimChipKindFor`). */
function claimChipKindFor(kind: InsightKind): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** `classify`'s seven-state honesty ladder -> `DeltaChip`'s six-state union (duplicated, see `MatchWinLossCard.tsx`). */
function deltaChipStateFor(
  state: ReturnType<typeof classify>['state'],
  deltaPoints: number | null,
): DeltaChipState {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'steady') return 'steady';
  if (state === 'thin' || state === 'thinRecent') return 'thin';
  if (state === 'collapsed') return 'collapsed';
  return 'none';
}

function deltaValueLabel(state: DeltaChipState, deltaPoints: number | null, t: TFunction): string {
  if (state === 'up') return t('analytics.record.deltaUp', { points: Math.abs(deltaPoints ?? 0) });
  if (state === 'down') {
    return t('analytics.record.deltaDown', { points: Math.abs(deltaPoints ?? 0) });
  }
  return t(`insights.chip.${state === 'none' ? 'thin' : state}`);
}

/** `●●● / ●●○ / ●○○ / ○○○` — duplicated from `Record.tsx`'s own private map (not exported); see the small-helper-duplication convention. */
const CONFIDENCE_GLYPHS: Record<'high' | 'medium' | 'low' | 'none', string> = {
  high: '●●●',
  medium: '●●○',
  low: '●○○',
  none: '○○○',
};

/**
 * UI-SPEC §7.10: event -> set -> game, oldest first, grouped only. Plan
 * 39.1-25 (gap closure, SC6/TRND-04): events group by `trimmedEventKey`
 * (`eventSeries.ts`'s single name-priority rule — `eventName` first,
 * `tournamentName` as fallback, ported here rather than the file's former
 * hand-rolled `eventName ?? tournamentName` trim), and sets group by
 * `formStripEventKeyForMatch` (the Matchups tracer's single set rule — a
 * real parsed start.gg/parry.gg set id, else a per-game synthetic key, so a
 * manual game is its own one-game set) — the SAME function
 * `FighterAnalysisPage.tsx` hands `FilteredMatchList` as `eventKeyForMatch`,
 * so a rendered set's own click narrows to precisely those games.
 * `recentWindow` marks each set `inRecentWindow` from the SAME
 * `Insight.window` `formNow` already resolved.
 */
function buildFighterFormStripEvents(
  matches: Match[],
  recentWindow: { fromMs: number | null; toMs: number | null },
  t: TFunction,
): FormStripEvent[] {
  const sorted = [...matches].sort((a, b) => a.time - b.time);
  const byEvent = new Map<string, Match[]>();
  for (const match of sorted) {
    const key = trimmedEventKey(match) ?? '__manual__';
    const group = byEvent.get(key);
    if (group) {
      group.push(match);
    } else {
      byEvent.set(key, [match]);
    }
  }

  const inWindow = (m: Match): boolean =>
    recentWindow.fromMs != null &&
    recentWindow.toMs != null &&
    m.time >= recentWindow.fromMs &&
    m.time <= recentWindow.toMs;

  const events: FormStripEvent[] = [];
  for (const [key, eventMatches] of byEvent) {
    const bySet = new Map<string, Match[]>();
    for (const match of eventMatches) {
      const setKey = formStripEventKeyForMatch(match);
      const group = bySet.get(setKey);
      if (group) {
        group.push(match);
      } else {
        bySet.set(setKey, [match]);
      }
    }
    const sets: FormStripSet[] = [...bySet.entries()].map(([setKey, setMatches]) => {
      const wins = setMatches.filter((m) => m.win).length;
      const losses = setMatches.length - wins;
      const opponentTag = setMatches.find((m) => m.opponent)?.opponent ?? t('common.unknown');
      return {
        key: setKey,
        label: t('analytics.strip.setAria', {
          opponent: opponentTag,
          record: `${wins}–${losses}`,
        }),
        inRecentWindow: setMatches.some(inWindow),
        games: setMatches.map((match) => ({
          key: match.id,
          won: match.win,
          label: `${match.win ? t('common.win') : t('common.loss')} · ${new Date(match.time).toLocaleDateString()}`,
        })),
      };
    });
    const wins = eventMatches.filter((m) => m.win).length;
    const losses = eventMatches.length - wins;
    events.push({
      key,
      label: key === '__manual__' ? t('common.unknown') : key,
      record: `${wins}–${losses}`,
      sets,
    });
  }

  return events;
}

/**
 * Plan 39.1-25 (gap closure, SC6/TRND-04): the axes a hero drill (a trend
 * point or a form-strip set) can write — a subset of `DrillDownAxes`, never
 * `fighterId`/`vsFighterId`/`stageId`/`claimId` (those are never written by
 * this drill; `FighterAnalysisPage.tsx`'s writer also clears any prior
 * `claim`/`stage`/`event`/`from`/`to` before applying these).
 */
export type FighterHeroDrillAxes = Partial<Pick<DrillDownAxes, 'eventKey' | 'from' | 'to'>>;

export interface FighterHeroProps {
  fighter: Fighter;
  fighterMatches: Match[];
  allMatches: Match[];
  /** The page's ONE persisted horizon (`useHorizon`) — the hero's three recent figures are a SECOND control for this SAME value. */
  horizon: HorizonKey;
  setHorizon: (next: HorizonKey) => void;
  /** True while the match query is still in flight — a figure click performs no write in this state (T-39.1-14-03). */
  isLoading: boolean;
  /**
   * Plan 39.1-25 (gap closure, SC4/INS-04, D-12): the ONE `formNow`
   * computation the host page shares with its own terminus
   * (`resolveClaim`/`claimSummary`) — the hero no longer builds this itself.
   * `null` before a fighter is resolved or when the fighter has no matches.
   */
  formNowInsight: Insight | null;
  /** The SAME clock `formNowInsight` was built with — one clock, one insight (D-06, D-12). */
  nowMs: number;
  /**
   * Plan 39.1-25 (gap closure, SC6/TRND-04): the host's ONE URL writer for a
   * trend-point or form-strip-set drill — a trend point calls
   * `onDrill({ from, to })`, a form-strip set calls
   * `onDrill({ eventKey })`.
   */
  onDrill: (axes: FighterHeroDrillAxes) => void;
}

/**
 * The Fighter Analysis command center's hero region, rebuilt onto the
 * signed-off evidence-board contract (sketch 001-C, D-01, D-12, TRND-04):
 * identity row, FormNow verdict, a four-figure stat row (all time + the
 * three recent horizons, the latter bound to `useHorizon`), a 60-game
 * event-grouped form strip, a quarterly (or finer) win-rate trend, a
 * by-match-type share bar, and the FormNow games door. Deletes the legacy
 * chart.js rolling-10 sparkline and the raw-enum by-match-type table.
 */
export function FighterHero({
  fighter,
  fighterMatches,
  allMatches,
  horizon,
  setHorizon,
  isLoading,
  formNowInsight,
  nowMs,
  onDrill,
}: FighterHeroProps) {
  const { t, i18n } = useTranslation();
  const localizedName = useFighterName(fighter.id);
  const subjectPath = useSubjectPath();

  const hasMatches = fighterMatches.length > 0;

  const baselineAllTime = useMemo(() => toRateValue(fighterMatches), [fighterMatches]);
  const sharePct =
    allMatches.length > 0 ? Math.round((fighterMatches.length / allMatches.length) * 100) : 0;
  const allTimeTier = confidenceTierFor(baselineAllTime.total);

  const horizonFigures = useMemo(() => {
    return RECENT_HORIZON_KEYS.map((key) => {
      const { window, matches: recentMatches } = resolveWindow({
        matches: fighterMatches,
        horizon: key,
        scoped: true,
        nowMs,
      });
      const recentRate = toRateValue(recentMatches);
      const { state, deltaPoints } = classify({
        recent: recentRate,
        baseline: baselineAllTime,
        scoped: true,
        hasAction: false,
      });
      return { key, window, recentRate, state, deltaPoints };
    });
  }, [fighterMatches, baselineAllTime, nowMs]);

  const periodSeries = useMemo(
    () => buildPeriodSeries({ matches: fighterMatches }),
    [fighterMatches],
  );
  const overallRatePercent = baselineAllTime.rate * 100;
  const recentWindow = useMemo(
    () => ({
      fromMs: formNowInsight?.window.fromMs ?? null,
      toMs: formNowInsight?.window.toMs ?? null,
    }),
    [formNowInsight],
  );
  const formStripEvents = useMemo(
    () => buildFighterFormStripEvents(fighterMatches, recentWindow, t),
    [fighterMatches, recentWindow, t],
  );

  const typeRecords = useMemo(() => getMatchTypeRecords(fighterMatches), [fighterMatches]);

  function handleSelectHorizon(next: HorizonKey): void {
    // T-39.1-14-03: never write a horizon while the match query is loading.
    if (isLoading) return;
    setHorizon(next);
  }

  if (!hasMatches) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3" data-slot="fighter-hero-body">
          <img src={fighter.url} alt="" className="size-11 object-contain" />
          <div className="flex flex-col">
            <h2 className="text-xl leading-6 font-semibold">{localizedName}</h2>
            <p className="text-sm text-muted-foreground">{t('fighterAnalysis.hero.noMatches')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chipKind = formNowInsight ? claimChipKindFor(formNowInsight.kind) : 'fact';
  const entity = localizedName;
  const verdict = formNowInsight
    ? t(formNowInsight.copy.key, { ...formNowInsight.copy.values, entity })
    : '';
  // WR-C05 (39.1-REVIEW.md): read the raw rate off the Insight's own
  // `recent`/`baseline` claims and format it through the one shared,
  // locale-aware percent formatter, rather than the engine's pre-formatted
  // `copy.values.rate`/`.baselineRate` strings (always English-convention
  // "42%", baked in before this component ever sees `i18n.language`).
  const recentRateText =
    formNowInsight && formNowInsight.recent.kind === 'evidenced'
      ? formatPercent(formNowInsight.recent.value.rate, i18n.language)
      : '';
  const recentRecord = `${formNowInsight?.copy.values.record ?? ''} · ${recentRateText}`;
  const baselineRateText =
    formNowInsight && formNowInsight.baseline.kind === 'evidenced'
      ? formatPercent(formNowInsight.baseline.value.rate, i18n.language)
      : '';
  const evidenceCount =
    typeof formNowInsight?.copy.values.count === 'number' ? formNowInsight.copy.values.count : 0;
  const evidenceTier = confidenceTierFor(evidenceCount);
  const evidenceCue = evidenceTier
    ? t(`shared.evidence.sampleCueGlyph.${evidenceTier}`, { count: evidenceCount })
    : '';
  const evidence = formNowInsight
    ? t(`insights.evidence.twoHorizon.${horizon}`, {
        recentRecord,
        baselineRate: baselineRateText,
        baselineGames: formNowInsight.copy.values.baselineGames ?? 0,
        cue: evidenceCue,
      })
    : '';

  const allTimeFigure = (
    <StatFigure
      key="all-time"
      label={t('fighterAnalysis.hero.allTime')}
      value={`${Math.round(overallRatePercent)}%`}
      lead
      support={
        <Record
          wins={baselineAllTime.wins}
          losses={baselineAllTime.losses}
          cueLabel={
            allTimeTier
              ? t(`shared.evidence.sampleCueGlyph.${allTimeTier}`, { count: baselineAllTime.total })
              : undefined
          }
        />
      }
    />
  );

  const recentFigureNodes = horizonFigures.map(({ key, recentRate, state, deltaPoints }) => {
    const isPressed = horizon === key;

    if (state === 'locked') {
      const gamesNeeded = Math.max(0, ABSTENTION_FLOOR_GAMES - recentRate.total);
      return (
        <StatFigure
          key={key}
          label={t(`insights.horizon.short.${key}`)}
          state="empty"
          emptyCaption={t('fighterAnalysis.hero.figureLocked', { count: gamesNeeded })}
          onSelect={() => handleSelectHorizon(key)}
          pressed={isPressed}
        />
      );
    }

    if (state === 'collapsed') {
      return (
        <StatFigure
          key={key}
          label={t(`insights.horizon.short.${key}`)}
          state="collapsed"
          value={t('analytics.stat.collapsedValue')}
          support={t('analytics.stat.collapsedSupport', {
            recent: recentRate.total,
            total: baselineAllTime.total,
          })}
          onSelect={() => handleSelectHorizon(key)}
          pressed={isPressed}
        />
      );
    }

    const chipState = deltaChipStateFor(state, deltaPoints);
    const isThinRecent = state === 'thinRecent' || state === 'thin';
    const delta =
      chipState === 'collapsed' ? null : (
        <DeltaChip
          state={chipState}
          valueLabel={deltaValueLabel(chipState, deltaPoints, t)}
          horizonOwnedByParent
          ariaLabel={t('analytics.dumbbell.rowAria', {
            label: t(`insights.horizon.${key}`),
            recentRecord: `${recentRate.wins}–${recentRate.losses}`,
            baselineRecord: `${baselineAllTime.wins}–${baselineAllTime.losses}`,
          })}
        />
      );

    return (
      <StatFigure
        key={key}
        label={t(`insights.horizon.short.${key}`)}
        value={`${Math.round(recentRate.rate * 100)}%`}
        state={isThinRecent ? 'thinRecent' : 'populated'}
        support={<Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />}
        delta={delta}
        onSelect={() => handleSelectHorizon(key)}
        pressed={isPressed}
      />
    );
  });

  const shareBarSegments: ShareBarSegment[] = typeRecords.map((record) => {
    const key = record.matchType === 'unspecified' ? 'none' : record.matchType;
    const label = t(`analytics.matchType.${key}`, { defaultValue: record.matchType });
    const rate = {
      wins: record.wins,
      losses: record.losses,
      total: record.total,
      rate: record.winRate / 100,
    };
    const { state, deltaPoints } = classify({
      recent: rate,
      baseline: baselineAllTime,
      scoped: false,
      hasAction: false,
    });
    const chipState = deltaChipStateFor(state, deltaPoints);
    return {
      key: record.matchType,
      label,
      count: record.total,
      record: <Record wins={record.wins} losses={record.losses} cue="none" />,
      delta:
        chipState === 'collapsed' ? null : (
          <DeltaChip
            state={chipState}
            valueLabel={deltaValueLabel(chipState, deltaPoints, t)}
            horizonOwnedByParent
            ariaLabel={t('analytics.dumbbell.rowAria', {
              label,
              recentRecord: `${record.wins}–${record.losses}`,
              baselineRecord: `${baselineAllTime.wins}–${baselineAllTime.losses}`,
            })}
          />
        ),
    };
  });

  // Plan 39.1-25 (gap closure, SC6/TRND-04): a period point's own bounds are
  // the min/max timestamps of the period's own games — the terminus window
  // is inclusive at both ends (UI-SPEC §10.1), so `from`/`to` reproduce
  // exactly those games, never a wider period-grain bucket.
  function handleSelectPeriodPoint(point: PeriodPoint): void {
    onDrill({ from: point.startMs, to: point.endMs });
  }

  // Plan 39.1-25 (gap closure, SC4/INS-04): the door is built by
  // `buildInsightDoors` from the SAME `formNowInsight` the host's terminus
  // resolves against — never a hand-built fighter-axis href. `undefined`
  // whenever the insight has zero counted games (a zero-game window never
  // prints "See the 0 games").
  const gamesDoor = formNowInsight
    ? buildInsightDoors({ insight: formNowInsight, subjectPath }).find(
        (door) => door.kind === 'games',
      )
    : undefined;

  const confidenceLabel = allTimeTier
    ? t(`shared.evidence.sampleCueGlyph.${allTimeTier}`, { count: baselineAllTime.total })
    : '';

  return (
    <Card>
      <CardContent className="flex flex-col gap-4" data-slot="fighter-hero-body">
        {/* 1. identity row */}
        <div className="flex items-center gap-3" data-slot="fighter-hero-identity">
          <img src={fighter.url} alt="" className="size-11 object-contain" />
          <div className="flex min-w-0 flex-col">
            <h2 className="text-xl leading-6 font-semibold">{localizedName}</h2>
            <p className="flex items-center gap-1 text-xs leading-4 text-muted-foreground tabular-nums">
              <span aria-hidden="true">{CONFIDENCE_GLYPHS[allTimeTier ?? 'none']}</span>
              <span>
                {t('fighterAnalysis.hero.identityMeta', {
                  pct: sharePct,
                  confidence: confidenceLabel,
                })}
              </span>
            </p>
          </div>
        </div>

        {/* 2. verdict block */}
        {formNowInsight && (
          <div className="flex flex-col gap-2" data-slot="fighter-hero-verdict">
            <div className="flex flex-wrap items-center gap-2">
              <ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />
              <span className="text-xs leading-4 text-muted-foreground tabular-nums">
                {t(`fighterAnalysis.hero.verdictMeta.${horizon}`)}
              </span>
            </div>
            <p
              className="line-clamp-3 text-base leading-6 font-medium text-pretty"
              data-slot="fighter-hero-verdict-sentence"
            >
              {verdict}
            </p>
            <p
              className="text-xs leading-4 text-muted-foreground tabular-nums"
              data-slot="fighter-hero-verdict-evidence"
            >
              {evidence}
            </p>
          </div>
        )}

        {/* 3. stat row of four */}
        <StatRow leadWidth figures={[allTimeFigure, ...recentFigureNodes]} />

        {/* 4. form strip. min-w-0 (plan 39.1-20 Task 3 [Rule 1]): without
            it, this flex item refuses to shrink below FormStrip's
            unconstrained (every event on one line) max-content width — see
            FormStrip.tsx's own doc comment for the full mechanism. */}
        <div className="flex min-w-0 flex-col gap-2" data-slot="fighter-hero-strip">
          <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
            {t('fighterAnalysis.hero.formStrip.title')}
          </p>
          <FormStrip
            events={formStripEvents}
            limit={60}
            labels={{
              summary: t('analytics.strip.aria', { count: fighterMatches.length }),
              legend: t('analytics.strip.legend'),
              shownOfTotal:
                fighterMatches.length > 60
                  ? t('analytics.strip.shownOf', { shown: 60, total: fighterMatches.length })
                  : undefined,
              empty: <span>{t('analytics.strip.empty')}</span>,
              windowEmpty:
                formNowInsight && formNowInsight.window.games === 0
                  ? t(`analytics.strip.windowEmpty.${horizon}`)
                  : undefined,
            }}
            onSelectSet={(setKey) => onDrill({ eventKey: setKey })}
          />
        </div>

        {/* 5. period trend */}
        <div className="flex flex-col gap-2" data-slot="fighter-hero-trend">
          <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
            {t(`fighterAnalysis.hero.trendTitle.${periodSeries.grain}`)}
          </p>
          <TrendLine
            mode="period"
            points={periodSeries.points}
            onSelectPoint={handleSelectPeriodPoint}
            referenceRate={overallRatePercent}
            emphasisStartMs={recentWindow.fromMs ?? undefined}
            height={CHART_H_COMPACT}
            labels={{
              lockedSentence: t(`analytics.trend.lockedPeriods.${periodSeries.grain}`, {
                count: Math.max(0, PERIOD_TREND_MIN_PERIODS - periodSeries.points.length),
              }),
              lockedCountLabel: t('insights.state.lockedMeter', {
                have: periodSeries.points.length,
                need: PERIOD_TREND_MIN_PERIODS,
              }),
              tableToggle: t('analytics.trend.tableToggle'),
              tableHeaders: {
                period: t('analytics.trend.tableHeaders.period'),
                record: t('analytics.trend.tableHeaders.record'),
                rate: t('analytics.trend.tableHeaders.rate'),
                sample: t('analytics.trend.tableHeaders.sample'),
              },
              referenceLabel: `${Math.round(overallRatePercent)}%`,
            }}
          />
        </div>

        {/* 6. by match type */}
        <ShareBar
          segments={shareBarSegments}
          total={fighterMatches.length}
          headerLabel={t('matchups.insights.byMatchType')}
          shareSuffix={(pct) => `${pct}%`}
          emptyNode={t('analytics.share.empty')}
          ariaSummary={t('analytics.share.aria', { count: fighterMatches.length })}
        />

        {/* 7. doors */}
        {gamesDoor && (
          <div className="flex flex-wrap gap-2" data-slot="fighter-hero-doors">
            <Button asChild size="sm">
              <Link to={gamesDoor.href}>
                {t('insights.door.seeGames', { count: gamesDoor.count })}
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
