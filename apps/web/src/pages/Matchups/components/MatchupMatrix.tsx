import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getMatchupMatrix, type MatchupMatrixCell } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { matchupCellBackground } from '../lib/matchupCellColor';
import { useMatchupsContext } from '../MatchupsContext';

const VISIBLE_COLUMN_CAP = 12;

/** Tailwind's `sm` breakpoint (640px): below it the matrix reads as stacked rows (UI-SPEC section 6.6), the same query `FilteredMatchList` and `MatrixHeat` use. */
const NARROW_LAYOUT_QUERY = '(max-width: 639px)';

export type MatchupMatrixLayout = 'table' | 'stack';

/** Read-once `matchMedia` check (guard-before-use); jsdom has none, so tests get the table unless they stub it. */
function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_LAYOUT_QUERY).matches
      : false,
  );
  return isNarrow;
}

/** Scroll target the detail section below the matrix; set on the wrapping div by MatchupsPage. */
export const MATCHUP_DETAIL_ANCHOR_ID = 'matchup-detail';

/**
 * Your-fighters x opponent-fighters matrix (sketch 003 A `matrixCard`, plan
 * 39.1-47): rows are your fighters (usage-ordered), columns are the opponent
 * fighters you've actually faced (usage-ordered, capped at the top
 * `VISIBLE_COLUMN_CAP` with a "show all" link to avoid an unreadably wide grid
 * by default). Each cell is a two-line button — the record, then "rate · n" —
 * filled with the identity blue scaled by win rate (`matchupCellBackground`);
 * a cell under the 3-game floor has no heat and a 1px outline instead. The
 * effective pairing's cell (the one the page above is scoped to) carries
 * `aria-current="true"` and a foreground ring, so the reader can see where
 * they are in the grid. Fighter sprites stay in the headers (PD-47-5).
 *
 * Phase 38-04 (D-06/DRL-02): clicking a cell NAVIGATES to the param-aware
 * Matchups page with the character axes set (`?fighter=&vs=`), through the
 * subject-aware path builder, rather than calling the context's in-page
 * pairing setters directly — the destination is now shareable and
 * reachable with the back button. `MatchupsPage`'s own effective-pairing
 * composition (`URL axis ?? persisted selection`) is what makes this
 * actually change the rendered detail block, not just the URL.
 */
export function MatchupMatrix({
  matches,
  layout,
}: {
  matches: Match[];
  /** Test / host affordance forcing the form, bypassing the `matchMedia` check. */
  layout?: MatchupMatrixLayout;
}) {
  const { t } = useTranslation();
  const {
    fighterSprites,
    fighter: currentFighter,
    opponent: currentOpponent,
  } = useMatchupsContext();
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  const [showAllColumns, setShowAllColumns] = useState(false);
  const isNarrowViewport = useIsNarrowViewport();
  const resolvedLayout: MatchupMatrixLayout = layout ?? (isNarrowViewport ? 'stack' : 'table');

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
    const search = buildDrillDownSearch({ fighterId, vsFighterId: opponentFighterId });
    navigate(subjectPath(`/matchups?${search.toString()}`));
    document
      .getElementById(MATCHUP_DETAIL_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * One matrix cell button: the record, then "rate - n", on the series-1 heat
   * (`matchupCellBackground`), outlined under the 3-game floor, ringed when it
   * is the page's own pairing. The stacked (phone) form carries its opponent's
   * sprite and name on the cell, because it has no column header to read it from.
   */
  function renderCell(
    fighterId: number,
    opponentId: number,
    cell: MatchupMatrixCell,
    form: MatchupMatrixLayout,
  ) {
    const opponent = getFighterById(opponentId);
    const opponentName = opponent ? localizedFighterName(opponentId, t) : t('common.unknown');
    const fighterName = getFighterById(fighterId)
      ? localizedFighterName(fighterId, t)
      : t('common.unknown');
    const isCurrent = currentFighter?.id === fighterId && currentOpponent?.id === opponentId;
    const isSubFloor = cell.total < ABSTENTION_FLOOR_GAMES;
    return (
      <button
        type="button"
        onClick={() => selectPairing(fighterId, opponentId)}
        aria-label={t('matchups.matrix.cellAria', {
          fighter: fighterName,
          opponent: opponentName,
          wins: cell.wins,
          losses: cell.losses,
        })}
        aria-current={isCurrent ? 'true' : undefined}
        title={`${cell.wins}-${cell.losses} ${t('common.rateOverSample', { rate: cell.winRate, total: cell.total })}`}
        className={cn(
          'relative flex w-full flex-col items-start gap-px rounded-md px-2.5 py-1.5 text-left text-foreground transition-[filter] duration-150 hover:brightness-110 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          form === 'table' ? 'min-w-16' : 'min-w-0',
          isSubFloor && 'ring-1 ring-border ring-inset',
          isCurrent && 'ring-[1.5px] ring-foreground ring-inset',
        )}
        style={{
          backgroundColor: matchupCellBackground(
            cell.total > 0 ? cell.wins / cell.total : 0,
            cell.total,
          ),
        }}
      >
        {form === 'stack' && (
          <span className="flex w-full min-w-0 items-center gap-1">
            {opponent?.url && (
              <img
                src={opponent.url}
                alt=""
                className="size-4 shrink-0 object-contain"
                loading="lazy"
              />
            )}
            <span className="truncate text-xs leading-4 text-muted-foreground">{opponentName}</span>
          </span>
        )}
        <span className="text-[13px] leading-[18px] font-semibold whitespace-nowrap tabular-nums">
          {cell.wins}-{cell.losses}
        </span>
        <span className="text-xs leading-[14px] whitespace-nowrap text-muted-foreground tabular-nums">
          {t('matchups.matrix.cellSub', {
            rate: `${cell.winRate}%`,
            count: cell.total,
          })}
        </span>
      </button>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <CardTitle>{t('matchups.matrix.cardTitle')}</CardTitle>
        <p className="min-w-0 text-xs leading-4 text-muted-foreground">
          {t('matchups.matrix.meta')}
        </p>
        {hasMoreColumns && (
          <Button
            variant="link"
            size="sm"
            className={cn(MUTED_LINK_TONE, 'h-auto px-1 py-0 text-xs underline')}
            onClick={() => setShowAllColumns((v) => !v)}
          >
            {showAllColumns
              ? t('matchups.matrix.showTop', { count: VISIBLE_COLUMN_CAP })
              : t('matchups.matrix.showAll', { count: allColumnIds.length })}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rowIds.length === 0 || columnIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('matchups.matrix.empty')}</p>
        ) : resolvedLayout === 'stack' ? (
          /* Plan 39.1-48 (matrix-stacked-phone, UI-SPEC section 6.6 "tables become
             stacked rows"): below 640px a 5-column grid scrolled inside a 308px
             card, which the enforced table-clip sweep reports. One labelled group
             per fighter of yours; its played pairings wrap on a 3-up grid, each
             cell naming its opponent. The page never scrolls sideways. */
          <div data-slot="matchup-matrix-stack" className="flex flex-col gap-3">
            {rowIds.map((fighterId) => {
              const fighter = fighterSprites.find((f) => f.id === fighterId);
              const fighterName = fighter
                ? localizedFighterName(fighterId, t)
                : t('common.unknown');
              return (
                <div key={fighterId} role="group" aria-label={fighterName} className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    {fighter?.url && (
                      <img
                        src={fighter.url}
                        alt=""
                        className="size-6 object-contain"
                        loading="lazy"
                      />
                    )}
                    <span className="truncate text-sm font-medium">{fighterName}</span>
                  </div>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1">
                    {columnIds.map((opponentId) => {
                      const cell = cellByKey.get(`${fighterId}:${opponentId}`);
                      return cell ? (
                        <li key={opponentId} className="min-w-0">
                          {renderCell(fighterId, opponentId, cell, 'stack')}
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* Plan 39.1-31 (item 4): no `mx-auto` — the table starts at the
                card's own content edge like every other card body, instead
                of auto-centering inside the full-width card. */}
            <table className="w-full min-w-[480px] border-separate border-spacing-1 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-28 min-w-28 max-w-28 border-r border-border bg-card p-2 text-left align-bottom">
                    <span className="sr-only">{t('matchups.matrix.yourFighterSr')}</span>
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
                            {opponent ? localizedFighterName(opponentId, t) : t('common.unknown')}
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
                        className="sticky left-0 z-10 w-28 min-w-28 max-w-28 border-r border-border bg-card p-2 text-left font-normal"
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
                          <span
                            className="truncate"
                            title={
                              fighter ? localizedFighterName(fighterId, t) : t('common.unknown')
                            }
                          >
                            {fighter ? localizedFighterName(fighterId, t) : t('common.unknown')}
                          </span>
                        </div>
                      </th>
                      {columnIds.map((opponentId) => {
                        const cell = cellByKey.get(`${fighterId}:${opponentId}`);
                        return (
                          <td key={opponentId} className="p-0">
                            {cell ? (
                              renderCell(fighterId, opponentId, cell, 'table')
                            ) : (
                              <div className="h-10 min-w-16" aria-hidden="true" />
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
