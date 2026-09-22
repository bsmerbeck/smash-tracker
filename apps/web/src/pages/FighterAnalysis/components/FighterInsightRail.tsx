import { useMemo, useState } from 'react';
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
import { InsightCard } from '@/components/analytics/InsightCard';
import { InsightLine } from '@/components/analytics/InsightLine';
import { UnlocksNext, type UnlocksNextMeter } from '@/components/analytics/UnlocksNext';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { useFighterName } from '@/hooks/useFighterName';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';

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

/** Every one of the three rail templates supplies its own complete `copy.values` (fighter/opponent/event names are already engine-composed) — the only gap is the engine's degenerate account-scope FALLBACK insight (`rail.ts`'s `FALLBACK_LOCKED_INSIGHT`, templateId `formNow`), whose `insights.formNow.locked` key needs a host-composed `{{entity}}`. Spread AFTER `entity` so a template that already supplies its own values never loses one. */
function copyValuesWithEntity(
  insight: Insight,
  fighterName: string,
): Record<string, string | number> {
  return { entity: fighterName, ...insight.copy.values };
}

function buildEvidenceLine(insight: Insight, t: TFunction): string {
  const claim = insight.recent;
  if (claim.kind !== 'evidenced') {
    return '';
  }
  const record = `${claim.value.wins}–${claim.value.losses}`;
  const rate = `${Math.round(claim.value.rate * 100)}%`;
  const tier = claim.sample.confidenceTier;
  const cue = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: claim.value.total }) : '';
  if (insight.templateId === 'lastEventRecap') {
    return t('insights.evidence.single', { record, cue });
  }
  const baselineClaim = insight.baseline;
  const baselineRate =
    baselineClaim.kind === 'evidenced' ? `${Math.round(baselineClaim.value.rate * 100)}%` : '';
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

function insightToRailCard(insight: Insight, t: TFunction, fighterName: string): InsightRailCard {
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = t(insight.copy.key, copyValuesWithEntity(insight, fighterName));
  const evidence = buildEvidenceLine(insight, t);
  const span = buildSpan(insight, t);
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

export interface FighterInsightRailProps {
  fighterId: number;
  fighterMatches: Match[];
  horizon: HorizonKey;
}

/**
 * The freed right side of the Fighter Analysis hero (T-39.1-14-02, D-12,
 * D-14): the closed rail primitive (plan 39.1-07) wired to the real
 * engine, scoped to ONE fighter — `CharacterMovers`, `LastEventRecap` and
 * `RivalMovers` (FormNow lives in the hero). Every figure reads through the
 * subject-scoped `fighterId`/`fighterMatches` the host already resolved
 * (coach-parity: this component itself never resolves a uid).
 */
export function FighterInsightRail({
  fighterId,
  fighterMatches,
  horizon,
}: FighterInsightRailProps) {
  const { t } = useTranslation();
  const fighterName = useFighterName(fighterId);
  const { dismissedIds, dismiss, restoreAll } = useInsightDismissals();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const scope = useMemo(() => buildFighterScope(fighterId), [fighterId]);

  const insights = useMemo(() => {
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
      .map((i) => insightToRailCard(i, t, fighterName));
    const promotionQueue = assembled.promotionQueue
      .filter((i) => i.state !== 'locked')
      .map((i) => insightToRailCard(i, t, fighterName));
    const lines = assembled.lines.map((insight) => (
      <InsightLine
        key={insight.id}
        text={t(insight.copy.key, copyValuesWithEntity(insight, fighterName))}
        tone="steady"
      />
    ));
    const unlocksNext = assembled.unlocksNext
      ? buildUnlocksNextCard(assembled.unlocksNext, insightById, t, fighterName)
      : null;
    return { cards, unlocksNext, lines, promotionQueue };
  }, [assembled, insightById, t, fighterName]);

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
