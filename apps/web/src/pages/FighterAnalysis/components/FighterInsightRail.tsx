import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, InsightScope, Match } from '@smash-tracker/shared';
import {
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
import { useFighterName } from '@/hooks/useFighterName';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { formatPercent } from '@/lib/formatPercent';

/**
 * The five cards this rail draws from — FormNow is excluded (it lives in
 * the hero, UI-SPEC §8.1). `bestMatchup`/`worstMatchup` are the D-14
 * back-fill FACT templates (WR-A03, 39.1-REVIEW.md): without them, a large,
 * steady fighter whose `characterMovers`/`rivalMovers` both settle into
 * `steady` (a line, not a card) and whose `lastEventRecap` has no named
 * event to recap could exhaust every candidate and fall through to
 * `rail.ts`'s synthetic fallback card — confirmed reproducible against the
 * shared 8,000-game fixture before this fix (see
 * `39.1-REVIEW-FIX-part-A.md`'s WR-A03 section). Resolved once at module
 * scope: the registry is a static, closed array.
 */
const CHARACTER_MOVERS_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'characterMovers')!;
const RIVAL_MOVERS_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'rivalMovers')!;
const LAST_EVENT_RECAP_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'lastEventRecap')!;
const BEST_MATCHUP_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'bestMatchup')!;
const WORST_MATCHUP_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'worstMatchup')!;
const RAIL_TEMPLATES = [
  CHARACTER_MOVERS_TEMPLATE,
  RIVAL_MOVERS_TEMPLATE,
  LAST_EVENT_RECAP_TEMPLATE,
  BEST_MATCHUP_TEMPLATE,
  WORST_MATCHUP_TEMPLATE,
];

/** `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated per this codebase's small-helper-duplication convention. */
function claimChipKindFor(kind: Insight['kind']): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

function buildFighterScope(fighterId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches: Match[]) => matches,
  };
}

/** Every one of the three rail templates supplies its own complete `copy.values` (fighter/opponent/event names are already engine-composed) — the only gap is the engine's degenerate account-scope FALLBACK insight (`rail.ts`'s `FALLBACK_LOCKED_INSIGHT`, templateId `formNow`, copy key `insights.rail.unavailable` as of WR-A03), which needs a host-composed `{{entity}}`. Spread AFTER `entity` so a template that already supplies its own values never loses one. */
function copyValuesWithEntity(
  insight: Insight,
  fighterName: string,
): Record<string, string | number> {
  return { entity: fighterName, ...insight.copy.values };
}

/**
 * Plan 39.1-24 (gap closure, orchestrator Finding 8): exported so a host page
 * can build the SAME rendered verdict sentence this rail uses on a card, for
 * `FilteredMatchList`'s `claimSummary` prop — without re-deriving the copy
 * logic a second time (`FighterAnalysisPage.tsx` imports this directly).
 */
export function buildInsightVerdict(insight: Insight, t: TFunction, fighterName: string): string {
  return t(insight.copy.key, copyValuesWithEntity(insight, fighterName));
}

/**
 * Plan 39.1-24: this rail's own door-label mapping — duplicated per this
 * file's established small-helper-duplication convention (see
 * `claimChipKindFor` above). `buildInsightDoors` already orders the counted-
 * games door first, so this only renders and caps at 3 (`InsightCardDoors`'s
 * own type already enforces the cap; the `.slice(0, 3)` below is a defensive
 * belt-and-suspenders match, never relied on alone).
 */
function insightDoorLabel(door: InsightDoorDescriptor, t: TFunction): string {
  if (door.kind === 'games') return t('insights.door.seeGames', { count: door.count });
  if (door.kind === 'matchup') return t('insights.door.openMatchup');
  if (door.kind === 'opponent') return t('insights.door.openOpponent');
  return t('insights.door.openMatchup');
}

function buildDoorNodes(
  insight: Insight,
  t: TFunction,
  subjectPath: (personalPath: string) => string,
): InsightCardDoors | undefined {
  const descriptors = buildInsightDoors({ insight, subjectPath }).slice(0, 3);
  if (descriptors.length === 0) return undefined;
  const nodes = descriptors.map((door) => (
    <Link key={door.kind} to={door.href}>
      {insightDoorLabel(door, t)}
    </Link>
  ));
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
  if (insight.templateId === 'lastEventRecap') {
    return t('insights.evidence.single', { record, cue });
  }
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
  if (insight.templateId === 'lastEventRecap') {
    // Not D-15 scoped (a single named event is its own natural window).
    return undefined;
  }
  if (insight.window.fromMs == null || insight.window.toMs == null) {
    return undefined;
  }
  return t('insights.evidence.span', {
    count: insight.window.games,
    from: new Date(insight.window.fromMs).toLocaleDateString(),
    to: new Date(insight.window.toMs).toLocaleDateString(),
  });
}

function insightToRailCard(
  insight: Insight,
  t: TFunction,
  fighterName: string,
  locale: string,
  subjectPath: (personalPath: string) => string,
): InsightRailCard {
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = buildInsightVerdict(insight, t, fighterName);
  const evidence = buildEvidenceLine(insight, t, locale);
  const span = buildSpan(insight, t);
  const doors = buildDoorNodes(insight, t, subjectPath);
  return {
    id: insight.id,
    render: ({ onDismiss }) => (
      <InsightCard
        key={insight.id}
        chip={<ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />}
        name={fighterName}
        verdict={verdict}
        evidence={evidence}
        span={span}
        doors={doors}
        onDismiss={onDismiss}
        dismissLabel={t('insights.rail.dismiss')}
      />
    ),
  };
}

function buildUnlocksNextCard(
  unlocked: { meters: { key: string; have: number; need: number; unit: string }[] },
  insightById: Map<string, Insight>,
  t: TFunction,
  fighterName: string,
): InsightRailCard {
  const chip = (
    <ClaimChip
      locked
      kind="fact"
      label={t('insights.kind.unlocksNext', { defaultValue: 'Unlocks next' })}
    />
  );
  const meters: UnlocksNextMeter[] = unlocked.meters.map((meter) => {
    const insight = insightById.get(meter.key);
    const sentence = insight ? t(insight.copy.key, copyValuesWithEntity(insight, fighterName)) : '';
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
    render: () => <UnlocksNext key={id} chip={chip} name={fighterName} meters={tuple} />,
  };
}

export interface UseFighterInsightsInput {
  /** `undefined` before a fighter is resolved on the host page — resolves to zero insights, never a throw. */
  fighterId: number | undefined;
  fighterMatches: Match[];
  horizon: HorizonKey;
}

export interface UseFighterInsightsResult {
  insights: Insight[];
  dismissedIds: string[];
  dismiss: (id: string) => void;
  restoreAll: () => void;
}

/**
 * Plan 39.1-24 (gap closure, orchestrator Finding 8, DD-09 reachability):
 * exported so a host page calls this ONCE and hands the result DOWN to both
 * `FighterInsightRail` (which renders the cards/doors) and its own
 * `FilteredMatchList` terminus (whose `resolveClaim` needs the SAME
 * `Insight[]` a rendered door's `claim=<id>` was built from) — "one insight
 * computation per page", never a second independent build of the same
 * array. `FighterInsightRail` itself no longer computes `insights`; it takes
 * the result as props.
 */
export function useFighterInsights({
  fighterId,
  fighterMatches,
  horizon,
}: UseFighterInsightsInput): UseFighterInsightsResult {
  const { dismissedIds, dismiss, restoreAll } = useInsightDismissals();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const scope = useMemo(
    () => (fighterId != null ? buildFighterScope(fighterId) : null),
    [fighterId],
  );

  const insights = useMemo(() => {
    if (scope == null) {
      return [];
    }
    const built: Insight[] = [];
    for (const template of RAIL_TEMPLATES) {
      try {
        const results = template.build({ matches: fighterMatches, scope, horizon, nowMs });
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
  }, [fighterMatches, scope, horizon, nowMs, dismissedIds]);

  return { insights, dismissedIds, dismiss, restoreAll };
}

export interface FighterInsightRailProps {
  fighterId: number;
  /** The one shared computation — see `useFighterInsights` above. */
  insights: Insight[];
  dismissedIds: string[];
  dismiss: (id: string) => void;
  restoreAll: () => void;
  horizon: HorizonKey;
}

/**
 * The freed right side of the Fighter Analysis hero (T-39.1-14-02, D-12,
 * D-14): the closed rail primitive (plan 39.1-07) wired to the real
 * engine, scoped to ONE fighter — `CharacterMovers`, `LastEventRecap` and
 * `RivalMovers` (FormNow lives in the hero). Every figure reads through the
 * subject-scoped `fighterId`/`insights` the host already resolved
 * (coach-parity: this component itself never resolves a uid).
 */
export function FighterInsightRail({
  fighterId,
  insights,
  dismissedIds,
  dismiss,
  restoreAll,
  horizon,
}: FighterInsightRailProps) {
  const { t, i18n } = useTranslation();
  const fighterName = useFighterName(fighterId);
  const subjectPath = useSubjectPath();

  const insightById = useMemo(() => new Map(insights.map((i) => [i.id, i])), [insights]);

  const assembled = useMemo(() => assembleRail({ insights, cap: RAIL_CARD_CAP }), [insights]);

  const rail: InsightRailShape = useMemo(() => {
    // A locked insight already summarised inside `unlocksNext` (2+ locked
    // candidates) must not ALSO render as its own regular card — `rail.ts`'s
    // `AssembleRailResult.cards` deliberately keeps `chosen[0]` in `cards`
    // too, leaving the "one or the other" choice to the host (D-14: "one
    // unlock card", singular).
    const dedupeLocked = (candidate: Insight) =>
      !(assembled.unlocksNext && candidate.state === 'locked');
    const cards = assembled.cards
      .filter(dedupeLocked)
      .map((i) => insightToRailCard(i, t, fighterName, i18n.language, subjectPath));
    const promotionQueue = assembled.promotionQueue
      .filter((i) => i.state !== 'locked')
      .map((i) => insightToRailCard(i, t, fighterName, i18n.language, subjectPath));
    const lines = assembled.lines.map((insight) => (
      <InsightLine
        key={insight.id}
        text={buildInsightVerdict(insight, t, fighterName)}
        tone="steady"
      />
    ));
    const unlocksNext = assembled.unlocksNext
      ? buildUnlocksNextCard(assembled.unlocksNext, insightById, t, fighterName)
      : null;
    return { cards, unlocksNext, lines, promotionQueue };
  }, [assembled, insightById, t, fighterName, i18n.language, subjectPath]);

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
      name={fighterName}
      verdict={t('insights.rail.unavailable')}
      evidence=""
    />
  );

  return (
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
  );
}
