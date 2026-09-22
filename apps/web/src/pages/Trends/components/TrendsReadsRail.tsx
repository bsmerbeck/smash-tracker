import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import {
  ACCOUNT_SCOPE,
  INSIGHT_TEMPLATES,
  RAIL_CARD_CAP,
  assembleRail,
  scoreInsight,
} from '@smash-tracker/shared';
import {
  InsightRail,
  type InsightRailCard,
  type InsightRailShape,
} from '@/components/analytics/InsightRail';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { InsightLine } from '@/components/analytics/InsightLine';
import { UnlocksNext, type UnlocksNextMeter } from '@/components/analytics/UnlocksNext';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { buildInsightDoors, type InsightDoorDescriptor } from '@/components/analytics/insightDoors';
import { RatingModelNote } from '@/components/RatingModelNote';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { formatPercent } from '@/lib/formatPercent';

/**
 * The three account-scoped cards this rail draws from (TRND-02/D-09):
 * `RatingMove`, `TiltCost`, `SessionFatigue`, plus the two D-14 back-fill
 * FACT templates (WR-A03, 39.1-REVIEW.md). NOTE: `bestMatchup`/
 * `worstMatchup` both guard `scope.kind !== 'character'` internally and
 * this rail runs at `ACCOUNT_SCOPE`, so they never actually contribute a
 * card here today — they're wired for consistency with the other two
 * rails. Unlike `FighterInsightRail`/`MatchDataRail`, this rail's own three
 * templates CAN all legitimately land on `hidden`/hidden-equivalent states
 * at once for a real account on the `last30` horizon, in which case
 * `rail.ts`'s synthetic fallback still fires — `railBackfillRegression.test.ts`
 * documents this residual case against the shared 8k fixture; it is why the
 * fallback's OWN copy was made honest (a distinct `insights.rail.unavailable`
 * key with no games-needed claim) rather than relying on back-fill wiring
 * alone. Resolved once at module scope: the registry is a static, closed
 * array.
 */
const RATING_MOVE_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'ratingMove')!;
const TILT_COST_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'tiltCost')!;
const SESSION_FATIGUE_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'sessionFatigue')!;
const BEST_MATCHUP_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'bestMatchup')!;
const WORST_MATCHUP_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'worstMatchup')!;
const RAIL_TEMPLATES = [
  RATING_MOVE_TEMPLATE,
  TILT_COST_TEMPLATE,
  SESSION_FATIGUE_TEMPLATE,
  BEST_MATCHUP_TEMPLATE,
  WORST_MATCHUP_TEMPLATE,
];

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
  insight: Insight,
  t: TFunction,
  subjectPath: (personalPath: string) => string,
  extraDoors: ReactNode[] = [],
): InsightCardDoors | undefined {
  const descriptors = buildInsightDoors({ insight, subjectPath });
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
  const claim = insight.recent;
  if (claim.kind !== 'evidenced') {
    return '';
  }
  const record = `${claim.value.wins}–${claim.value.losses}`;
  // WR-C05 (39.1-REVIEW.md): route through the one shared, locale-aware
  // percent formatter instead of a bare `${Math.round(x * 100)}%` template
  // literal, which baked in the English convention (no space before `%`)
  // inside every locale's translated evidence sentence.
  const rate = formatPercent(claim.value.rate, locale);
  const tier = claim.sample.confidenceTier;
  const cue = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: claim.value.total }) : '';
  const baselineClaim = insight.baseline;
  const baselineRate =
    baselineClaim.kind === 'evidenced' ? formatPercent(baselineClaim.value.rate, locale) : '';
  const baselineGames = baselineClaim.kind === 'evidenced' ? baselineClaim.value.total : 0;
  return t(`insights.evidence.twoHorizon.${insight.horizon}`, {
    recentRecord: `${record} · ${rate}`,
    baselineRate,
    baselineGames,
    cue,
  });
}

function buildSpan(insight: Insight, t: TFunction): string | undefined {
  if (insight.window.fromMs == null || insight.window.toMs == null) {
    return undefined;
  }
  return t('insights.evidence.span', {
    count: insight.window.games,
    from: new Date(insight.window.fromMs).toLocaleDateString(),
    to: new Date(insight.window.toMs).toLocaleDateString(),
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
    for (const template of RAIL_TEMPLATES) {
      try {
        const results = template.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs });
        for (const insight of results) {
          if (!dismissedIds.includes(insight.id)) {
            built.push({ ...insight, salience: scoreInsight(insight, nowMs) });
          }
        }
      } catch (err) {
        // WR-C03 (39.1-REVIEW.md): a template crash must not silently drop
        // its card with zero signal — `template.id` carries no user
        // identifiers, only the closed template-registry id.
        console.error('[insight-rail] template failed', template.id, err);
        continue;
      }
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
}

/**
 * The centre rail of the Trends Pro desk (UI-SPEC §8.2 Row 3, TRND-02,
 * INS-05): the closed `InsightRail` primitive wired to the real engine at
 * whole-account scope — `RatingMove`, `TiltCost` and `SessionFatigue`.
 * `RatingMove`'s card carries the rating-model door, demoting the page-level
 * `RatingModelNote` banner (UI-SPEC §8.2's "Own-account only" note). Session
 * fatigue always renders its standing caveat, in every rendered state — the
 * engine supplies it in `copy.values.caveat` and this rail must not drop it.
 */
export function TrendsReadsRail({
  insights,
  dismissedIds,
  dismiss,
  restoreAll,
  horizon,
}: TrendsReadsRailProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [showRatingModelNote, setShowRatingModelNote] = useState(false);

  const accountName = t('trends.title');

  const insightById = useMemo(() => new Map(insights.map((i) => [i.id, i])), [insights]);

  const assembled = useMemo(() => assembleRail({ insights, cap: RAIL_CARD_CAP }), [insights]);

  function insightToRailCard(insight: Insight): InsightRailCard {
    const chipKind = claimChipKindFor(insight.kind);
    const verdict = buildTrendsVerdict(insight, t, accountName);
    const evidence = buildEvidenceLine(insight, t, i18n.language);
    const span = buildSpan(insight, t);
    const isRatingMove = insight.templateId === 'ratingMove';
    const isSessionFatigue = insight.templateId === 'sessionFatigue';
    const caveat = isSessionFatigue ? t('insights.sessionFatigue.caveat') : undefined;
    const ratingModelButton = isRatingMove ? (
      <button type="button" key="ratingModel" onClick={() => setShowRatingModelNote((v) => !v)}>
        {t('insights.door.ratingModelNote')}
      </button>
    ) : null;
    const doors = buildDoorNodes(
      insight,
      t,
      subjectPath,
      ratingModelButton ? [ratingModelButton] : [],
    );
    return {
      id: insight.id,
      render: ({ onDismiss }) => (
        <InsightCard
          key={insight.id}
          chip={<ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />}
          name={accountName}
          verdict={verdict}
          evidence={evidence}
          span={span}
          caveat={caveat}
          doors={doors}
          onDismiss={onDismiss}
          dismissLabel={t('insights.rail.dismiss')}
        />
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
      render: () => <UnlocksNext key={id} chip={chip} name={accountName} meters={tuple} />,
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

  const legend = (
    <>
      <ClaimChip kind="fact" label={t('insights.kind.fact')} />
      <ClaimChip kind="trend" label={t('insights.kind.trend')} />
      <ClaimChip kind="suggestion" label={t('insights.kind.suggestion')} />
    </>
  );

  const fallbackCard = (
    <InsightCard
      chip={<ClaimChip kind="fact" label={t('insights.kind.fact')} />}
      name={accountName}
      verdict={t('insights.rail.unavailable')}
      evidence=""
    />
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
      />
      {showRatingModelNote && <RatingModelNote />}
    </div>
  );
}
