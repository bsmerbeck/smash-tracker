import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Trash2 } from 'lucide-react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
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
import { EditMatchForm } from './EditMatchForm';

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
  };
}

/**
 * Ports legacy/src/screens/MatchData/components/MatchTable using
 * @tanstack/react-table v8 in place of legacy's react-table v7: sorting,
 * global text filter (legacy's CustomInput.js), and pagination (legacy's
 * custom Pages.js). Row actions open EditMatchForm (prefilled, full PATCH)
 * or a delete confirmation.
 */
export function MatchTable({
  matches,
  fighterSprites,
}: {
  matches: Match[];
  /** The signed-in user's primary+secondary fighter selections, passed through to EditMatchForm's "Your Fighter" picker. */
  fighterSprites: Fighter[];
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'date', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();

  const data = useMemo(() => matches.map(toRow), [matches]);

  const columns = useMemo<ColumnDef<MatchRow>[]>(
    () => [
      {
        id: 'date',
        header: 'Date',
        accessorFn: (row) => row.match.time,
        cell: ({ row }) => row.original.date,
      },
      {
        id: 'fighter',
        header: 'Fighter',
        accessorFn: (row) => row.fighter?.name ?? 'Unknown',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.fighter && (
              <img src={row.original.fighter.url} alt="" className="size-6 object-contain" />
            )}
            <span>{row.original.fighter?.name ?? 'Unknown'}</span>
          </div>
        ),
      },
      {
        id: 'opponentFighter',
        header: 'Opponent',
        accessorFn: (row) => row.opponentFighter?.name ?? 'Unknown',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.opponentFighter && (
              <img
                src={row.original.opponentFighter.url}
                alt=""
                className="size-6 object-contain"
              />
            )}
            <span>{row.original.opponentFighter?.name ?? 'Unknown'}</span>
          </div>
        ),
      },
      {
        id: 'opponentName',
        header: 'Opponent Name',
        accessorFn: (row) => row.opponentName,
      },
      {
        id: 'stage',
        header: 'Stage',
        accessorFn: (row) => row.stage,
      },
      {
        id: 'matchType',
        header: 'Type',
        accessorFn: (row) => row.matchType,
      },
      {
        id: 'win',
        header: 'Result',
        accessorFn: (row) => (row.match.win ? 'Win' : 'Loss'),
        cell: ({ row }) => (
          <Badge variant={row.original.match.win ? 'success' : 'destructive'}>
            {row.original.match.win ? 'Win' : 'Loss'}
          </Badge>
        ),
      },
      {
        id: 'notes',
        header: 'Notes',
        accessorFn: (row) => row.notes,
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-[16ch]" title={row.original.notes}>
            {row.original.notes}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Manage',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Edit match"
              onClick={() => setEditingMatch(row.original.match)}
            >
              <Pencil />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Delete match"
              onClick={() => setPendingDelete(row.original.match)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
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
      toast.success('Match deleted!');
    } catch {
      toast.error('Failed to delete match. Please try again.');
    } finally {
      setPendingDelete(null);
    }
  }

  if (matches.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        You have no matches, report a match and check back here to view match data!
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
        placeholder={`Search ${data.length} records...`}
        className="max-w-xs"
        aria-label="Filter matches"
      />

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
                <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                  No matches found.
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
          Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
        </span>
        <Select
          value={String(table.getState().pagination.pageSize)}
          onValueChange={(value) => table.setPageSize(Number(value))}
        >
          <SelectTrigger className="w-[110px]" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                Show {size}
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
        />
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this match?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
