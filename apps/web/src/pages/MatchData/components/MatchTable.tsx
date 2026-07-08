import { useEffect, useMemo, useState } from 'react';
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
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
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
import { EditMatchForm } from '@/components/match-form/EditMatchForm';
import { VodNotesDialog } from '@/components/vod/VodNotesDialog';
import { cn } from '@/lib/utils';

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
}: {
  matches: Match[];
  /** The signed-in user's primary+secondary fighter selections, passed through to EditMatchForm's "Your Fighter" picker. */
  fighterSprites: Fighter[];
}) {
  const { t } = useTranslation();
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
  const deleteMatch = useDeleteMatch();

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
        accessorFn: (row) => row.fighter?.name ?? t('common.unknown'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.fighter && (
              <img src={row.original.fighter.url} alt="" className="size-6 object-contain" />
            )}
            <span>{row.original.fighter?.name ?? t('common.unknown')}</span>
          </div>
        ),
      },
      {
        id: 'opponentFighter',
        header: columnLabel(t, 'opponentFighter'),
        accessorFn: (row) => row.opponentFighter?.name ?? t('common.unknown'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.opponentFighter && (
              <img
                src={row.original.opponentFighter.url}
                alt=""
                className="size-6 object-contain"
              />
            )}
            <span>{row.original.opponentFighter?.name ?? t('common.unknown')}</span>
          </div>
        ),
      },
      {
        id: 'opponentName',
        header: columnLabel(t, 'opponentName'),
        accessorFn: (row) => row.opponentName,
      },
      {
        id: 'stage',
        header: columnLabel(t, 'stage'),
        accessorFn: (row) => row.stage,
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
          return (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={hasVod ? t('matchData.table.editVod') : t('matchData.table.addVod')}
                className={cn(hasVod && 'border-primary text-primary')}
                onClick={() => setVodMatch(row.original.match)}
              >
                <Video />
              </Button>
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
    [t],
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

  function handleExportCsv() {
    // Export the currently-filtered rows: column filters + global text
    // filter both applied, matching exactly what's rendered on screen.
    const visibleIds = new Set(table.getFilteredRowModel().rows.map((r) => r.original.match.id));
    const exportMatches = columnFilteredMatches.filter((m) => visibleIds.has(m.id));
    downloadCsv(exportMatches);
  }

  if (matches.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">{t('matchData.noMatches')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder={t('matchData.table.searchPlaceholder', { count: data.length })}
          className="max-w-xs"
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

          <Button variant="outline" size="sm" onClick={handleExportCsv}>
            <Download />
            {t('matchData.table.exportCsv')}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
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
        <VodNotesDialog
          match={vodMatch}
          open={vodMatch != null}
          onOpenChange={(open) => !open && setVodMatch(null)}
        />
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('shared.matchDelete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
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
      <SelectTrigger className="w-[150px]" aria-label={label}>
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
