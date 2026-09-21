import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
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
import { InsightCard } from '@/components/analytics/InsightCard';
import { InsightLine } from '@/components/analytics/InsightLine';
import { UnlocksNext, type UnlocksNextMeter } from '@/components/analytics/UnlocksNext';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';

/**
 * The four Match Data roster reads (UI-SPEC §8.4's rail: "RosterCore ·
 * RosterShift · SecondaryPayoff · PocketCost — four candidates, top 3 by
 * salience render"). Resolved once at module scope: the registry is a
 * static, closed array.
 */
const ROSTER_CORE_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'rosterCore')!;
const ROSTER_SHIFT_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'rosterShift')!;
const SECONDARY_PAYOFF_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'secondaryPayoff')!;
const POCKET_COST_TEMPLATE = INSIGHT_TEMPLATES.find((t) => t.id === 'pocketCost')!;
const RAIL_TEMPLATES = [
  ROSTER_CORE_TEMPLATE,
  ROSTER_SHIFT_TEMPLATE,
  SECONDARY_PAYOFF_TEMPLATE,
  POCKET_COST_TEMPLATE,
];

/** `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated per this codebase's small-helper-duplication convention. */
function claimChipKindFor(kind: Insight['kind']): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** Every one of the four rail templates supplies its own complete `copy.values` — the only gap is the engine's degenerate account-scope FALLBACK insight (`rail.ts`'s `FALLBACK_LOCKED_INSIGHT`, templateId `formNow`), whose `insights.formNow.locked` key needs a host-composed `{{entity}}`. */
function copyValuesWithEntity(
  insight: Insight,
  accountName: string,
): Record<string, string | number> {
  return { entity: accountName, ...insight.copy.values };
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
  if (insight.window.fromMs == null || insight.window.toMs == null) {
    return undefined;
  }
  return t('insights.evidence.span', {
    count: insight.window.games,
    from: new Date(insight.window.fromMs).toLocaleDateString(),
    to: new Date(insight.window.toMs).toLocaleDateString(),
  });
}

export interface MatchDataRailProps {
  matches: Match[];
  horizon: HorizonKey;
}

/**
 * The Match Data roster rail (INS-05, UI-SPEC §8.4's rail table): the closed
 * `InsightRail` primitive (plan 39.1-07) wired to the real engine at
 * whole-account scope — `RosterCore`/`RosterShift`/`SecondaryPayoff`/
 * `PocketCost`, four candidates, top 3 by salience render (`RAIL_CARD_CAP`).
 * `SecondaryPayoff`/`PocketCost` return no candidate at all (`build()`
 * returns `[]`, or the engine's own `hidden` state, dropped by
 * `assembleRail`) when their group doesn't exist in the roster model —
 * absent, never rendered locked (UI-SPEC §8.4). Per-card error boundaries
 * and dismissal promotion both come from `InsightRail` itself — the host
 * never wires either separately (`FighterInsightRail.tsx`/
 * `TrendsReadsRail.tsx`'s established pattern).
 */
export function MatchDataRail({ matches, horizon }: MatchDataRailProps) {
  const { t } = useTranslation();
  const { dismissedIds, dismiss, restoreAll } = useInsightDismissals();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  // A dedicated name distinct from `matchData.title` ("Match History", the
  // table card's own heading) — reusing that key would render the SAME text
  // twice on the page (once as the table's CardTitle, once per rail card's
  // `InsightCard` name slot), breaking every existing test that queries for
  // it uniquely.
  const accountName = t('matchData.roster.railName');

  const insights = useMemo(() => {
    const built: Insight[] = [];
    for (const template of RAIL_TEMPLATES) {
      try {
        const results = template.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs });
        for (const insight of results) {
          if (!dismissedIds.includes(insight.id)) {
            insight.salience = scoreInsight(insight, nowMs);
            built.push(insight);
          }
        }
      } catch {
        continue;
      }
    }
    return built;
  }, [matches, horizon, nowMs, dismissedIds]);

  const insightById = useMemo(() => new Map(insights.map((i) => [i.id, i])), [insights]);

  const assembled = useMemo(() => assembleRail({ insights, cap: RAIL_CARD_CAP }), [insights]);

  function insightToRailCard(insight: Insight): InsightRailCard {
    const chipKind = claimChipKindFor(insight.kind);
    const verdict = t(insight.copy.key, copyValuesWithEntity(insight, accountName));
    const evidence = buildEvidenceLine(insight, t);
    const span = buildSpan(insight, t);
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
    // candidates) must not ALSO render as its own regular card — the same
    // de-duplication `FighterInsightRail.tsx`/`TrendsReadsRail.tsx` established
    // (D-14: "one unlock card", singular).
    const dedupeLocked = (candidate: Insight) =>
      !(assembled.unlocksNext && candidate.state === 'locked');
    const cards = assembled.cards.filter(dedupeLocked).map((i) => insightToRailCard(i));
    const promotionQueue = assembled.promotionQueue
      .filter((i) => i.state !== 'locked')
      .map((i) => insightToRailCard(i));
    const lines = assembled.lines.map((insight) => (
      <InsightLine
        key={insight.id}
        text={t(insight.copy.key, copyValuesWithEntity(insight, accountName))}
        tone="steady"
      />
    ));
    const unlocksNext = assembled.unlocksNext ? buildUnlocksNextCard(assembled.unlocksNext) : null;
    return { cards, unlocksNext, lines, promotionQueue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembled, insightById, t, accountName]);

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
      verdict={t('insights.formNow.locked', { entity: accountName, count: ABSTENTION_FLOOR_GAMES })}
      evidence=""
    />
  );

  return (
    <div data-slot="match-data-rail">
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
    </div>
  );
}
