import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, InsightScope, Match } from '@smash-tracker/shared';
import { INSIGHT_TEMPLATES, confidenceTierFor } from '@smash-tracker/shared';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { Record } from '@/components/analytics/Record';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { buildInsightDoors, type InsightDoorDescriptor } from '@/components/analytics/insightDoors';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { localizedFighterName } from '@/lib/fighterNames';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { claimChipKindFor } from './MatchupChart';
import { ReferenceSwatch } from './StageSeries';

const MATCHUP_OR_PLAYER_TEMPLATE = INSIGHT_TEMPLATES.find(
  (template) => template.id === 'matchupOrPlayer',
)!;

export interface UseMatchupOrPlayerInsightInput {
  matchupMatches: Match[];
  horizon: HorizonKey;
}

/**
 * Plan 39.1-24 (gap closure, Task 2): exported so a host page (`MatchupsPage`)
 * calls this ONCE and hands the result DOWN to both `MatchupOrPlayerCard`
 * (which renders the card/doors) and its own `FilteredMatchList` terminus
 * (whose `resolveClaim` needs the SAME `Insight` a rendered door's
 * `claim=<id>` was built from) — mirrors `FighterInsightRail.tsx`'s
 * `useFighterInsights`. `MatchupOrPlayerCard` itself no longer computes its
 * own insight; it takes the result as a prop.
 */
export function useMatchupOrPlayerInsight({
  matchupMatches,
  horizon,
}: UseMatchupOrPlayerInsightInput): Insight | null {
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const fighterId = matchupMatches[0]?.fighter_id;
  const opponentId = matchupMatches[0]?.opponent_id;

  return useMemo(() => {
    if (fighterId == null || opponentId == null) return null;
    const scope: InsightScope = {
      kind: 'character',
      key: `character:${fighterId}:${opponentId}`,
      axes: { fighter: fighterId, vs: opponentId },
      filter: (matches: Match[]) => matches,
    };
    const built = MATCHUP_OR_PLAYER_TEMPLATE.build({
      matches: matchupMatches,
      scope,
      horizon,
      nowMs,
    });
    return built[0] ?? null;
  }, [fighterId, opponentId, matchupMatches, horizon, nowMs]);
}

/**
 * Plan 39.1-24 (gap closure, Task 2): exported so a host page can build the
 * SAME rendered verdict sentence this card uses, for `FilteredMatchList`'s
 * `claimSummary` prop.
 */
export function buildMatchupOrPlayerVerdict(
  insight: Insight,
  t: TFunction,
  opponentId: number,
): string {
  const matchup = `${t('matchups.vs')} ${localizedFighterName(opponentId, t)}`;
  return t(insight.copy.key, { ...insight.copy.values, matchup });
}

/** Duplicated per this codebase's small-helper-duplication convention (mirrors `FighterInsightRail.tsx`'s own precedent). */
function insightDoorLabel(door: InsightDoorDescriptor, t: TFunction): string {
  if (door.kind === 'games') return t('insights.door.seeGames', { count: door.count });
  if (door.kind === 'matchup') return t('insights.door.openMatchup');
  if (door.kind === 'opponent') return t('insights.door.openOpponent');
  return t('insights.door.openMatchup');
}

/**
 * Plan 39.1-24 (gap closure, Task 2): `MatchupsPage`'s own terminus anchor is
 * `#matchup-table` (`MATCHUP_TABLE_ANCHOR_ID`), never `#games` — Phase 38's
 * drill-down tests reference that id, so it is never renamed. The games
 * door's scroll target is overridden accordingly via `buildInsightDoors`'s
 * `anchor` option; the resolved games/claim id and count are unaffected.
 *
 * Plan 39.1-26 (gap closure): `doorCarry` is threaded straight through to
 * `buildInsightDoors` — the pairing this card's host page computed the
 * insight over, so a URL-seeded pairing survives the door round trip
 * exactly like the sibling chart door (see `MatchupChart.tsx`'s
 * `renderFormNowHead`).
 */
function buildDoorNodes(
  insight: Insight,
  t: TFunction,
  subjectPath: (personalPath: string) => string,
  doorCarry?: URLSearchParams,
): InsightCardDoors | undefined {
  const descriptors = buildInsightDoors({
    insight,
    subjectPath,
    anchor: `#${MATCHUP_TABLE_ANCHOR_ID}`,
    carry: doorCarry,
  }).slice(0, 3);
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

/** The engine's player-branch copy key (`matchupOrPlayer.ts`): the only state that carries the mark. */
const PLAYER_COPY_KEY = 'insights.matchupOrPlayer.player';

function markRow({
  key,
  label,
  wins,
  losses,
}: {
  key: string;
  label: string;
  wins: number;
  losses: number;
}): ComparisonBarsRow {
  const total = wins + losses;
  const rate = total > 0 ? Math.round((wins / total) * 100) : 0;
  return {
    key,
    label,
    labelTitle: label,
    value: rate,
    valueLabel: `${wins}–${losses} · ${rate}% · ${total}`,
    valueNode: (
      <Record
        wins={wins}
        losses={losses}
        cue="none"
        emphasis
        className="[&>span:first-child]:text-foreground"
      />
    ),
  };
}

/**
 * Plan 39.1-46 (sketch 003 A `mopCard`, PD-46-2, T-39.1-46-01): the player
 * branch's mark — "vs <top player>" against "everyone else" as reference rows.
 * Both records come ONLY from the insight's own copy values (no host
 * re-count of the matches): the player's record is (opponentGames −
 * lossShare)–lossShare; everyone else's is the pairing's remainder. The
 * reference is the pairing's all-time rate from the same values. No mark in
 * any other state, and none when the values do not add up (never an invented
 * figure). The "everyone else" row carries no player count — the insight
 * does not expose one (PD-46-2).
 */
function buildPlayerMark(insight: Insight, t: TFunction): ReactNode | undefined {
  if (insight.copy.key !== PLAYER_COPY_KEY) return undefined;
  const { opponent, lossShare, totalLosses, opponentGames, totalGames } = insight.copy.values;
  if (
    typeof opponent !== 'string' ||
    typeof lossShare !== 'number' ||
    typeof totalLosses !== 'number' ||
    typeof opponentGames !== 'number' ||
    typeof totalGames !== 'number'
  ) {
    return undefined;
  }
  const playerWins = opponentGames - lossShare;
  const restLosses = totalLosses - lossShare;
  const restGames = totalGames - opponentGames;
  const restWins = restGames - restLosses;
  if (playerWins < 0 || restWins < 0 || restLosses < 0 || totalGames <= 0) return undefined;
  const referenceRate = ((totalGames - totalLosses) / totalGames) * 100;
  return (
    <div className="flex flex-col gap-2">
      <ComparisonBars
        tone="series"
        referenceRate={referenceRate}
        rows={[
          markRow({
            key: 'player',
            label: t('matchups.mop.vsPlayer', { opponent }),
            wins: playerWins,
            losses: lossShare,
          }),
          markRow({
            key: 'rest',
            label: t('matchups.mop.everyoneElse'),
            wins: restWins,
            losses: restLosses,
          }),
        ]}
      />
      <p
        data-slot="mop-legend"
        className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground"
      >
        <ReferenceSwatch />
        <span>
          {t('analytics.trend.legend.reference', { rate: `${Math.round(referenceRate)}%` })}
        </span>
      </p>
    </div>
  );
}

export interface MatchupOrPlayerCardProps {
  matchupMatches: Match[];
  /** The one shared computation — see `useMatchupOrPlayerInsight` above. */
  insight: Insight | null;
  /** Plan 39.1-26 (gap closure): the host's pairing context, forwarded to the games door — see `buildDoorNodes`' doc comment. */
  doorCarry?: URLSearchParams;
}

/**
 * UI-SPEC §8.3/§9.4 (`MatchupOrPlayer`): a four-column `InsightCard` telling
 * the reader whether a bad matchup is player-driven (one opponent accounts
 * for a disproportionate share of the pairing's losses) or matchup-driven
 * (losses spread across the field). Renders NOTHING at all when the engine
 * reports the read `hidden` — not an empty card, not a locked card, because
 * `matchupOrPlayer.ts`'s own contract distinguishes those states (it never
 * emits a `locked` read for this template — see its SUMMARY's key-decisions).
 */
export function MatchupOrPlayerCard({
  matchupMatches,
  insight,
  doorCarry,
}: MatchupOrPlayerCardProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();

  const opponentId = matchupMatches[0]?.opponent_id;

  if (!insight || insight.state === 'hidden' || opponentId == null) {
    return null;
  }

  const matchup = `${t('matchups.vs')} ${localizedFighterName(opponentId, t)}`;
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = buildMatchupOrPlayerVerdict(insight, t, opponentId);
  const doors = buildDoorNodes(insight, t, subjectPath, doorCarry);

  const claim = insight.recent;
  const record = claim.kind === 'evidenced' ? claim.value : null;
  const tier = record ? confidenceTierFor(record.total) : null;
  const cue = tier
    ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: record?.total ?? 0 })
    : '';
  const evidence = record
    ? t('insights.evidence.single', { record: `${record.wins}–${record.losses}`, cue })
    : '';

  return (
    <InsightCard
      chip={<ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />}
      name={matchup}
      verdict={verdict}
      evidence={evidence}
      mark={buildPlayerMark(insight, t)}
      doors={doors}
    />
  );
}
