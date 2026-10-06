import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import {
  ACCOUNT_SCOPE,
  RAIL_CARD_CAP,
  TRENDS_READ_TEMPLATES,
  assembleTrendsRail,
  buildTrendsBackfillInsights,
  isRailFallbackInsight,
  scoreInsight,
} from '@smash-tracker/shared';
import {
  InsightRail,
  selectVisible,
  type InsightRailCard,
  type InsightRailShape,
} from '@/components/analytics/InsightRail';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { InsightLine } from '@/components/analytics/InsightLine';
import { UnlocksNext, type UnlocksNextMeter } from '@/components/analytics/UnlocksNext';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { buildInsightDoors, type InsightDoorDescriptor } from '@/components/analytics/insightDoors';
import { buildInsightEvidenceLine } from '@/components/analytics/insightEvidenceLine';
import { RatingModelNote } from '@/components/RatingModelNote';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { formatDate } from '@/lib/format';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { TrendsReadMark } from '@/pages/Trends/components/TrendsReadMarks';
import { trendsReadMarkKind } from '@/pages/Trends/components/trendsReadMarkKind';

/** `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated per this codebase's small-helper-duplication convention. */
function claimChipKindFor(kind: Insight['kind']): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** Every one of the three rail templates supplies its own complete `copy.values` — the only gap is the engine's degenerate account-scope FALLBACK insight (`rail.ts`'s `FALLBACK_LOCKED_INSIGHT`, templateId `formNow`, copy key `insights.rail.unavailable` as of WR-A03), which needs a host-composed `{{entity}}`. */
function copyValuesWithEntity(
  insight: Insight,
  accountName: string,
): Record<string, string | number> {
  return { entity: accountName, ...insight.copy.values };
}

/**
 * Plan 39.1-24 (gap closure, Task 2): exported so a host page can build the
 * SAME rendered verdict sentence this rail uses on a card, for
 * `FilteredMatchList`'s `claimSummary` prop — mirrors
 * `FighterInsightRail.tsx`'s `buildInsightVerdict`.
 */
export function buildTrendsVerdict(insight: Insight, t: TFunction, accountName: string): string {
  return t(insight.copy.key, copyValuesWithEntity(insight, accountName));
}

/** Duplicated per this codebase's small-helper-duplication convention (mirrors `FighterInsightRail.tsx`'s own precedent). */
function insightDoorLabel(door: InsightDoorDescriptor, t: TFunction): string {
  if (door.kind === 'games') return t('insights.door.seeGames', { count: door.count });
  if (door.kind === 'matchup') return t('insights.door.openMatchup');
  if (door.kind === 'opponent') return t('insights.door.openOpponent');
  return t('insights.door.openMatchup');
}

/**
 * Plan 39.1-24 (gap closure, Task 2): the counted-games door (from
 * `buildInsightDoors`) leads; `extraDoors` (the rating-move card's existing
 * "Rating model note" toggle button, a LOCAL UI affordance never built by
 * `buildInsightDoors` — its `'ratingModel'` kind has no
 * `FALLBACK_ROUTE_BY_KIND` mapping) follow, capped at 3 total.
 */
function buildDoorNodes(
  descriptors: InsightDoorDescriptor[],
  t: TFunction,
  extraDoors: ReactNode[] = [],
): InsightCardDoors | undefined {
  const doorLinks = descriptors.map((door) => (
    <Link key={door.kind} to={door.href}>
      {insightDoorLabel(door, t)}
    </Link>
  ));
  const nodes = [...doorLinks, ...extraDoors].slice(0, 3);
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return [nodes[0]!] as const;
  if (nodes.length === 2) return [nodes[0]!, nodes[1]!] as const;
  return [nodes[0]!, nodes[1]!, nodes[2]!] as const;
}

function buildEvidenceLine(insight: Insight, t: TFunction, locale: string): string {
  // Plan 39.1-52: every caption comes from the one shared builder, labelled by
  // its sample's (template, state) shape. Only TiltCost / SessionFatigue keep
  // this rail's own 'host' sentences below.
  if (insight.templateId !== 'tiltCost' && insight.templateId !== 'sessionFatigue') {
    return buildInsightEvidenceLine(insight, t, locale) ?? '';
  }
  const claim = insight.recent;
  if (claim.kind !== 'evidenced') {
    return '';
  }
  const record = `${claim.value.wins}–${claim.value.losses}`;
  const tier = claim.sample.confidenceTier;
  // TiltCost pools every spot of the account's history and SessionFatigue
  // every session — lifetime / cohort samples, never a recent horizon. Card
  // states that reach here always carry a tier (n at least 8); a tier-less
  // one falls back to the cue-less single-sample line.
  if (!tier) {
    return t('insights.evidence.single', { record, context: 'bare' });
  }
  const tierLabel = t(`insights.evidence.tier.${tier}`);
  if (insight.templateId === 'tiltCost') {
    return t('insights.evidence.spots', {
      record,
      count: claim.value.total,
      tier: tierLabel,
    });
  }
  const lateGameNumber = Number(insight.copy.values.lateGameNumber);
  return t('insights.evidence.longSessions', {
    count: Number(insight.copy.values.longSessionCount),
    games: lateGameNumber - 1,
    tier: tierLabel,
  });
}

function buildSpan(insight: Insight, t: TFunction, locale: string): string | undefined {
  // Plan 39.1-40: one named event is its own window — no span line.
  if (insight.templateId === 'lastEventRecap') {
    return undefined;
  }
  if (insight.window.fromMs == null || insight.window.toMs == null) {
    return undefined;
  }
  return t('insights.evidence.span', {
    count: insight.window.games,
    from: formatDate(insight.window.fromMs, locale),
    to: formatDate(insight.window.toMs, locale),
  });
}

export interface UseTrendsInsightsInput {
  matches: Match[];
  horizon: HorizonKey;
}

export interface UseTrendsInsightsResult {
  insights: Insight[];
  dismissedIds: string[];
  dismiss: (id: string) => void;
  restoreAll: () => void;
}

/**
 * Plan 39.1-24 (gap closure, Task 2): exported so a host page calls this
 * ONCE and hands the result DOWN to both `TrendsReadsRail` (which renders
 * the cards/doors) and its own page-level `FilteredMatchList` terminus
 * (whose `resolveClaim` needs the SAME `Insight[]` a rendered door's
 * `claim=<id>` was built from) — mirrors `FighterInsightRail.tsx`'s
 * `useFighterInsights`. `TrendsReadsRail` itself no longer computes
 * `insights`; it takes the result as props.
 */
export function useTrendsInsights({
  matches,
  horizon,
}: UseTrendsInsightsInput): UseTrendsInsightsResult {
  const { dismissedIds, dismiss, restoreAll } = useInsightDismissals();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  const insights = useMemo(() => {
    const built: Insight[] = [];
    const keep = (insight: Insight) => {
      if (!dismissedIds.includes(insight.id)) {
        built.push({ ...insight, salience: scoreInsight(insight, nowMs) });
      }
    };
    for (const template of TRENDS_READ_TEMPLATES) {
      try {
        template.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs }).forEach(keep);
      } catch (err) {
        // WR-C03 (39.1-REVIEW.md): a template crash must not silently drop
        // its card with zero signal — `template.id` carries no user
        // identifiers, only the closed template-registry id.
        console.error('[insight-rail] template failed', template.id, err);
        continue;
      }
    }
    // Plan 39.1-40 (D-14): the engine's account-scope FACT back-fill joins
    // the SAME array (TrendsPage's terminus resolves its claims from it).
    try {
      buildTrendsBackfillInsights({ matches, horizon, nowMs }).forEach(keep);
    } catch (err) {
      // T-39.1-40-04: a fixed label and the error only — no identifiers.
      console.error('[insight-rail] backfill failed', err);
    }
    return built;
  }, [matches, horizon, nowMs, dismissedIds]);

  return { insights, dismissedIds, dismiss, restoreAll };
}

export interface TrendsReadsRailProps {
  /** The one shared computation — see `useTrendsInsights` above. */
  insights: Insight[];
  dismissedIds: string[];
  dismiss: (id: string) => void;
  restoreAll: () => void;
  horizon: HorizonKey;
  /**
   * Plan 36-11: true when the page shows a Rating figure (the Trends hero's
   * `buildTrendsHero(matches).currentRating != null`). Drives the standalone
   * rating-model door when no visible RatingMove card carries it.
   */
  hasRating?: boolean;
}

/** The ids InsightRail last reported, tagged with the inputs they were reported for. */
interface ReportedVisibleIds {
  railKey: string;
  dismissedKey: string;
  ids: string[];
}

/** Joins ids into a comparison key; insight ids never contain a NUL. */
const ID_KEY_SEPARATOR = '\u0000';

/**
 * The centre rail of the Trends Pro desk (UI-SPEC §8.2 Row 3, TRND-02,
 * INS-05): the closed `InsightRail` primitive wired to the real engine at
 * whole-account scope — `RatingMove`, `TiltCost` and `SessionFatigue`, plus
 * the engine's D-14 FACT back-fill (Best / Toughest record, LastEventRecap;
 * plan 39.1-40, `trendsReads.ts`) when those reads leave free slots and none
 * is locked. Each card is wrapped in a layout-neutral
 * `[data-slot="trends-read-card"]` hook carrying its template id and state
 * (`data-rail-fallback` on the engine's synthetic fallback only).
 * `RatingMove`'s card carries the rating-model door, demoting the page-level
 * `RatingModelNote` banner (UI-SPEC §8.2's "Own-account only" note). Plan
 * 36-11 (36 D-02, UAT 36-5): a rating must never show without a reachable
 * disclosure, so when `hasRating` is set and no RatingMove card is actually
 * rendered (absent, dismissed, cut by the unlocksNext budget, or crashed —
 * decided by InsightRail's own `selectVisible` + `onVisibleIdsChange`, never
 * re-derived here) one standalone door under the rail toggles the same note;
 * the page never shows two doors. Session
 * fatigue always renders its standing caveat, in every rendered state — the
 * engine supplies it in `copy.values.caveat` and this rail must not drop it.
 */
export function TrendsReadsRail({
  insights,
  dismissedIds,
  dismiss,
  restoreAll,
  horizon,
  hasRating = false,
}: TrendsReadsRailProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [showRatingModelNote, setShowRatingModelNote] = useState(false);

  const accountName = t('trends.title');

  const insightById = useMemo(() => new Map(insights.map((i) => [i.id, i])), [insights]);

  // Plan 39.1-40 (INS-01): the engine assembles own reads + back-fill; this
  // rail ranks, sorts and back-fills nothing itself.
  const assembled = useMemo(() => assembleTrendsRail({ insights, cap: RAIL_CARD_CAP }), [insights]);

  function insightToRailCard(insight: Insight): InsightRailCard {
    const chipKind = claimChipKindFor(insight.kind);
    const verdict = buildTrendsVerdict(insight, t, accountName);
    const evidence = buildEvidenceLine(insight, t, i18n.language);
    const span = buildSpan(insight, t, i18n.language);
    const isRatingMove = insight.templateId === 'ratingMove';
    const isSessionFatigue = insight.templateId === 'sessionFatigue';
    const caveat = isSessionFatigue ? t('insights.sessionFatigue.caveat') : undefined;
    const ratingModelButton = isRatingMove ? (
      <button type="button" key="ratingModel" onClick={() => setShowRatingModelNote((v) => !v)}>
        {t('insights.door.ratingModelNote')}
      </button>
    ) : null;
    // One descriptor build per card: the doors AND the mark's games href.
    const descriptors = buildInsightDoors({ insight, subjectPath });
    const doors = buildDoorNodes(descriptors, t, ratingModelButton ? [ratingModelButton] : []);
    const gamesHref = descriptors.find((door) => door.kind === 'games')?.href ?? '';
    // Plan 39.1-40 (sketch 002-C): the evidence mark, only when the card has one.
    const mark =
      trendsReadMarkKind(insight) !== null ? (
        <TrendsReadMark insight={insight} gamesHref={gamesHref} />
      ) : undefined;
    const subLineKey = insight.copy.values.subLineKey;
    const sub = typeof subLineKey === 'string' ? t(subLineKey, insight.copy.values) : undefined;
    return {
      id: insight.id,
      render: ({ onDismiss }) => (
        <div
          data-slot="trends-read-card"
          data-template-id={insight.templateId}
          data-insight-state={insight.state}
          {...(isRailFallbackInsight(insight) ? { 'data-rail-fallback': 'true' } : {})}
        >
          <InsightCard
            key={insight.id}
            chip={<ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />}
            name={accountName}
            verdict={verdict}
            evidence={evidence}
            span={span}
            mark={mark}
            sub={sub}
            caveat={caveat}
            doors={doors}
            onDismiss={onDismiss}
            dismissLabel={t('insights.rail.dismiss')}
          />
        </div>
      ),
    };
  }

  function buildUnlocksNextCard(unlocked: {
    meters: { key: string; have: number; need: number; unit: string }[];
  }): InsightRailCard {
    const chip = (
      <ClaimChip
        locked
        kind="fact"
        label={t('insights.kind.unlocksNext', { defaultValue: 'Unlocks next' })}
      />
    );
    const meters: UnlocksNextMeter[] = unlocked.meters.map((meter) => {
      const insight = insightById.get(meter.key);
      const sentence = insight
        ? t(insight.copy.key, copyValuesWithEntity(insight, accountName))
        : '';
      return {
        sentence,
        have: meter.have,
        need: meter.need,
        countLabel: t('insights.state.lockedMeter', { have: meter.have, need: meter.need }),
      };
    });
    const id = `unlocksNext:${unlocked.meters.map((m) => m.key).join(',')}`;
    const tuple =
      meters.length >= 3
        ? ([meters[0]!, meters[1]!, meters[2]!] as const)
        : ([meters[0]!, meters[1]!] as const);
    return {
      id,
      render: () => (
        <div
          data-slot="trends-read-card"
          data-template-id="unlocksNext"
          data-insight-state="locked"
        >
          <UnlocksNext key={id} chip={chip} name={accountName} meters={tuple} />
        </div>
      ),
    };
  }

  const rail: InsightRailShape = useMemo(() => {
    // A locked insight already summarised inside `unlocksNext` (2+ locked
    // candidates) must not ALSO render as its own regular card — `rail.ts`'s
    // `AssembleRailResult.cards` deliberately keeps `chosen[0]` in `cards`
    // too, leaving the "one or the other" choice to the host (D-14: "one
    // unlock card", singular) — the same de-duplication plan 39.1-14's
    // `FighterInsightRail.tsx` established.
    const dedupeLocked = (candidate: Insight) =>
      !(assembled.unlocksNext && candidate.state === 'locked');
    const cards = assembled.cards.filter(dedupeLocked).map((i) => insightToRailCard(i));
    const promotionQueue = assembled.promotionQueue
      .filter((i) => i.state !== 'locked')
      .map((i) => insightToRailCard(i));
    const lines = assembled.lines.flatMap((insight) => {
      const line = (
        <InsightLine
          key={insight.id}
          text={t(insight.copy.key, copyValuesWithEntity(insight, accountName))}
          tone="steady"
        />
      );
      if (insight.templateId === 'sessionFatigue') {
        // The standing caveat has no line-level slot on `InsightLine` — a
        // second, separate steady line carries it so the sentence is never
        // concatenated onto the verdict text (UI-SPEC §9.2 rule 3).
        return [
          line,
          <InsightLine
            key={`${insight.id}:caveat`}
            text={t('insights.sessionFatigue.caveat')}
            tone="steady"
          />,
        ];
      }
      return [line];
    });
    const unlocksNext = assembled.unlocksNext ? buildUnlocksNextCard(assembled.unlocksNext) : null;
    return { cards, unlocksNext, lines, promotionQueue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembled, insightById, t, accountName, i18n.language, subjectPath]);

  // Plan 36-11: the RatingMove card ids, then which of the rail's ids are
  // really on screen — synchronously the same `selectVisible` InsightRail
  // runs (same rail, same cap), replaced by what InsightRail reports once it
  // has rendered (which also accounts for per-card crashes).
  const ratingMoveIds = useMemo(
    () =>
      new Set(
        [...assembled.cards, ...assembled.promotionQueue]
          .filter((insight) => insight.templateId === 'ratingMove')
          .map((insight) => insight.id),
      ),
    [assembled],
  );
  // Keyed by CONTENT, never identity: `rail` is rebuilt whenever
  // `useSubjectPath`'s fresh closure changes and a host may hand a fresh `[]`
  // of dismissed ids, so identity keys would never match — and would turn the
  // report into a render loop.
  const railKey = [
    ...rail.cards.map((card) => card.id),
    '|',
    ...rail.promotionQueue.map((card) => card.id),
    '|',
    rail.unlocksNext?.id ?? '',
  ].join(ID_KEY_SEPARATOR);
  const dismissedKey = dismissedIds.join(ID_KEY_SEPARATOR);
  const [reportedVisible, setReportedVisible] = useState<ReportedVisibleIds | null>(null);
  const handleVisibleIdsChange = useCallback(
    (ids: string[]) => {
      setReportedVisible((prev) =>
        prev &&
        prev.railKey === railKey &&
        prev.dismissedKey === dismissedKey &&
        prev.ids.join(ID_KEY_SEPARATOR) === ids.join(ID_KEY_SEPARATOR)
          ? prev
          : { railKey, dismissedKey, ids },
      );
    },
    [railKey, dismissedKey],
  );
  const visibleIds = useMemo(() => {
    if (
      reportedVisible &&
      reportedVisible.railKey === railKey &&
      reportedVisible.dismissedKey === dismissedKey
    ) {
      return reportedVisible.ids;
    }
    const selection = selectVisible(rail, dismissedIds, RAIL_CARD_CAP);
    return [
      ...selection.cards.map((card) => card.id),
      ...(selection.unlocksNext ? [selection.unlocksNext.id] : []),
    ];
    // `railKey`/`dismissedKey` are the content of `rail`/`dismissedIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedVisible, railKey, dismissedKey]);
  const ratingDoorOnCard = visibleIds.some((id) => ratingMoveIds.has(id));
  const showStandaloneRatingDoor = hasRating && !ratingDoorOnCard;

  const legend = (
    <>
      <ClaimChip kind="fact" label={t('insights.kind.fact')} />
      <ClaimChip kind="trend" label={t('insights.kind.trend')} />
      <ClaimChip kind="suggestion" label={t('insights.kind.suggestion')} />
    </>
  );

  const fallbackCard = (
    <div
      data-slot="trends-read-card"
      data-template-id="formNow"
      data-insight-state="locked"
      data-rail-fallback="true"
    >
      <InsightCard
        chip={<ClaimChip kind="fact" label={t('insights.kind.fact')} />}
        name={accountName}
        verdict={t('insights.rail.unavailable')}
        evidence=""
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-slot="trends-reads-rail">
      <InsightRail
        rail={rail}
        header={t(`insights.rail.title.${horizon}`)}
        legend={legend}
        labels={{
          dismissedCount: (count) => t('insights.rail.dismissedCount', { count }),
          allDismissed: t('insights.rail.allDismissed'),
          restore: t('insights.rail.restore'),
          railError: t('insights.rail.error'),
        }}
        dismissedIds={dismissedIds}
        onDismiss={dismiss}
        onRestore={restoreAll}
        fallbackCard={fallbackCard}
        cap={RAIL_CARD_CAP}
        onVisibleIdsChange={handleVisibleIdsChange}
      />
      {showStandaloneRatingDoor && (
        <button
          type="button"
          data-slot="trends-rating-model-door"
          className={`self-start text-xs leading-4 underline-offset-4 hover:underline ${MUTED_LINK_TONE}`}
          onClick={() => setShowRatingModelNote((v) => !v)}
        >
          {t('insights.door.ratingModelNote')}
        </button>
      )}
      {showRatingModelNote && <RatingModelNote />}
    </div>
  );
}
