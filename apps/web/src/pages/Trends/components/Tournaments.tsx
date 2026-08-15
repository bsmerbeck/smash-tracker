import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { matchesForEntry, type Match, type TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getWinLossRecord, type WinLossRecord } from '@/lib/stats';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { entryDisplayDateRange, isAdminImportedEntry } from '@/lib/historicalTournament';
import { buildStartggUrl } from '@/pages/Tournaments/lib/startggLinks';

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

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Phase 30.3 (Gate 4): dates render from `entryDisplayDateRange` — imported
 * rows prefer the public data's own event dates, and an entry with nothing
 * recorded renders the '—' missing marker rather than an epoch-zero date.
 */
function formatDateRange(entry: TournamentEntry, locale: string): string {
  const range = entryDisplayDateRange(entry);
  if (range == null) {
    return '—';
  }
  const start = formatDate(range.startMs, locale);
  const end = formatDate(range.endMs, locale);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * V4 Phase B: per-tournament results, rebuilt from `useTournamentEntries`
 * (the start.gg tournament registry, Phase A sync) instead of grouping
 * matches by name — a more reliable source now that it exists, and it gives
 * every row a stable `entryKey` to link to `/tournaments/:entryKey`. Entries
 * only start showing up after a sync that populates the registry, so the
 * resync-hint empty state is preserved for accounts with matches but no
 * entries yet.
 *
 * V5 Phase B: rows also carry a small outbound start.gg icon-link when the
 * entry's `slug` has synced (`stopPropagation` on click so it doesn't also
 * trigger the internal row link); hidden entirely when the slug is absent
 * (always the case for a parry.gg entry, Phase 7).
 *
 * Phase 7: row links + keys route on the source-agnostic `entryKey` (never
 * the start.gg-only numeric `eventId`, which is absent on parry.gg entries)
 * so both sources' rows link correctly into the detail page.
 */
export function Tournaments({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const { data: entries, isLoading } = useTournamentEntries();

  const rows = buildTournamentEntryRows(entries ?? [], matches);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('trends.tournaments.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('trends.tournaments.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('trends.tournaments.resyncPrefix')}{' '}
            <Link to="/settings/integrations" className="font-medium text-primary underline">
              {t('nav.integrations')}
            </Link>{' '}
            {t('trends.tournaments.resyncSuffix')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('trends.tournaments.tournament')}</TableHead>
                <TableHead>{t('trends.tournaments.event')}</TableHead>
                <TableHead>{t('trends.tournaments.dates')}</TableHead>
                <TableHead>{t('trends.monthly.wl')}</TableHead>
                <TableHead>{t('common.rate')}</TableHead>
                <TableHead>{t('trends.monthly.games')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ entry, record }) => {
                const startggUrl = buildStartggUrl(entry.slug);
                const imported = isAdminImportedEntry(entry);
                // Phase 30.3 (Gate 4): an imported snapshot with no locally
                // linked match rows has NO observed games — 0-0/0%/0 would
                // fabricate a zero record out of missing data, so those
                // cells render the '—' missing marker instead.
                const recordUnknown = imported && record.total === 0;
                return (
                  <TableRow key={entry.entryKey ?? entry.eventId}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <Link
                          to={`/tournaments/${entry.entryKey}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {entry.tournamentName ?? entry.eventName}
                        </Link>
                        {imported && (
                          <Badge variant="outline" title={t('tournaments.imported.listFootnote')}>
                            {t('tournaments.imported.badge')}
                          </Badge>
                        )}
                        {startggUrl && (
                          <a
                            href={startggUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('shared.startgg.view')}
                            className="inline-flex text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">{entry.eventName}</TableCell>
                    <TableCell>{formatDateRange(entry, i18n.language)}</TableCell>
                    <TableCell>{recordUnknown ? '—' : `${record.wins}-${record.losses}`}</TableCell>
                    <TableCell>{recordUnknown ? '—' : `${record.winRate}%`}</TableCell>
                    <TableCell>{recordUnknown ? '—' : record.total}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.some(({ entry }) => isAdminImportedEntry(entry)) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('tournaments.imported.listFootnote')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
