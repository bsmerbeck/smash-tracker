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
import {
  INSIGHT_TEMPLATES,
  confidenceTierFor,
  parseExternalId,
  toRateValue,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { TrendLine } from '@/components/charts/TrendLine';
import { FormStrip, type FormStripEvent, type FormStripSet } from '@/components/charts/FormStrip';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { localizedFighterName } from '@/lib/fighterNames';
import { formatPercent } from '@/lib/formatPercent';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { useMatchupsContext } from '../MatchupsContext';

/** UI-SPEC §7.13: the trend's total-period-count unlock floor. Duplicated as a local literal (not imported from `PERIOD_TREND_MIN_PERIODS`) only for the locked-sentence's own `count` arithmetic below — the kit component itself already reads the shared constant. */
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
 * shared by the insight-slot head (`renderFormNowHead`, called by the HOST —
 * `MatchupsPage.tsx` owns `ChartCard`, per the Phase 37 structural frame
 * rule `chartKitBoundary.test.ts` enforces: `MatchupChart.tsx` never imports
 * `ChartCard`) and by `MatchupChart` itself (the form strip's recent-window
 * highlight and the trend's emphasis band both read the SAME resolved
 * window, never a second, independently-resolved one).
 */
export function useMatchupFormNow({
  matchupMatches,
  horizon,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
}): Insight | null {
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupInsights.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());
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
 * Plan 39.1-26 (gap closure): the ONE verdict composition for `formNow` at
 * pairing scope — `entity` is never supplied by the engine (UI-SPEC §9.2
 * rule 7), so this composes it itself before calling `t()`. Shared by
 * `renderFormNowHead` (the slot) and `MatchupsPage.tsx`'s `claimSummary`
 * (the terminus's active-filter summary), so the two never independently
 * re-derive the same sentence.
 */
export function buildFormNowVerdict(insight: Insight, opponentId: number, t: TFunction): string {
  const entity = `${t('matchups.vs')} ${localizedFighterName(opponentId, t)}`;
  return t(insight.copy.key, { ...insight.copy.values, entity });
}

/**
 * The insight slot's content (UI-SPEC §7.9): `InsightCard`'s head — claim
 * chip, verdict, evidence — WITHOUT the card's own chrome (no `Card`
 * wrapper, no dismiss). Called by `MatchupsPage.tsx` to build `ChartCard`'s
 * `insight` prop — `MatchupChart.tsx` itself never renders `ChartCard`.
 *
 * Plan 39.1-26 (gap closure): gains an optional trailing `door` — the
 * counted-games door `MatchupsPage.tsx` builds via `buildInsightDoors`,
 * rendered as a `Button asChild` wrapping the host's own `<Link>` inside
 * `data-slot="matchup-form-now-doors"`. `undefined` renders no doors row at
 * all (a zero-game window never prints "See the 0 games").
 */
export function renderFormNowHead(
  insight: Insight,
  opponentId: number,
  t: TFunction,
  locale: string,
  door?: ReactNode,
): ReactElement {
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = buildFormNowVerdict(insight, opponentId, t);

  // WR-C05 (39.1-REVIEW.md): read the raw rate off the Insight's own
  // `recent`/`baseline` claims and format it through the one shared,
  // locale-aware percent formatter, rather than the engine's pre-formatted
  // `copy.values.rate`/`.baselineRate` strings (always English-convention
  // "42%").
  const recentRateText =
    insight.recent.kind === 'evidenced' ? formatPercent(insight.recent.value.rate, locale) : '';
  const baselineRateText =
    insight.baseline.kind === 'evidenced' ? formatPercent(insight.baseline.value.rate, locale) : '';
  const recentRecord = `${insight.copy.values.record ?? ''} · ${recentRateText}`;
  const count = typeof insight.copy.values.count === 'number' ? insight.copy.values.count : 0;
  const tier = confidenceTierFor(count);
  const cue = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count }) : '';
  const evidence = t(`insights.evidence.twoHorizon.${insight.horizon}`, {
    recentRecord,
    baselineRate: baselineRateText,
    baselineGames: insight.copy.values.baselineGames ?? 0,
    cue,
  });

  return (
    <div className="flex flex-col gap-2" data-slot="matchup-form-now">
      <ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />
      <p
        className="line-clamp-3 text-base leading-6 font-medium text-pretty"
        data-slot="matchup-form-now-verdict"
      >
        {verdict}
      </p>
      <p
        className="text-xs leading-4 text-muted-foreground tabular-nums"
        data-slot="matchup-form-now-evidence"
      >
        {evidence}
      </p>
      {door && (
        <div className="flex flex-wrap gap-2" data-slot="matchup-form-now-doors">
          <Button asChild size="sm">
            {door}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The form-strip's set key: a real parsed `externalId` set id when one
 * exists, else a synthetic `game:<matchId>` key for a single manually-
 * entered game. `MatchupsPage`'s `FilteredMatchList` `eventKeyForMatch`
 * resolver (`formStripEventKeyForMatch` below) uses this EXACT rule, so a
 * set-row click's `eventKey` axis always narrows to precisely the games the
 * strip drew that set from.
 */
function formStripSetKey(match: Match): string {
  const parsed = parseExternalId(match.externalId);
  return parsed ? parsed.setId : `game:${match.id}`;
}

/** The resolver `MatchupsPage` passes to `FilteredMatchList` so a form-strip set click's `event=` axis actually narrows the results list — see `formStripSetKey`'s doc comment. */
export function formStripEventKeyForMatch(match: Match): string {
  return formStripSetKey(match);
}

/**
 * UI-SPEC §7.10: event -> set -> game, oldest first, grouped only (never
 * binned/windowed — `FormStrip` itself trims to `limit`). A match with no
 * parseable `externalId` becomes its own single-game set (see
 * `formStripSetKey`) rather than a session-split reduction, keeping this
 * host-side grouping simple and 1:1 with `formStripEventKeyForMatch`.
 * `recentWindow` marks each set `inRecentWindow` from the SAME
 * `Insight.window` `formNow` already resolved — one source of truth for
 * "recent," never re-derived.
 */
function buildFormStripEvents(
  matches: Match[],
  recentWindow: { fromMs: number | null; toMs: number | null },
  t: TFunction,
): FormStripEvent[] {
  const sorted = [...matches].sort((a, b) => a.time - b.time);
  const byEvent = new Map<string, Match[]>();
  for (const match of sorted) {
    const raw = match.eventName ?? match.tournamentName;
    const trimmed = raw?.trim();
    const key = trimmed && trimmed.length > 0 ? trimmed : '__manual__';
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
      const setKey = formStripSetKey(match);
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

/** UI-SPEC §7.13: the cumulative rate at (and through) each period point, as a context series parallel to `points` — never a second binning pass, just a running reduction over the SAME already-binned points. */
function computeCumulativeContextPercents(points: { wins: number; total: number }[]): number[] {
  let wins = 0;
  let total = 0;
  return points.map((point) => {
    wins += point.wins;
    total += point.total;
    return total > 0 ? (wins / total) * 100 : 0;
  });
}

/**
 * Ports legacy/src/screens/Matchups/components/MatchupChart — win rate over
 * time for the specific matchup. Phase 39.1 (VIZ-03, INS-05, UI-SPEC §8.3):
 * rebuilt end to end onto the new contract — the `rolling5/10/cumulative`
 * `Select` is gone with NO replacement control (the horizon comes from the
 * page's single `HorizonSwitch`, passed in as the `horizon` prop). This
 * component still owns no card and never imports `ChartCard` (the Phase 37
 * structural split `chartKitBoundary.test.ts` enforces) — `MatchupsPage.tsx`
 * supplies the frame, reading `useMatchupFormNow`/`renderFormNowHead` above
 * to build the `insight` prop.
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
  width,
  height,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
  /** CR-02 (39.1-REVIEW): the host's ONE `buildPeriodSeries` result over `matchupMatches` — plotted here, resolved by the host's terminus. */
  periodSeries: PeriodSeries;
  width?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  const { setDrillDown } = useMatchupsContext();

  const insight = useMatchupFormNow({ matchupMatches, horizon });

  const overallRate = useMemo(() => toRateValue(matchupMatches).rate * 100, [matchupMatches]);

  const contextRatePercents = useMemo(
    () => computeCumulativeContextPercents(periodSeries.points),
    [periodSeries.points],
  );

  const recentWindow = useMemo(
    () => ({ fromMs: insight?.window.fromMs ?? null, toMs: insight?.window.toMs ?? null }),
    [insight],
  );

  const formStripEvents = useMemo(
    () => buildFormStripEvents(matchupMatches, recentWindow, t),
    [matchupMatches, recentWindow, t],
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
        limit={30}
        labels={{
          summary: t('analytics.strip.aria', { count: matchupMatches.length }),
          legend: t('analytics.strip.legend'),
          shownOfTotal:
            matchupMatches.length > 30
              ? t('analytics.strip.shownOf', { shown: 30, total: matchupMatches.length })
              : undefined,
          empty: <span>{t('analytics.strip.empty')}</span>,
          windowEmpty:
            insight && insight.window.games === 0
              ? t(`analytics.strip.windowEmpty.${horizon}`)
              : undefined,
        }}
        onSelectSet={handleSelectSet}
      />

      <TrendLine
        mode="period"
        points={periodSeries.points}
        onSelectPoint={handleSelectPeriodPoint}
        referenceRate={overallRate}
        emphasisStartMs={recentWindow.fromMs ?? undefined}
        contextRatePercents={contextRatePercents}
        width={width}
        height={height}
        labels={{
          lockedSentence: t(`analytics.trend.lockedPeriods.${periodSeries.grain}`, {
            count: Math.max(0, PERIOD_TREND_LOCKED_FLOOR - periodSeries.points.length),
          }),
          lockedCountLabel: t('insights.state.lockedMeter', {
            have: periodSeries.points.length,
            need: PERIOD_TREND_LOCKED_FLOOR,
          }),
          tableToggle: t('analytics.trend.tableToggle'),
          tableHeaders: {
            period: t('analytics.trend.tableHeaders.period'),
            record: t('analytics.trend.tableHeaders.record'),
            rate: t('analytics.trend.tableHeaders.rate'),
            sample: t('analytics.trend.tableHeaders.sample'),
          },
          referenceLabel: `${Math.round(overallRate)}%`,
        }}
      />
    </div>
  );
}
