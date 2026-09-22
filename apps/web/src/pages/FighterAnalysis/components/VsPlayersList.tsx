import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { InsightState, Match, RateValue } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  classify,
  resolveOpponentIdentities,
  resolveWindow,
  toRateValue,
  wilsonInterval,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { Record } from '@/components/analytics/Record';
import { ComparisonBars, type ComparisonBarsDumbbellRow } from '@/components/charts/ComparisonBars';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

/** Duplicated per this codebase's small-helper-duplication convention (see `VsCharactersList.tsx`, `MatchWinLossCard.tsx`). */
function deltaChipStateFor(state: InsightState, deltaPoints: number | null): DeltaChipState {
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

interface PlayerCandidate {
  identity: string;
  displayTag: string;
  baselineRate: RateValue;
  recentRate: RateValue;
  state: InsightState;
  deltaPoints: number | null;
}

/** A simple, deterministic display tag: the first non-empty stored `opponent` tag among the group's matches, falling back to the identity itself (mirrors `rivalMovers.ts`'s own `pickDisplayTag` — not exported, duplicated by convention). */
function pickDisplayTag(identity: string, matches: Match[]): string {
  for (const match of matches) {
    if (match.opponent) {
      return match.opponent;
    }
  }
  return identity;
}

/** Groups by RESOLVED opponent identity (mirrors `rivalMovers.ts`'s own exclusion of machine keys and the unnamed bucket), sorted most-games-first. */
function buildCandidates(
  fighterMatches: Match[],
  aliasMap: Record<string, string>,
  nowMs: number,
): PlayerCandidate[] {
  const resolve = resolveOpponentIdentities(fighterMatches, aliasMap);
  const groups = new Map<string, Match[]>();
  for (const match of fighterMatches) {
    const identity = resolve(match);
    if (identity === 'unknown' || identity.startsWith('sgg:') || identity.startsWith('pgg:')) {
      continue;
    }
    const existing = groups.get(identity);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(identity, [match]);
    }
  }
  const candidates: PlayerCandidate[] = [];
  for (const [identity, matches] of groups) {
    const baselineRate = toRateValue(matches);
    const { matches: recentMatches } = resolveWindow({
      matches,
      horizon: 'last30',
      scoped: true,
      nowMs,
    });
    const recentRate = toRateValue(recentMatches);
    const { state, deltaPoints } = classify({
      recent: recentRate,
      baseline: baselineRate,
      scoped: true,
      hasAction: false,
    });
    candidates.push({
      identity,
      displayTag: pickDisplayTag(identity, matches),
      baselineRate,
      recentRate,
      state,
      deltaPoints,
    });
  }
  return candidates.sort((a, b) => b.baselineRate.total - a.baselineRate.total);
}

export interface VsPlayersListProps {
  fighterId: number;
  fighterMatches: Match[];
  aliasMap: Record<string, string>;
}

/**
 * The "vs players" dumbbell list beneath the hero — the opponent-PLAYER
 * sibling of `VsCharactersList.tsx`. Same cap/expand/terminus ladder and the
 * same abstention-floor honesty rule; rows drill to the opponent hub rather
 * than the Matchups pairing.
 */
export function VsPlayersList({ fighterId, fighterMatches, aliasMap }: VsPlayersListProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  const candidates = useMemo(
    () => buildCandidates(fighterMatches, aliasMap, nowMs),
    [fighterMatches, aliasMap, nowMs],
  );

  const empty = (
    <p className="text-sm text-muted-foreground">{t('fighterAnalysis.hero.vsPlayers.empty')}</p>
  );

  if (candidates.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('fighterAnalysis.hero.vsPlayers.title')}</CardTitle>
        </CardHeader>
        <CardContent>{empty}</CardContent>
      </Card>
    );
  }

  const rows = candidates.map((candidate) => {
    const name = candidate.displayTag;
    const subFloor = candidate.recentRate.total < ABSTENTION_FLOOR_GAMES;
    const collapsed = candidate.state === 'collapsed';
    // WR-C01: `locked` (below the abstention floor) is a different honesty
    // tier than `thin`/`thinRecent` and has no `DeltaChip` representation —
    // omit the chip entirely rather than let it fall through to
    // `deltaChipStateFor`'s `'none'` default, which reads "Thin".
    const chipState =
      candidate.state === 'locked'
        ? null
        : deltaChipStateFor(candidate.state, candidate.deltaPoints);
    const recordNode = subFloor ? (
      <Record
        wins={candidate.baselineRate.wins}
        losses={candidate.baselineRate.losses}
        cue="none"
      />
    ) : (
      <Record wins={candidate.recentRate.wins} losses={candidate.recentRate.losses} cue="none" />
    );
    const interval = wilsonInterval(candidate.recentRate.wins, candidate.recentRate.total);
    const search = buildDrillDownSearch({ fighterId }).toString();
    const href = subjectPath(
      `/opponents/${encodeURIComponent(candidate.identity)}${search ? `?${search}` : ''}`,
    );
    const recentRecord = `${candidate.recentRate.wins}–${candidate.recentRate.losses}`;
    const baselineRecord = `${candidate.baselineRate.wins}–${candidate.baselineRate.losses}`;
    const row: ComparisonBarsDumbbellRow = {
      key: candidate.identity,
      label: name,
      recentRecordNode: recordNode,
      deltaNode:
        collapsed || chipState === null ? null : (
          <DeltaChip
            state={chipState}
            valueLabel={deltaValueLabel(chipState, candidate.deltaPoints, t)}
            horizonOwnedByParent
            ariaLabel={t('analytics.dumbbell.rowAria', {
              label: name,
              recentRecord,
              baselineRecord,
            })}
          />
        ),
      baselineRate: candidate.baselineRate.rate * 100,
      recentRate: candidate.recentRate.rate * 100,
      recentRange: [interval.lower * 100, interval.upper * 100],
      recentTotal: candidate.recentRate.total,
      href,
      ariaLabel: t('shared.drillableRow.aria', { subject: name, context: recentRecord }),
      collapsed,
    };
    return <ComparisonBars key={row.key} mode="dumbbell" rows={[row]} />;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('fighterAnalysis.hero.vsPlayers.title')}</CardTitle>
        <CardDescription>{t('fighterAnalysis.hero.listMeta')}</CardDescription>
      </CardHeader>
      <CardContent>
        <BoundedList
          cap={LIST_CAP_RAIL}
          rows={rows}
          labels={{
            showAll: t('analytics.list.showAll', { count: candidates.length }),
            showFewer: t('analytics.list.showFewer'),
            showMore: t('analytics.list.showMore50'),
            terminus: t('analytics.list.allOpponents', { count: candidates.length }),
          }}
          empty={empty}
          terminusHref={subjectPath('/opponents')}
        />
      </CardContent>
    </Card>
  );
}
