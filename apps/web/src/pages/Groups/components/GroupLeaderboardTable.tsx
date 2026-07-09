import { useTranslation } from 'react-i18next';
import type { LeaderboardEntry } from '@smash-tracker/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatRelativeDate } from '@/lib/relativeDate';

/**
 * Rank, display name, rating ± RD, games, and last-active for each member.
 * Entries arrive pre-sorted by rating descending; the caller's own row
 * (`isYou`) is visually highlighted.
 */
export function GroupLeaderboardTable({ entries }: { entries: LeaderboardEntry[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">#</TableHead>
          <TableHead>{t('groups.table.player')}</TableHead>
          <TableHead className="text-right">{t('groups.table.rating')}</TableHead>
          <TableHead className="text-right">{t('groups.table.games')}</TableHead>
          <TableHead className="text-right">{t('groups.table.lastActive')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry, index) => (
          <TableRow
            key={entry.uid}
            className={cn(entry.isYou && 'bg-primary/5 font-medium hover:bg-primary/10')}
          >
            <TableCell className="text-muted-foreground">{index + 1}</TableCell>
            <TableCell>
              {entry.displayName}
              {entry.isYou && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {t('groups.table.you')}
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {entry.rating} <span className="text-muted-foreground">± {entry.rd}</span>
            </TableCell>
            <TableCell className="text-right tabular-nums">{entry.games}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {entry.lastMatchAt != null
                ? formatRelativeDate(entry.lastMatchAt, t)
                : t('groups.table.never')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
