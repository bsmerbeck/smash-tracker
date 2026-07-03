import { useState } from 'react';
import type { Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMatchupMatrix, type MatchupMatrixCell } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { matchupCellBackground } from '../lib/matchupCellColor';
import { useMatchupsContext } from '../MatchupsContext';

const VISIBLE_COLUMN_CAP = 12;

/** Scroll target the detail section below the matrix; set on the wrapping div by MatchupsPage. */
export const MATCHUP_DETAIL_ANCHOR_ID = 'matchup-detail';

/**
 * Your-fighters x opponent-fighters heatmap: rows are your fighters
 * (usage-ordered), columns are the opponent fighters you've actually faced
 * (usage-ordered, capped at the top `VISIBLE_COLUMN_CAP` with a "show all"
 * toggle to avoid an unreadably wide grid by default). Cell color blends the
 * theme's destructive red (low Wilson score) through neutral grey (~0.5)
 * to emerald (high), with opacity scaled by sample size so a single game
 * reads as tentative and a 10+-game sample reads at full strength. Clicking
 * a cell sets the page's fighter+opponent selection and scrolls to the
 * pairing detail section.
 */
export function MatchupMatrix({ matches }: { matches: Match[] }) {
  const { fighterSprites, setFighter, setOpponent } = useMatchupsContext();
  const [showAllColumns, setShowAllColumns] = useState(false);

  const matrix = getMatchupMatrix(matches);
  const cellByKey = new Map<string, MatchupMatrixCell>(
    matrix.cells.map((cell) => [`${cell.fighterId}:${cell.opponentFighterId}`, cell]),
  );

  // Rows: only your own selected fighters that have actually been played,
  // usage-ordered (matrix.fighterIds is already usage-ordered).
  const yourFighterIds = new Set(fighterSprites.map((f) => f.id));
  const rowIds = matrix.fighterIds.filter((id) => yourFighterIds.has(id));

  const allColumnIds = matrix.opponentFighterIds;
  const columnIds = showAllColumns ? allColumnIds : allColumnIds.slice(0, VISIBLE_COLUMN_CAP);
  const hasMoreColumns = allColumnIds.length > VISIBLE_COLUMN_CAP;

  function selectPairing(fighterId: number, opponentFighterId: number) {
    const fighter = fighterSprites.find((f) => f.id === fighterId);
    const opponent = getFighterById(opponentFighterId);
    if (fighter) {
      setFighter(fighter);
    }
    if (opponent) {
      setOpponent(opponent);
    }
    document
      .getElementById(MATCHUP_DETAIL_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Matchup Matrix</CardTitle>
        {hasMoreColumns && (
          <Button variant="outline" size="sm" onClick={() => setShowAllColumns((v) => !v)}>
            {showAllColumns ? 'Show top 12' : `Show all ${allColumnIds.length}`}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rowIds.length === 0 || columnIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matches recorded yet — play some matches to build your matchup matrix.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-card p-2 text-left align-bottom">
                    <span className="sr-only">Your fighter</span>
                  </th>
                  {columnIds.map((opponentId) => {
                    const opponent = getFighterById(opponentId);
                    return (
                      <th key={opponentId} className="p-1 align-bottom">
                        <div className="flex flex-col items-center gap-1">
                          {opponent?.url && (
                            <img
                              src={opponent.url}
                              alt=""
                              className="size-8 object-contain"
                              loading="lazy"
                            />
                          )}
                          <span className="w-16 truncate text-center text-xs text-muted-foreground">
                            {opponent?.name ?? 'Unknown'}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rowIds.map((fighterId) => {
                  const fighter = fighterSprites.find((f) => f.id === fighterId);
                  return (
                    <tr key={fighterId}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 whitespace-nowrap bg-card p-2 text-left font-normal"
                      >
                        <div className="flex items-center gap-2">
                          {fighter?.url && (
                            <img
                              src={fighter.url}
                              alt=""
                              className="size-8 object-contain"
                              loading="lazy"
                            />
                          )}
                          <span>{fighter?.name ?? 'Unknown'}</span>
                        </div>
                      </th>
                      {columnIds.map((opponentId) => {
                        const cell = cellByKey.get(`${fighterId}:${opponentId}`);
                        const opponentName = getFighterById(opponentId)?.name ?? 'Unknown';
                        const fighterName = fighter?.name ?? 'Unknown';
                        return (
                          <td key={opponentId} className="p-1 text-center">
                            {cell ? (
                              <button
                                type="button"
                                onClick={() => selectPairing(fighterId, opponentId)}
                                aria-label={`${fighterName} vs ${opponentName}: ${cell.wins}-${cell.losses}`}
                                title={`${cell.wins}-${cell.losses} (${cell.winRate}% over ${cell.total})`}
                                className="flex size-14 items-center justify-center rounded font-medium text-white transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                style={{
                                  backgroundColor: matchupCellBackground(cell.wilson, cell.total),
                                }}
                              >
                                {cell.wins}-{cell.losses}
                              </button>
                            ) : (
                              <div className="size-14" aria-hidden="true" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
