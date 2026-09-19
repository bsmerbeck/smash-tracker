import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { ABSTENTION_FLOOR_GAMES, type ScoutGame } from '@smash-tracker/shared';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { filterByFighter, getRollingWinRate, rankMatchupsByEvidence } from '@/lib/stats';
import { StageMastery } from '@/pages/FighterAnalysis/components/StageMastery';
import { OpponentTable } from '@/pages/FighterAnalysis/components/OpponentTable';
import { WhatTheyPlayTable } from '@/pages/Opponents/components/WhatTheyPlayTable';
import { ChartCard } from '@/components/charts/ChartCard';
import { TrendLine } from '@/components/charts/TrendLine';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { scoutGamesToMatches, buildScoutTrendChartPoints } from '../lib/fullAnalysis';

/**
 * V9-D: "Fighter Analysis, but for the player you're scouting" — reuses the
 * exact stats engine (`@/lib/stats`) and Fighter Analysis / Opponents
 * components the tracked user's own analytics pages already render, just
 * pointed at the scouted player's own per-game history
 * (`ScoutReportData.games`) instead of the caller's own matches.
 *
 * Renders nothing meaningful (an empty-state message instead) when `games`
 * is absent — either an older stored report generated before V9-D, or a
 * live scout from a source/set that never carried per-game detail (e.g.
 * parry.gg sets synthesized from scores alone). Collapsed by default so it
 * doesn't push the AI-report / character-usage cards further down the page
 * for players who don't care to expand it.
 */
export function FullAnalysisSection({
  games,
  gamerTag,
}: {
  games: ScoutGame[] | undefined;
  gamerTag: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
        >
          <span>{t('scout.fullAnalysis.title')}</span>
          <ChevronDown
            className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 border-t p-4">
        {games && games.length > 0 ? (
          <FullAnalysisContent games={games} gamerTag={gamerTag} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {games === undefined
              ? t('scout.fullAnalysis.rescout')
              : t('scout.fullAnalysis.noGameData')}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Trailing-5 rolling window — matches the deleted chart.js scouting-trend component's own `ROLLING_WINDOW` constant, so the numbers this card shows are unchanged by the kit swap. */
const ROLLING_WINDOW = 5;

function FullAnalysisContent({ games, gamerTag }: { games: ScoutGame[]; gamerTag: string }) {
  const { t } = useTranslation();
  const matches = scoutGamesToMatches(games);
  const trendSeries = getRollingWinRate(matches, ROLLING_WINDOW);
  const trendPoints = buildScoutTrendChartPoints(trendSeries, t);

  // "Their top character" — the character with the most sampled games,
  // i.e. whichever fighter_id appears most often once adapted to Match[]
  // (mirrors how `report.characters` is already sorted server-side, but
  // derived independently here since this component only receives `games`).
  const gamesByCharacter = new Map<number, number>();
  for (const match of matches) {
    gamesByCharacter.set(match.fighter_id, (gamesByCharacter.get(match.fighter_id) ?? 0) + 1);
  }
  const topCharacterId = [...gamesByCharacter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const topCharacterMatches =
    topCharacterId != null ? filterByFighter(matches, topCharacterId) : [];
  const topCharacterSprite = topCharacterId != null ? getFighterById(topCharacterId) : null;
  // Only worth a second, character-scoped card when it's a strict subset of
  // the overall sample — a one-character scouted player would otherwise see
  // the exact same tile grid twice.
  const showTopCharacterCard =
    topCharacterId != null &&
    topCharacterMatches.length > 0 &&
    topCharacterMatches.length < matches.length;

  const matchupSpread = rankMatchupsByEvidence(matches, ABSTENTION_FLOOR_GAMES);

  return (
    <>
      <StageMastery fighterMatches={matches} title={t('scout.fullAnalysis.stageMasteryOverall')} />

      {showTopCharacterCard && (
        <StageMastery
          fighterMatches={topCharacterMatches}
          title={t('scout.fullAnalysis.stageMasteryFor', {
            name:
              topCharacterSprite && topCharacterId != null
                ? localizedFighterName(topCharacterId, t)
                : t('scout.fullAnalysis.topCharacter'),
          })}
        />
      )}

      <WhatTheyPlayTable byTheirFighter={matchupSpread} />

      <ChartCard title={t('scout.fullAnalysis.recentForm', { name: gamerTag })}>
        {trendPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.trend.empty')}</p>
        ) : (
          <TrendLine points={trendPoints} />
        )}
      </ChartCard>

      <OpponentTable fighterMatches={matches} />
    </>
  );
}
