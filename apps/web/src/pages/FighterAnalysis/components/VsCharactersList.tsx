import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InsightState, Match, RateValue } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  classify,
  isUnknownCharacter,
  resolveWindow,
  toRateValue,
  wilsonInterval,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { windowHeldGamesBeforeBound } from '@/components/analytics/scopedRecencyVerdict';
import { Record } from '@/components/analytics/Record';
import { ComparisonBars, type ComparisonBarsDumbbellRow } from '@/components/charts/ComparisonBars';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

interface CharacterCandidate {
  opponentFighterId: number;
  baselineRate: RateValue;
  recentRate: RateValue;
  state: InsightState;
  deltaPoints: number | null;
  /**
   * UAT review WR-03 (F17, plan 39.1-59): the row's last-30 window held games
   * before D-15's 12-month bound — an emptied window then reads "none in the
   * last 12 months", never "no games" beside an all-time record.
   */
  recencyBounded: boolean;
}

/**
 * Plan 39.1-54 (UAT 39.1-26 F2): the games a row PRINTS — its recent-window
 * total at or above the abstention floor, its all-time total below it (a
 * sub-floor row prints its all-time record). "Most games first" sorts by this,
 * so the order is true of the figures on screen.
 */
function printedGames(candidate: { baselineRate: RateValue; recentRate: RateValue }): number {
  return candidate.recentRate.total >= ABSTENTION_FLOOR_GAMES
    ? candidate.recentRate.total
    : candidate.baselineRate.total;
}

/** Groups by opponent CHARACTER (excluding `isUnknownCharacter`, mirroring `characterMovers.ts`'s own exclusion), sorted by the games each row prints (`printedGames`), then all-time games, then id. */
function buildCandidates(fighterMatches: Match[], nowMs: number): CharacterCandidate[] {
  const groups = new Map<number, Match[]>();
  for (const match of fighterMatches) {
    if (isUnknownCharacter(match)) continue;
    const existing = groups.get(match.opponent_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.opponent_id, [match]);
    }
  }
  const candidates: CharacterCandidate[] = [];
  for (const [opponentFighterId, matches] of groups) {
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
    const recencyBounded = windowHeldGamesBeforeBound({ matches, horizon: 'last30', nowMs });
    candidates.push({
      opponentFighterId,
      baselineRate,
      recentRate,
      state,
      deltaPoints,
      recencyBounded,
    });
  }
  return candidates.sort(
    (a, b) =>
      printedGames(b) - printedGames(a) ||
      b.baselineRate.total - a.baselineRate.total ||
      a.opponentFighterId - b.opponentFighterId,
  );
}

export interface VsCharactersListProps {
  fighterId: number;
  fighterMatches: Match[];
}

/**
 * The "vs characters" dumbbell list beneath the hero (UI-SPEC §8.1, sketch
 * 001-C): an all-time tick, a recent (last 30) dot and its 95% range per
 * opponent character, capped at 5 with the standard show-all/terminus
 * ladder. Rows honour the abstention floor honesty rule — a row whose
 * recent sample is below the floor shows its ALL-TIME record and omits the
 * recent dot/range (the primitive itself already omits the dot/range; this
 * component chooses which RECORD to print for that same case).
 */
export function VsCharactersList({ fighterId, fighterMatches }: VsCharactersListProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const fighterName = useFighterNameResolver();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  const candidates = useMemo(() => buildCandidates(fighterMatches, nowMs), [fighterMatches, nowMs]);

  const empty = (
    <p className="text-sm text-muted-foreground">{t('fighterAnalysis.hero.vsCharacters.empty')}</p>
  );

  if (candidates.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('fighterAnalysis.hero.vsCharacters.title')}</CardTitle>
        </CardHeader>
        <CardContent>{empty}</CardContent>
      </Card>
    );
  }

  const rows = candidates.map((candidate) => {
    const name = fighterName(candidate.opponentFighterId);
    const subFloor = candidate.recentRate.total < ABSTENTION_FLOOR_GAMES;
    const collapsed = candidate.state === 'collapsed';
    // Plan 39.1-36 (INS-04): the one ladder-to-chip mapping. A sub-floor
    // row states its window size ("n 2 · no direction") and an empty one
    // "no games" instead of omitting the chip; the list meta ("last 30 in
    // each") names the horizon, so the chip never repeats it.
    const chipView = deltaChipView({
      state: candidate.state,
      deltaPoints: candidate.deltaPoints,
      recentGames: candidate.recentRate.total,
      horizon: 'last30',
      horizonOwnedByParent: true,
      recencyBounded: candidate.recencyBounded,
      t,
    });
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
    const search = buildDrillDownSearch({
      fighterId,
      vsFighterId: candidate.opponentFighterId,
    }).toString();
    const href = subjectPath(`/matchups${search ? `?${search}` : ''}`);
    const recentRecord = `${candidate.recentRate.wins}–${candidate.recentRate.losses}`;
    const baselineRecord = `${candidate.baselineRate.wins}–${candidate.baselineRate.losses}`;
    const row: ComparisonBarsDumbbellRow = {
      key: String(candidate.opponentFighterId),
      label: name,
      recentRecordNode: recordNode,
      deltaNode:
        collapsed || chipView === null ? null : (
          <DeltaChip
            {...chipView}
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
        <CardTitle>{t('fighterAnalysis.hero.vsCharacters.title')}</CardTitle>
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
            terminus: t('analytics.list.allMatchups', { count: candidates.length }),
          }}
          empty={empty}
          terminusHref={subjectPath(
            `/matchups${buildDrillDownSearch({ fighterId }).toString() ? `?${buildDrillDownSearch({ fighterId }).toString()}` : ''}`,
          )}
        />
      </CardContent>
    </Card>
  );
}
