import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  HorizonKey,
  Insight,
  InsightKind,
  InsightScope,
  Match,
  PeriodPoint,
  PeriodSeries,
} from '@smash-tracker/shared';
import { INSIGHT_TEMPLATES, toRateValue } from '@smash-tracker/shared';
import { TrendLine } from '@/components/charts/TrendLine';
import { PERIOD_HERO_VALUE_RANGE_PX } from '@/components/charts/trendGeometry';
import { FormStrip } from '@/components/charts/FormStrip';
import {
  buildFormStripEvents,
  formStripLabels,
  formStripRecentWindow,
  formStripWindowNote,
} from '@/lib/formStripEvents';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { localizedFighterName } from '@/lib/fighterNames';
import { buildInsightEvidenceLine } from '@/components/analytics/insightEvidenceLine';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { useMatchupsContext } from '../MatchupsContext';

/** UI-SPEC §7.13: the trend's unlock floor (8 periods at the 3-game floor) — the locked meter's "of N". Duplicated as a local literal (not imported from `PERIOD_TREND_MIN_PERIODS`); the kit itself counts the periods (plan 39.1-43, PD-43-1). */
const PERIOD_TREND_LOCKED_FLOOR = 8;

/**
 * VIZ-03/INS-05 (UI-SPEC §8.3): the `formNow` template registered in the
 * closed insight registry, looked up by id rather than imported directly —
 * `formNowTemplate` itself is not a public export of `@smash-tracker/shared`
 * (only the composed `INSIGHT_TEMPLATES` registry is), and `registry.ts`'s
 * own doc comment states a caller may invoke `build` with any `InsightScope`
 * its own logic can interpret — this is exactly that reuse (`formNow` at
 * character scope, distinct from its account-scope default). Resolved once
 * at module scope: the registry is a static, closed array.
 */
const FORM_NOW_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow')!;

/** Plan 39.1-42 (PD-42-3, sketch 003 A `STRIP_CAP`): the Matchups strip draws at most 60 games. */
const MATCHUP_STRIP_LIMIT = 60;

/** UI-SPEC §7.8: `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated, not shared, in `MatchupOrPlayerCard.tsx` — mirrors this codebase's established "no shared file for one small mapping" convention (see `bestWorstMatchup.ts`'s doc comment on `groupByOpponentCharacter`). */
export function claimChipKindFor(kind: InsightKind): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/**
 * Builds the character-scoped `InsightScope` for this exact fighter/opponent
 * pairing (D-09's "axis identity supplied at the boundary" discipline —
 * `formNow.ts` itself never derives this). `filter` is the identity function
 * because `matchupMatches` is already pairing-filtered by `MatchupsPage`
 * before it reaches this component; `axes` mirrors `drillDownParams.ts`'s
 * own param names (`fighter`/`vs`).
 */
function buildPairingScope(fighterId: number, opponentId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}:${opponentId}`,
    axes: { fighter: fighterId, vs: opponentId },
    filter: (matches: Match[]) => matches,
  };
}

/**
 * Plan 39.1-13: `formNow` at pairing (character) scope, resolved once and
 * shared by the verdict head (`renderFormNowHead`, called by the pairing hero
 * — plan 39.1-44 — which, like every host, owns the card frame: the Phase 37
 * structural rule `chartKitBoundary.test.ts` enforces is that
 * `MatchupChart.tsx` never imports `ChartCard`) and by `MatchupChart` itself
 * (the form strip's recent-window highlight and the trend's emphasis band
 * both read the SAME resolved window, never a second, independently-resolved
 * one).
 */
export function useMatchupFormNow({
  matchupMatches,
  horizon,
  nowMs: hostNowMs,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
  /** Plan 39.1-44: the host's ONE clock, so the page's FormNow insight and its horizon figures resolve the same windows (D-06 / D-12); omitted, the hook reads its own. */
  nowMs?: number;
}): Insight | null {
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupInsights.tsx`, `useHorizon.ts`).
  const [ownNowMs] = useState(() => Date.now());
  const nowMs = hostNowMs ?? ownNowMs;
  const fighterId = matchupMatches[0]?.fighter_id;
  const opponentId = matchupMatches[0]?.opponent_id;

  return useMemo(() => {
    if (fighterId == null || opponentId == null) return null;
    const scope = buildPairingScope(fighterId, opponentId);
    const built = FORM_NOW_TEMPLATE.build({ matches: matchupMatches, scope, horizon, nowMs });
    return built[0] ?? null;
  }, [fighterId, opponentId, matchupMatches, horizon, nowMs]);
}

/**
 * Plan 39.1-31 (gap closure, D-07/D-15, item 7): true exactly when the
 * engine's `locked` state is really "the last-30 window has fewer than 3
 * games because D-15's 12-month scoped-recency bound emptied or thinned it,
 * while the pairing's lifetime record is evidenced" — the ONE case this
 * plan maps to a truthful whole-sentence key instead of the engine's own
 * `insights.formNow.locked` (which reads "N more games unlock this read", a
 * sentence about games still NEEDED, not about the window being
 * time-bounded — and whose `copy.values.count` is deliberately `gamesNeeded`
 * per CR-A02, wrong for this purpose). The engine itself is unchanged:
 * `ladder.ts` keeps `locked` before `thinRecent` for every horizon; this is
 * a UI-only reinterpretation of an already-produced `locked` insight. Scoped
 * to `horizon === 'last30'` on purpose — only there is "fewer than 3 in the
 * window" exactly "fewer than 3 in the last 12 months" (D-15's bound IS
 * `last30`'s own scoping); `lastEvent`/`last90` are time-bounded in their
 * own right and keep the engine's stock `locked` copy.
 */
function headStatesScopedWindow(insight: Insight): boolean {
  return (
    insight.state === 'locked' &&
    insight.horizon === 'last30' &&
    insight.window.scoped &&
    insight.baseline.kind === 'evidenced'
  );
}

/**
 * Plan 39.1-26 (gap closure): the ONE verdict composition for `formNow` at
 * pairing scope — `entity` is never supplied by the engine (UI-SPEC §9.2
 * rule 7), so this composes it itself before calling `t()`. Shared by
 * `renderFormNowHead` (the slot) and `MatchupsPage.tsx`'s `claimSummary`
 * (the terminus's active-filter summary), so the two never independently
 * re-derive the same sentence.
 *
 * Plan 39.1-31: `headStatesScopedWindow` above maps the D-15 scoped-empty
 * `locked` case to `insights.state.noneRecent.scoped` (0 recent games) or
 * `insights.state.thinRecent.scoped` (1-2) BEFORE falling through to the
 * engine's own `insight.copy.key` — no new key is added under
 * `insights.formNow.*` (the registry's reverse audit forbids an
 * unreachable template key).
 */
export function buildFormNowVerdict(insight: Insight, opponentId: number, t: TFunction): string {
  const fighter = localizedFighterName(opponentId, t);
  if (headStatesScopedWindow(insight)) {
    return insight.window.games === 0
      ? t('insights.state.noneRecent.scoped', { fighter })
      : t('insights.state.thinRecent.scoped', { count: insight.window.games, fighter });
  }
  const entity = `${t('matchups.vs')} ${fighter}`;
  return t(insight.copy.key, { ...insight.copy.values, entity });
}

/**
 * The pairing hero's verdict block (UI-SPEC §7.9): `InsightCard`'s head —
 * claim chip, verdict, evidence — WITHOUT the card's own chrome (no `Card`
 * wrapper, no dismiss). Called by `PairingHero.tsx` (and by
 * `MatchupChart.test.tsx`'s frame wrapper) — `MatchupChart.tsx` itself never
 * renders a card frame.
 *
 * Plan 39.1-44 (PD-44-3): the counted-games door plan 39.1-26 gave this head
 * moved out — the hero owns the card's LAST row (`matchup-form-now-doors`:
 * "See the N games" + "Other pairings"). The head instead takes an optional
 * `meta` node shown beside the claim chip (sketch 003 `leadHtml`'s
 * "Form · <horizon> vs all time").
 */
export function renderFormNowHead(
  insight: Insight,
  opponentId: number,
  t: TFunction,
  locale: string,
  meta?: ReactNode,
): ReactElement {
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = buildFormNowVerdict(insight, opponentId, t);
  // Plan 39.1-52: the one shared evidence builder. The pairing hero cues on
  // the window's own game total (plan 39.1-31: for `locked`,
  // `copy.values.count` is games still needed, the wrong number for a cue).
  const evidence = buildInsightEvidenceLine(insight, t, locale, { cueCount: insight.window.games });

  return (
    <div className="flex flex-col gap-2" data-slot="matchup-form-now">
      <div className="flex flex-wrap items-center gap-2">
        <ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />
        {meta && (
          <span className="text-xs leading-4 text-muted-foreground tabular-nums">{meta}</span>
        )}
      </div>
      <p
        className="text-base leading-6 font-medium text-pretty"
        data-slot="matchup-form-now-verdict"
      >
        {verdict}
      </p>
      {evidence && (
        <p
          className="text-xs leading-4 text-muted-foreground tabular-nums"
          data-slot="matchup-form-now-evidence"
        >
          {evidence}
        </p>
      )}
    </div>
  );
}

/**
 * Ports legacy/src/screens/Matchups/components/MatchupChart — win rate over
 * time for the specific matchup. Phase 39.1 (VIZ-03, INS-05, UI-SPEC §8.3):
 * rebuilt end to end onto the new contract — the `rolling5/10/cumulative`
 * `Select` is gone with NO replacement control (the horizon comes from the
 * page's single `HorizonSwitch`, passed in as the `horizon` prop). This
 * component still owns no card and never imports `ChartCard` (the Phase 37
 * structural split `chartKitBoundary.test.ts` enforces) — `PairingHero.tsx`
 * (plan 39.1-44) supplies the card, rendering `renderFormNowHead` above the
 * stat row and this body (strip + trend) below it.
 *
 * D-07/CHRT-02/Phase 38-04: a click on a trend point writes that point's
 * own `PeriodPoint.key` as the `eventKey` axis (CR-02, 39.1-REVIEW — never
 * its `[startMs, endMs]` window, which over-counts on the non-contiguous
 * `eventSession`/`set` grains and on tied `game` timestamps) via the
 * Matchups context's `setDrillDown` and scrolls to the results-table
 * anchor; a form-strip set click writes its set key the same way. The page
 * supplies `periodSeries` — the SAME series its terminus resolves the key
 * against.
 * Neither adds a second drill-down mechanism — both go through the existing
 * `setDrillDown` context method, which already preserves the ambient
 * `fighter`/`vs` character axes already present in the URL (Phase 38's own
 * `setSearchParams(prev => ...)` merge, untouched by this plan).
 */
export function MatchupChart({
  matchupMatches,
  horizon,
  periodSeries,
  nowMs,
  width,
  height,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
  /** Plan 39.1-44: the host's ONE clock, handed to the FormNow hook this body reads. */
  nowMs?: number;
  /** CR-02 (39.1-REVIEW): the host's ONE `buildMatchupPeriodSeries` (`../lib/matchupPeriodSeries`) result over `matchupMatches` — plotted here, resolved by the host's terminus. */
  periodSeries: PeriodSeries;
  width?: number;
  /** Tests only; the page draws the trend at the sketches' 160px value range (`PERIOD_HERO_VALUE_RANGE_PX`, PD-43-3). */
  height?: number;
}) {
  const { t, i18n } = useTranslation();
  const { setDrillDown } = useMatchupsContext();

  const insight = useMatchupFormNow({ matchupMatches, horizon, nowMs });

  const overallRate = useMemo(() => toRateValue(matchupMatches).rate * 100, [matchupMatches]);

  const recentWindow = useMemo(
    () => ({ fromMs: insight?.window.fromMs ?? null, toMs: insight?.window.toMs ?? null }),
    [insight],
  );

  const formStripEvents = useMemo(
    // Plan 39.1-42: the strip dims nothing when the horizons collapse.
    () => buildFormStripEvents(matchupMatches, formStripRecentWindow(insight), t, i18n.language),
    [matchupMatches, insight, t, i18n.language],
  );

  function handleSelectPeriodPoint(point: PeriodPoint) {
    setDrillDown({ eventKey: point.key });
    document
      .getElementById(MATCHUP_TABLE_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleSelectSet(setKey: string) {
    setDrillDown({ eventKey: setKey });
    document
      .getElementById(MATCHUP_TABLE_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    // min-w-0 (plan 39.1-20 Task 3 [Rule 1]): without it, this flex item
    // refuses to shrink below FormStrip's unconstrained max-content width
    // — see FormStrip.tsx's own doc comment for the full mechanism.
    <div className="flex min-w-0 flex-col gap-4" data-slot="matchup-chart-body">
      <FormStrip
        events={formStripEvents}
        // Plan 39.1-42 (PD-42-3, sketch 003 A): the last 60 games (was 30).
        limit={MATCHUP_STRIP_LIMIT}
        labels={{
          ...formStripLabels(t),
          // WR-03: names the games actually DRAWN of the total (kit-computed).
          summary: ({ shown, total }) => t('analytics.strip.aria', { count: total, shown }),
          // Plan 39.1-42 (sketch 003 `stripSection`): "Form · last N games, by event".
          title: t('analytics.strip.title', {
            count: Math.min(MATCHUP_STRIP_LIMIT, matchupMatches.length),
          }),
          empty: <span>{t('analytics.strip.empty')}</span>,
          // Plan 39.1-31 (item 7): the empty-window note is suppressed exactly
          // when the verdict head already states the scoped-empty window
          // itself (D-15's "No games ... — showing lifetime." sentence).
          windowNote:
            insight && insight.window.games === 0 && headStatesScopedWindow(insight)
              ? undefined
              : formStripWindowNote({ insight, horizon, t }),
        }}
        onSelectSet={handleSelectSet}
      />

      <TrendLine
        mode="period"
        points={periodSeries.points}
        onSelectPoint={handleSelectPeriodPoint}
        referenceRate={overallRate}
        emphasisStartMs={recentWindow.fromMs ?? undefined}
        // Plan 39.1-41 (PD-41-2, sketch 003 `dotSize`): dots by confidence tier.
        dotSizing="tier"
        width={width}
        // Plan 39.1-43 (PD-43-3, sketch 003 `trend(d, { height: 160 })`): the
        // 160px VALUE range; an explicit test height keeps its old meaning.
        {...(height !== undefined ? { height } : { valueRangePx: PERIOD_HERO_VALUE_RANGE_PX })}
        labels={{
          // Plan 39.1-43 (sketch 003 trendSection / trendLegend, PD-43-2).
          title: t(`analytics.trend.title.${periodSeries.grain}`),
          legend: {
            dot: t('analytics.trend.legend.dot'),
            hollow: t('analytics.trend.legendHollow'),
            reference: t('analytics.trend.legend.reference', {
              rate: `${Math.round(overallRate)}%`,
            }),
            band: t(`insights.horizon.${horizon}`),
          },
          // PD-43-1: the kit counts the periods at the 3-game floor.
          lockedSentence: ({ need }) =>
            t(`analytics.trend.lockedPeriods.${periodSeries.grain}`, { count: need }),
          lockedCountLabel: ({ have }) =>
            t('analytics.trend.lockedMeter', { have, need: PERIOD_TREND_LOCKED_FLOOR }),
          tableToggle: t('analytics.trend.tableToggle'),
          tableHeaders: {
            period: t('analytics.trend.tableHeaders.period'),
            record: t('analytics.trend.tableHeaders.record'),
            rate: t('analytics.trend.tableHeaders.rate'),
            sample: t('analytics.trend.tableHeaders.sample'),
          },
          // Plan 39.1-41 (sketch 003 / 001-C): "63% all time" — the exact call
          // FighterHero makes (plan 37), never a bare rate.
          referenceLabel: t('analytics.trend.referenceLabel', {
            rate: `${Math.round(overallRate)}%`,
          }),
        }}
      />
    </div>
  );
}
