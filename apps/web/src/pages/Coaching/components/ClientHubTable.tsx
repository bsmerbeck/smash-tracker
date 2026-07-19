import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Archive, ArchiveRestore, Download, MoreHorizontal, Trash2 } from 'lucide-react';
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
import type { ClientHubRow } from '@smash-tracker/shared';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Derives a "next action" label from the row's own bounded fields
 * (`lastActivityAt`/`draftCount`/`archivedAt`) — the Client Hub row schema
 * has no dedicated `nextAction` field, so this heuristic composes one from
 * data already on the row rather than requiring a new server field.
 */
function nextActionKey(row: ClientHubRow): string {
  if (row.archivedAt != null) {
    return 'coaching.hub.table.nextAction.archived';
  }
  if (row.lastActivityAt == null) {
    return 'coaching.hub.table.nextAction.addFirstMatch';
  }
  if (row.draftCount > 0) {
    return 'coaching.hub.table.nextAction.continueDraft';
  }
  return 'coaching.hub.table.nextAction.openWorkspace';
}

function formatLastActivity(t: TFunction, epochMs: number | null | undefined): string {
  if (epochMs == null) {
    return t('coaching.hub.table.noActivity');
  }
  return new Date(epochMs).toLocaleDateString();
}

function DeliveryStateBadge({ state }: { state: ClientHubRow['deliveryState'] }) {
  const { t } = useTranslation();
  if (state === 'delivered') {
    return <Badge variant="secondary">{t('coaching.hub.table.delivery.delivered')}</Badge>;
  }
  if (state === 'acknowledged') {
    return <Badge variant="success">{t('coaching.hub.table.delivery.acknowledged')}</Badge>;
  }
  // Neutral placeholder — review delivery ships in Phase 12.
  return <Badge variant="outline">{t('coaching.hub.table.delivery.none')}</Badge>;
}

export interface ClientHubTableProps {
  clients: ClientHubRow[];
  onArchiveToggle: (client: ClientHubRow) => void;
  onExport: (client: ClientHubRow) => void;
  onDeleteRequest: (client: ClientHubRow) => void;
}

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-05): the compact
 * searchable/sortable/paginated Client Hub table — mirrors
 * `apps/web/src/pages/MatchData/components/MatchTable.tsx`'s
 * `@tanstack/react-table` setup (`getFilteredRowModel`/`getSortedRowModel`/
 * `getPaginationRowModel` + `globalFilter`). Columns: label, last activity,
 * next action, draft count, delivery/acknowledgement state (nullish until
 * Phase 12 ships review delivery — renders a neutral placeholder), and a
 * per-row actions menu (open workspace, export, archive/restore, delete).
 */
export function ClientHubTable({
  clients,
  onArchiveToggle,
  onExport,
  onDeleteRequest,
}: ClientHubTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'label', desc: false }]);
  const [globalFilter, setGlobalFilter] = useState('');

  const columns = useMemo<ColumnDef<ClientHubRow>[]>(
    () => [
      {
        id: 'label',
        header: t('coaching.hub.table.columns.label'),
        accessorFn: (row) => row.label,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.label}</span>
            {row.original.archivedAt != null && (
              <Badge variant="outline">{t('coaching.hub.table.archivedBadge')}</Badge>
            )}
          </div>
        ),
      },
      {
        id: 'lastActivity',
        header: t('coaching.hub.table.columns.lastActivity'),
        accessorFn: (row) => row.lastActivityAt ?? 0,
        cell: ({ row }) => formatLastActivity(t, row.original.lastActivityAt),
      },
      {
        id: 'nextAction',
        header: t('coaching.hub.table.columns.nextAction'),
        accessorFn: (row) => t(nextActionKey(row)),
      },
      {
        id: 'draftCount',
        header: t('coaching.hub.table.columns.draftCount'),
        accessorFn: (row) => row.draftCount,
        cell: ({ row }) => t('coaching.hub.table.drafts', { count: row.original.draftCount }),
      },
      {
        id: 'deliveryState',
        header: t('coaching.hub.table.columns.deliveryState'),
        accessorFn: (row) => row.deliveryState ?? 'none',
        cell: ({ row }) => <DeliveryStateBadge state={row.original.deliveryState} />,
      },
      {
        id: 'actions',
        header: t('coaching.hub.table.columns.actions'),
        enableSorting: false,
        cell: ({ row }) => {
          const client = row.original;
          const isArchived = client.archivedAt != null;
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('coaching.hub.table.actionsAria', { label: client.label })}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => navigate(`/coach/${client.clientId}/vods`)}>
                    {t('coaching.hub.table.actions.openWorkspace')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onExport(client)}>
                    <Download />
                    {t('coaching.hub.table.actions.export')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onArchiveToggle(client)}>
                    {isArchived ? <ArchiveRestore /> : <Archive />}
                    {isArchived
                      ? t('coaching.hub.table.actions.restore')
                      : t('coaching.hub.table.actions.archive')}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDeleteRequest(client)}>
                    <Trash2 />
                    {t('coaching.hub.table.actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [t, navigate, onArchiveToggle, onExport, onDeleteRequest],
  );

  const table = useReactTable({
    data: clients,
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

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
        placeholder={t('coaching.hub.table.searchPlaceholder')}
        className="max-w-xs"
        aria-label={t('coaching.hub.table.searchAria')}
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
                <TableCell
                  colSpan={table.getVisibleFlatColumns().length}
                  className="text-center text-muted-foreground"
                >
                  {t('coaching.hub.table.noneFound')}
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
          {t('coaching.hub.table.pageOf', {
            page: table.getState().pagination.pageIndex + 1,
            total: Math.max(1, table.getPageCount()),
          })}
        </span>
      </div>
    </div>
  );
}
