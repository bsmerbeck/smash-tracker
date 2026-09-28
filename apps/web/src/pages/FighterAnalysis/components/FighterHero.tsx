import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type {
  Fighter,
  HorizonKey,
  Insight,
  InsightKind,
  Match,
  PeriodPoint,
  PeriodSeries,
} from '@smash-tracker/shared';
import { PERIOD_TREND_MIN_PERIODS, confidenceTierFor, toRateValue } from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendLine } from '@/components/charts/TrendLine';
import { FormStrip } from '@/components/charts/FormStrip';
import { CHART_H_COMPACT } from '@/components/charts/tokens';
import { HorizonStatRow } from '@/components/analytics/HorizonStatRow';
import { MatchTypeShareBar } from '@/components/analytics/MatchTypeShareBar';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import {
  buildFormStripEvents,
  formStripLabels,
  formStripRecentWindow,
  formStripWindowNote,
} from '@/lib/formStripEvents';
import { useFighterName } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import type { DrillDownAxes } from '@/lib/drillDownParams';
import { formatPercent } from '@/lib/formatPercent';

/** UI-SPEC §8.5 / sketch 001-C: the hero strip draws at most the last 60 games. */
const HERO_STRIP_LIMIT = 60;

/** `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated per this codebase's small-helper-duplication convention (see `MatchupChart.tsx`'s `claimChipKindFor`). */
function claimChipKindFor(kind: InsightKind): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** `●●● / ●●○ / ●○○ / ○○○` — duplicated from `Record.tsx`'s own private map (not exported); see the small-helper-duplication convention. */
const CONFIDENCE_GLYPHS: Record<'high' | 'medium' | 'low' | 'none', string> = {
  high: '●●●',
  medium: '●●○',
  low: '●○○',
  none: '○○○',
};

/**
 * Plan 39.1-25 (gap closure, SC6/TRND-04): the axes a hero drill (a trend
 * point or a form-strip set) can write — a subset of `DrillDownAxes`, never
 * `fighterId`/`vsFighterId`/`stageId`/`claimId` (those are never written by
 * this drill; `FighterAnalysisPage.tsx`'s writer also clears any prior
 * `claim`/`stage`/`event`/`from`/`to` before applying these). CR-02
 * (39.1-REVIEW): only `eventKey` — a time window is never a hero drill's
 * identity.
 */
export type FighterHeroDrillAxes = Partial<Pick<DrillDownAxes, 'eventKey'>>;

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
   * CR-02 (39.1-REVIEW): the host's ONE `buildPeriodSeries` result over
   * `fighterMatches`. The host's terminus resolves a period drill's
   * `event=<point.key>` over the SAME base by the key's own grain rule
   * (`periodPointMatchIdsForKey`, WR-02 iteration 2), which is exactly this
   * series' point while the grain is unchanged and keeps resolving after
   * the ladder moves.
   */
  periodSeries: PeriodSeries;
  /**
   * Plan 39.1-25 (gap closure, SC6/TRND-04): the host's ONE URL writer for a
   * trend-point or form-strip-set drill — both call `onDrill({ eventKey })`:
   * a trend point with its own `PeriodPoint.key` (CR-02, 39.1-REVIEW), a
   * form-strip set with its set key.
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
  periodSeries,
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

  const overallRatePercent = baselineAllTime.rate * 100;
  const recentWindow = useMemo(
    () => ({
      fromMs: formNowInsight?.window.fromMs ?? null,
      toMs: formNowInsight?.window.toMs ?? null,
    }),
    [formNowInsight],
  );
  const formStripEvents = useMemo(
    // WR-04 (39.1-REVIEW.md): the SAME builder Matchups uses — manual games
    // split into 3-hour sessions named "Session · <date>", never one
    // `__manual__` bucket captioned "Unknown".
    // Plan 39.1-42: the strip dims nothing when the horizons collapse.
    () =>
      buildFormStripEvents(fighterMatches, formStripRecentWindow(formNowInsight), t, i18n.language),
    [fighterMatches, formNowInsight, t, i18n.language],
  );

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

  // CR-02 (39.1-REVIEW): a period point drills by its own KEY, never by its
  // `[startMs, endMs]` bounds — `eventSession`/`set` groups are not
  // contiguous in time (an interleaved Redemption bracket falls inside a
  // Singles block's window) and `game` points tie on a shared timestamp, so
  // a window listed more games than the point counted. The host's terminus
  // resolves the key through the point's own `matchIds`.
  function handleSelectPeriodPoint(point: PeriodPoint): void {
    onDrill({ eventKey: point.key });
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
        {/* Plan 39.1-43: the kit's horizon stat row (plan 44's pairing hero renders the same piece). */}
        <HorizonStatRow
          matches={fighterMatches}
          horizon={horizon}
          onSelectHorizon={setHorizon}
          disabled={isLoading}
          nowMs={nowMs}
        />

        {/* 4. form strip. min-w-0 (plan 39.1-20 Task 3 [Rule 1]): without
            it, this flex item refuses to shrink below FormStrip's
            unconstrained (every event on one line) max-content width — see
            FormStrip.tsx's own doc comment for the full mechanism. */}
        <div className="flex min-w-0 flex-col gap-2" data-slot="fighter-hero-strip">
          {/* Plan 39.1-42 (sketch 001-C / 003): the kit's head carries the
              overline ("Form · last N games, by event") and the swatch
              legend — the hero no longer prints its own overline. */}
          <FormStrip
            events={formStripEvents}
            limit={HERO_STRIP_LIMIT}
            labels={{
              ...formStripLabels(t),
              // WR-03: names the games actually DRAWN of the total (kit-computed).
              summary: ({ shown, total }) => t('analytics.strip.aria', { count: total, shown }),
              title: t('analytics.strip.title', {
                count: Math.min(HERO_STRIP_LIMIT, fighterMatches.length),
              }),
              empty: <span>{t('analytics.strip.empty')}</span>,
              windowNote: formStripWindowNote({ insight: formNowInsight, horizon, t }),
            }}
            onSelectSet={(setKey) => onDrill({ eventKey: setKey })}
          />
        </div>

        {/* 5. period trend */}
        <div className="flex flex-col gap-2" data-slot="fighter-hero-trend">
          <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
            {t(`fighterAnalysis.hero.trendTitle.${periodSeries.grain}`)}
          </p>
          {/* Plan 39.1-37 (UI-SPEC §11): the legend names the hollow rule
              whenever the drawn plot carries a sub-floor period. */}
          {periodSeries.points.length >= PERIOD_TREND_MIN_PERIODS &&
            periodSeries.points.some((point) => point.subFloor) && (
              <p
                className="truncate text-xs leading-4 text-muted-foreground"
                data-slot="fighter-hero-trend-legend"
              >
                {t('analytics.trend.legendHollow')}
              </p>
            )}
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
              // Plan 39.1-37 (UI-SPEC §7.13, sketch 001-C): "48% all time".
              referenceLabel: t('analytics.trend.referenceLabel', {
                rate: `${Math.round(overallRatePercent)}%`,
              }),
            }}
          />
        </div>

        {/* 6. by match type */}
        <MatchTypeShareBar matches={fighterMatches} horizon={horizon} nowMs={nowMs} />

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
