import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Download, Pencil, SlidersHorizontal, Trash2, Video } from 'lucide-react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as ReactTableInstance,
  type VisibilityState,
} from '@tanstack/react-table';
import type { Fighter, Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';
import { useClearVodAndNotes } from '@/hooks/useVodNotes';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useEnrichmentAttribution } from '@/hooks/useEnrichmentAttribution';
import { LiquipediaAttributionBadge } from '@/components/enrichment/LiquipediaAttributionBadge';
import { LiquipediaCharacterEvidence } from '@/components/enrichment/LiquipediaCharacterEvidence';
import { buildMatchCsv, matchCsvFilename } from '../lib/matchCsv';
import {
  applyMatchTableFilters,
  ALL_FILTER_VALUE,
  DEFAULT_MATCH_TABLE_FILTERS,
  getMatchTableFilterOptions,
  tournamentLabel,
  type MatchTableFilterState,
} from '../lib/matchTableFilters';
import { persistColumnVisibility, readStoredColumnVisibility } from '../lib/columnVisibility';
import { AnalyzeOpponentLink } from '@/components/AnalyzeOpponentLink';
import { EditMatchForm } from '@/components/match-form/EditMatchForm';
import { AttachVodDialog } from '@/components/vod/AttachVodDialog';
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';

const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50];

interface MatchRow {
  match: Match;
  date: string;
  fighter: ReturnType<typeof getFighterById>;
  opponentFighter: ReturnType<typeof getFighterById>;
  opponentName: string;
  stage: string;
  matchType: string;
  notes: string;
  tournament: string;
}

function toRow(match: Match): MatchRow {
  return {
    match,
    date: new Date(match.time).toLocaleString(),
    fighter: getFighterById(match.fighter_id),
    opponentFighter: getFighterById(match.opponent_id),
    opponentName: match.opponent ?? '',
    stage: match.map?.name ?? 'unknown',
    matchType: match.matchType ?? '',
    notes: match.notes ?? '',
    tournament: tournamentLabel(match),
  };
}

/** Column id -> label key, used by both the header cell and the visibility dropdown. */
const COLUMN_LABEL_KEYS: Record<string, string> = {
  date: 'matchData.table.columns.date',
  fighter: 'matchData.table.columns.fighter',
  opponentFighter: 'matchData.table.columns.opponentFighter',
  opponentName: 'matchData.table.columns.opponentName',
  stage: 'matchData.table.columns.stage',
  matchType: 'matchData.table.columns.matchType',
  win: 'matchData.table.columns.win',
  tournament: 'matchData.table.columns.tournament',
  notes: 'matchData.table.columns.notes',
};

function columnLabel(t: TFunction, columnId: string): string {
  const key = COLUMN_LABEL_KEYS[columnId];
  return key ? t(key) : columnId;
}

/** Columns that are always shown and excluded from the visibility dropdown (row actions aren't real data). */
const NON_TOGGLEABLE_COLUMNS = new Set(['actions']);

function downloadCsv(matches: Match[]) {
  const csv = buildMatchCsv(matches);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = matchCsvFilename();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Ports legacy/src/screens/MatchData/components/MatchTable using
 * @tanstack/react-table v8 in place of legacy's react-table v7: sorting,
 * global text filter (legacy's CustomInput.js), and pagination (legacy's
 * custom Pages.js). V4 Phase C adds: a Tournament column, per-column filters
 * (Fighter/Opponent/Stage/Type/Tournament, each composing via AND with the
 * global text filter), a column-visibility dropdown persisted to
 * localStorage, and a CSV export of the currently-filtered rows. Row actions
 * open EditMatchForm (prefilled, full PATCH) or a delete confirmation.
 */
export function MatchTable({
  matches,
  fighterSprites,
  layout: layoutOverride,
}: {
  matches: Match[];
  /** The signed-in user's primary+secondary fighter selections, passed through to EditMatchForm's "Your Fighter" picker. */
  fighterSprites: Fighter[];
  /** Plan 39.1-49: forces one layout (tests); otherwise read once from the viewport (below 640px: stacked rows). */
  layout?: RowLayout;
}) {
  const { t } = useTranslation();
  // Plan 39.1-49 (UI-SPEC §6.6): exactly one of the table / stacked roots
  // mounts; sorting, filters, pagination and dialogs are shared.
  const layout = useRowLayout(layoutOverride);
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  // Phase 30.3 (Gate 6): CSV export is one of the affordances a demo/
  // research account must never see enabled (owner/Codex hard gate) — the
  // API refuses the underlying export server-side; this is the affordance
  // half, disable-with-explanation rather than a silent removal so the
  // control's absence is never mistaken for a bug.
  const isDemoAccount = useIsDemoAccount();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'date', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<MatchTableFilterState>(
    DEFAULT_MATCH_TABLE_FILTERS,
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    readStoredColumnVisibility(),
  );
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const [vodMatch, setVodMatch] = useState<Match | null>(null);
  const [pendingRemoveVod, setPendingRemoveVod] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();
  const clearVodAndNotes = useClearVodAndNotes();
  // Phase 30.2 Plan 11 (ENR-09): the witness lives OFF the match row — this
  // is the only way the stage cell / VOD menu learn whether a value came
  // from Liquipedia. Keyed by every match id currently in the (unpaginated)
  // dataset, never by the match record itself.
  const matchIds = useMemo(() => matches.map((m) => m.id), [matches]);
  const attribution = useEnrichmentAttribution(matchIds);

  useEffect(() => {
    persistColumnVisibility(columnVisibility);
  }, [columnVisibility]);

  const filterOptions = useMemo(() => getMatchTableFilterOptions(matches), [matches]);
  const columnFilteredMatches = useMemo(
    () => applyMatchTableFilters(matches, columnFilters),
    [matches, columnFilters],
  );

  const data = useMemo(() => columnFilteredMatches.map(toRow), [columnFilteredMatches]);

  const columns = useMemo<ColumnDef<MatchRow>[]>(
    () => [
      {
        id: 'date',
        header: columnLabel(t, 'date'),
        accessorFn: (row) => row.match.time,
        cell: ({ row }) => row.original.date,
      },
      {
        id: 'fighter',
        header: columnLabel(t, 'fighter'),
        accessorFn: (row) =>
          row.fighter ? localizedFighterName(row.fighter.id, t) : t('common.unknown'),
        cell: ({ row }) => {
          // Phase 30.3 Gate 5: the "X vs Y" character evidence half — present
          // only when Liquipedia's seat orientation was proven for this row
          // — renders BELOW the row's own recorded fighter, mirroring the
          // stage column's own value-plus-badge pattern above. Raw text
          // fallback (inside `LiquipediaCharacterEvidence`) covers exactly
          // the case where this cell shows "Unknown" but Liquipedia's
          // evidence still names a character.
          const charactersHalf = attribution[row.original.match.id]?.characters;
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                {row.original.fighter && (
                  <img src={row.original.fighter.url} alt="" className="size-6 object-contain" />
                )}
                <span>
                  {row.original.fighter
                    ? localizedFighterName(row.original.fighter.id, t)
                    : t('common.unknown')}
                </span>
              </div>
              {charactersHalf != null && (
                <LiquipediaCharacterEvidence characters={charactersHalf} />
              )}
            </div>
          );
        },
      },
      {
        id: 'opponentFighter',
        header: columnLabel(t, 'opponentFighter'),
        accessorFn: (row) =>
          row.opponentFighter
            ? localizedFighterName(row.opponentFighter.id, t)
            : t('common.unknown'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.opponentFighter && (
              <img
                src={row.original.opponentFighter.url}
                alt=""
                className="size-6 object-contain"
              />
            )}
            <span>
              {row.original.opponentFighter
                ? localizedFighterName(row.original.opponentFighter.id, t)
                : t('common.unknown')}
            </span>
          </div>
        ),
      },
      {
        id: 'opponentName',
        header: columnLabel(t, 'opponentName'),
        accessorFn: (row) => row.opponentName,
        cell: ({ row }) => {
          // Phase 30.3 (Gate 4): every named opponent cell carries an
          // "Analyze opponent" deep link into the existing /opponents
          // scouting surface (provider player ID first, alias-aware tag
          // fallback). AnalyzeOpponentLink renders nothing for unnamed
          // rows or non-personal subjects.
          const match = row.original.match;
          if (row.original.opponentName === '') {
            return null;
          }
          return (
            <span className="inline-flex items-center gap-1.5">
              {row.original.opponentName}
              <AnalyzeOpponentLink
                identity={{
                  opponentUserSlug: match.opponentUserSlug,
                  opponentParryUserId: match.opponentParryUserId,
                  opponent: match.opponent,
                }}
              />
            </span>
          );
        },
      },
      {
        id: 'stage',
        header: columnLabel(t, 'stage'),
        accessorFn: (row) => row.stage,
        cell: ({ row }) => {
          // Phase 30.2 Plan 11 (ENR-09), 30.2 gap-closure BLOCKER 2: the
          // STAGE HALF's mere presence is now the precise signal that this
          // row's stage came from Liquipedia — it is built only from the
          // witness's stage members, so a match enriched solely on its VOD
          // field produces no stage half and no badge here.
          const stageHalf = attribution[row.original.match.id]?.stage;
          return (
            <div className="flex flex-col gap-0.5">
              <span>{row.original.stage}</span>
              {stageHalf != null && (
                <LiquipediaAttributionBadge attribution={stageHalf} variant="stage" />
              )}
            </div>
          );
        },
      },
      {
        id: 'matchType',
        header: columnLabel(t, 'matchType'),
        accessorFn: (row) => row.matchType,
      },
      {
        id: 'win',
        header: columnLabel(t, 'win'),
        accessorFn: (row) => (row.match.win ? t('common.win') : t('common.loss')),
        cell: ({ row }) => (
          <Badge variant={row.original.match.win ? 'success' : 'destructive'}>
            {row.original.match.win ? t('common.win') : t('common.loss')}
          </Badge>
        ),
      },
      {
        id: 'tournament',
        header: columnLabel(t, 'tournament'),
        accessorFn: (row) => row.tournament,
      },
      {
        id: 'notes',
        header: columnLabel(t, 'notes'),
        accessorFn: (row) => row.notes,
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-[16ch]" title={row.original.notes}>
            {row.original.notes}
          </span>
        ),
      },
      {
        id: 'actions',
        header: t('matchData.table.columns.manage'),
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => {
          const hasVod = row.original.match.vodUrl != null;
          const source = row.original.match.source;
          // Phase 30.2 Plan 11 (ENR-09), 30.2 gap-closure BLOCKER 2: the VOD
          // HALF, and only it. Its `sourcePageUrl` is the VOD observation's
          // own page — under the previous single-slot shape this menu item
          // opened the STAGE observation's page whenever both fields were
          // enriched, and appeared at all for stage-only-enriched rows whose
          // VOD the user had typed themselves.
          const vodAttribution = attribution[row.original.match.id]?.vod;
          return (
            <div className="flex items-center justify-end gap-2">
              {hasVod ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('matchData.table.watchVod')}
                      className="border-primary text-primary"
                    >
                      <Video />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => navigate(subjectPath(`/vod?match=${row.original.match.id}`))}
                    >
                      {t('matchData.table.vodMenu.goToManager')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditingMatch(row.original.match)}>
                      {t('matchData.table.vodMenu.editLink')}
                    </DropdownMenuItem>
                    {vodAttribution?.sourcePageUrl != null && (
                      <DropdownMenuItem
                        onSelect={() => {
                          const sourcePageUrl = vodAttribution.sourcePageUrl;
                          if (sourcePageUrl != null) {
                            window.open(sourcePageUrl, '_blank', 'noopener,noreferrer');
                          }
                        }}
                      >
                        {t('enrichment.attribution.sourceLink')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setPendingRemoveVod(row.original.match)}
                    >
                      {t('matchData.table.vodMenu.removeLink')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('matchData.table.addVod')}
                  onClick={() => setVodMatch(row.original.match)}
                >
                  <Video />
                </Button>
              )}
              {source ? (
                // Synced matches: game data is managed by start.gg/parry.gg
                // sync (the API 409s edits/deletes too) — VOD notes above
                // stay editable.
                <Badge
                  variant="outline"
                  title={t('matchData.table.syncedTitle', {
                    source: source === 'startgg' ? 'start.gg' : 'parry.gg',
                  })}
                >
                  {t('matchData.table.synced')}
                </Badge>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('matchData.table.editMatch')}
                    onClick={() => setEditingMatch(row.original.match)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('shared.matchDelete.aria')}
                    onClick={() => setPendingDelete(row.original.match)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          );
        },
      },
    ],
    [t, navigate, subjectPath, attribution],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 10 } },
  });

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMatch.mutateAsync(pendingDelete.id);
      toast.success(t('shared.matchDelete.deleted'));
    } catch {
      toast.error(t('shared.matchDelete.deleteFailed'));
    } finally {
      setPendingDelete(null);
    }
  }

  async function confirmRemoveVod() {
    if (!pendingRemoveVod) return;
    try {
      // Phase 8: "omit to clear" no longer works for vodTimestamps (an
      // unrelated match-fact PATCH now preserves notes on omission) — this
      // explicit clear-VOD-and-notes endpoint is the ONLY way to still drop
      // both together (RESEARCH Pitfall 2).
      await clearVodAndNotes.mutateAsync(pendingRemoveVod.id);
      toast.success(t('matchData.table.removeVodConfirm.removed'));
    } catch {
      toast.error(t('matchData.table.removeVodConfirm.removeFailed'));
    } finally {
      setPendingRemoveVod(null);
    }
  }

  function handleExportCsv() {
    // Export the currently-filtered rows: column filters + global text
    // filter both applied, matching exactly what's rendered on screen.
    const visibleIds = new Set(table.getFilteredRowModel().rows.map((r) => r.original.match.id));
    const exportMatches = columnFilteredMatches.filter((m) => visibleIds.has(m.id));
    downloadCsv(exportMatches);
  }

  // Quick 260901-tj7 (D-04): this branch is only reachable when the global
  // analytics filter excluded everything — `MatchDataPage` is the sole
  // caller and returns its own "no matches at all" hero early when
  // `allMatches.length === 0`. The old copy here ("You have no matches,
  // report a match…") asserted something false: the user HAS matches, they
  // are just filtered out. The page-level `FilteredEmptyNotice` (rendered
  // above this card, with its own "Clear filters" button) is the honest,
  // actionable surface — this card body adds nothing.
  if (matches.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" data-slot="match-table-toolbar">
        <Input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder={t('matchData.table.searchPlaceholder', { count: data.length })}
          // Plan 39.1-49: below 640px the search spans the row; 640+ unchanged.
          className="max-sm:max-w-none sm:max-w-xs"
          aria-label={t('matchData.table.searchAria')}
        />

        <ColumnFilterSelect
          label={t('matchForm.yourFighter')}
          value={columnFilters.fighter}
          options={filterOptions.fighters}
          onChange={(value) => setColumnFilters((prev) => ({ ...prev, fighter: value }))}
        />
        <ColumnFilterSelect
          label={t('matchForm.opponentFighter')}
          value={columnFilters.opponentFighter}
          options={filterOptions.opponentFighters}
          onChange={(value) => setColumnFilters((prev) => ({ ...prev, opponentFighter: value }))}
        />
        <ColumnFilterSelect
          label={t('matchData.table.columns.stage')}
          value={columnFilters.stage}
          options={filterOptions.stages}
          onChange={(value) => setColumnFilters((prev) => ({ ...prev, stage: value }))}
        />
        <ColumnFilterSelect
          label={t('matchData.table.columns.matchType')}
          value={columnFilters.matchType}
          options={filterOptions.matchTypes}
          onChange={(value) => setColumnFilters((prev) => ({ ...prev, matchType: value }))}
        />
        <ColumnFilterSelect
          label={t('matchData.table.columns.tournament')}
          value={columnFilters.tournament}
          options={filterOptions.tournaments}
          onChange={(value) => setColumnFilters((prev) => ({ ...prev, tournament: value }))}
        />

        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontal />
                {t('matchData.table.columnsButton')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('matchData.table.toggleColumns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllColumns()
                .filter((column) => !NON_TOGGLEABLE_COLUMNS.has(column.id))
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {columnLabel(t, column.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={isDemoAccount}
            title={isDemoAccount ? t('demo.disabledReason') : undefined}
          >
            <Download />
            {t('matchData.table.exportCsv')}
          </Button>
        </div>
      </div>

      {layout === 'stack' ? (
        <MatchTableStack table={table} t={t} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table data-slot="match-table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={header.column.getCanSort() ? 'cursor-pointer select-none' : ''}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' \u{1F53C}'}
                      {header.column.getIsSorted() === 'desc' && ' \u{1F53D}'}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleFlatColumns().length}
                    className="text-center text-muted-foreground"
                  >
                    {t('matchData.table.noneFound')}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            {'<<'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            {'<'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            {'>'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            {'>>'}
          </Button>
        </div>
        <span className="text-sm text-muted-foreground">
          {t('matchData.table.pageOf', {
            page: table.getState().pagination.pageIndex + 1,
            total: Math.max(1, table.getPageCount()),
          })}
        </span>
        <Select
          value={String(table.getState().pagination.pageSize)}
          onValueChange={(value) => table.setPageSize(Number(value))}
        >
          <SelectTrigger className="w-[110px]" aria-label={t('matchData.table.rowsPerPage')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {t('matchData.table.showN', { count: size })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {editingMatch && (
        <EditMatchForm
          match={editingMatch}
          fighterSprites={fighterSprites}
          open={editingMatch != null}
          onOpenChange={(open) => !open && setEditingMatch(null)}
          onDelete={(match) => {
            setEditingMatch(null);
            setPendingDelete(match);
          }}
        />
      )}

      {vodMatch && (
        <AttachVodDialog
          match={vodMatch}
          open={vodMatch != null}
          onOpenChange={(open) => !open && setVodMatch(null)}
        />
      )}

      <AlertDialog
        open={pendingRemoveVod != null}
        onOpenChange={(open) => !open && setPendingRemoveVod(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('matchData.table.removeVodConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common.cannotBeUndone')}
              <br />
              {t('matchData.table.removeVodConfirm.sharesNote')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveVod}>{t('common.remove')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('shared.matchDelete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common.cannotBeUndone')}
              <br />
              {t('shared.matchDelete.sharesNote')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One column-filter Select, with an "All" reset option prepended — options are derived from the current dataset by the caller. */
function ColumnFilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      {/* Plan 39.1-49 (OOS-10): content-sized so the whole "All <label>"
          reads (capped; a long selected value truncates with its full text
          as the title); below 640px each select spans the toolbar row. */}
      <SelectTrigger
        className="w-auto max-w-[16rem] min-w-[150px] max-sm:w-full max-sm:max-w-none"
        aria-label={label}
        title={value !== ALL_FILTER_VALUE ? value : undefined}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_FILTER_VALUE}>
          {t('matchData.table.allOption', { label })}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Plan 39.1-49: the pairing cells that lead a stacked row (line 1); every other visible cell wraps on line 2. */
const STACK_SUBJECT_COLUMNS = new Set(['fighter', 'opponentFighter', 'opponentName']);

/**
 * Plan 39.1-49 (UI-SPEC §6.6 "< 640 tables become stacked rows", §6.5 rules
 * 1-2): the match table's phone layout, built from each row's OWN visible
 * cells through the same `flexRender` cell definitions the table uses — one
 * rendering definition for both layouts. Line 1 is the pairing (fighter vs
 * opponent fighter, opponent name — its full text as the title) with the
 * row's actions at its end; line 2 the remaining values (date, stage, type,
 * result, tournament, notes) as whole tokens that wrap, each with its column
 * label for assistive tech. Above the list, the sortable columns' header
 * labels as buttons driving the same sort handlers as the table headers.
 */
function MatchTableStack({ table, t }: { table: ReactTableInstance<MatchRow>; t: TFunction }) {
  const rows = table.getRowModel().rows;
  const sortable = (table.getHeaderGroups()[0]?.headers ?? []).filter(
    (header) => !header.isPlaceholder && header.column.getCanSort(),
  );
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm"
        data-slot="match-table-sort"
      >
        {sortable.map((header) => (
          <button
            key={header.id}
            type="button"
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={header.column.getToggleSortingHandler()}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
            {header.column.getIsSorted() === 'asc' && ' \u{1F53C}'}
            {header.column.getIsSorted() === 'desc' && ' \u{1F53D}'}
          </button>
        ))}
      </div>
      <ul data-slot="match-table" className="flex flex-col divide-y rounded-md border">
        {rows.length === 0 ? (
          <li className="p-3 text-center text-sm text-muted-foreground">
            {t('matchData.table.noneFound')}
          </li>
        ) : (
          rows.map((row) => {
            const cells = row.getVisibleCells();
            const subject = cells.filter((cell) => STACK_SUBJECT_COLUMNS.has(cell.column.id));
            const actions = cells.find((cell) => cell.column.id === 'actions');
            const rest = cells.filter(
              (cell) => !STACK_SUBJECT_COLUMNS.has(cell.column.id) && cell.column.id !== 'actions',
            );
            const { fighter, opponentFighter, opponentName } = row.original;
            const subjectTitle = [
              `${fighter ? localizedFighterName(fighter.id, t) : t('common.unknown')} ${t('matchups.vs')} ${opponentFighter ? localizedFighterName(opponentFighter.id, t) : t('common.unknown')}`,
              opponentName,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={row.id}
                data-slot="match-table-row"
                className="flex min-w-0 flex-col gap-2 p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <div
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium"
                    title={subjectTitle}
                  >
                    {subject.map((cell) => (
                      <div key={cell.id} className="flex max-w-full min-w-0 items-center gap-2">
                        <span className="sr-only">{columnLabel(t, cell.column.id)}</span>
                        {cell.column.id === 'opponentFighter' && (
                          <span aria-hidden="true" className="text-muted-foreground">
                            {t('matchups.vs')}
                          </span>
                        )}
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                  {actions && (
                    <div className="shrink-0">
                      {flexRender(actions.column.columnDef.cell, actions.getContext())}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {rest.map((cell) => (
                    <div key={cell.id} className="flex max-w-full min-w-0 items-center break-words">
                      <span className="sr-only">{columnLabel(t, cell.column.id)} </span>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
