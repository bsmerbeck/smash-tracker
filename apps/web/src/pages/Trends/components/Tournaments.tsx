import { Link } from 'react-router';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getWinLossRecord, type WinLossRecord } from '@/lib/stats';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { matchesForEntry } from '@/pages/Tournaments/lib/matchesForEntry';

export interface TournamentEntryRow {
  entry: TournamentEntry;
  record: WinLossRecord;
}

/**
 * Builds one row per tournament entry (the user's start.gg registry, Phase A
 * sync), each carrying the win/loss record computed by scoping matches to
 * that entry via `matchesForEntry` — the same name+window linkage the detail
 * page uses. Sorted recent-first, matching `useTournamentEntries`'s
 * newest-first API ordering (re-sorted here defensively by `lastSetAt`
 * descending in case callers pass an unsorted list). Exported as a pure
 * builder so the linkage/sort math is unit-testable without rendering.
 */
export function buildTournamentEntryRows(
  entries: TournamentEntry[],
  matches: Match[],
): TournamentEntryRow[] {
  return [...entries]
    .sort((a, b) => b.lastSetAt - a.lastSetAt)
    .map((entry) => ({
      entry,
      record: getWinLossRecord(matchesForEntry(matches, entry)),
    }));
}

function formatDate(time: number): string {
  return new Date(time).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateRange(entry: TournamentEntry): string {
  const start = formatDate(entry.firstSetAt);
  const end = formatDate(entry.lastSetAt);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * V4 Phase B: per-tournament results, rebuilt from `useTournamentEntries`
 * (the start.gg tournament registry, Phase A sync) instead of grouping
 * matches by name — a more reliable source now that it exists, and it gives
 * every row a stable `eventId` to link to `/tournaments/:eventId`. Entries
 * only start showing up after a sync that populates the registry, so the
 * resync-hint empty state is preserved for accounts with matches but no
 * entries yet.
 */
export function Tournaments({ matches }: { matches: Match[] }) {
  const { data: entries, isLoading } = useTournamentEntries();

  const rows = buildTournamentEntryRows(entries ?? [], matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tournaments</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading tournaments...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tournament entries attach on your next start.gg sync — head to{' '}
            <Link to="/settings/integrations" className="font-medium text-primary underline">
              Integrations
            </Link>{' '}
            and hit Sync now.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tournament</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>W-L</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Games</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ entry, record }) => (
                <TableRow key={entry.eventId}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/tournaments/${entry.eventId}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {entry.tournamentName ?? entry.eventName}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-normal">{entry.eventName}</TableCell>
                  <TableCell>{formatDateRange(entry)}</TableCell>
                  <TableCell>
                    {record.wins}-{record.losses}
                  </TableCell>
                  <TableCell>{record.winRate}%</TableCell>
                  <TableCell>{record.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
