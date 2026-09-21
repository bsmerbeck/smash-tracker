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
import { Button } from '@/components/ui/button';
import { getWinLossRecord, type WinLossRecord } from '@/lib/stats';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { filterEntriesByRange } from '@/hooks/useFilteredMatches';
import { entryDisplayDateRange, isAdminImportedEntry } from '@/lib/historicalTournament';
import { buildStartggUrl } from '@/pages/Tournaments/lib/startggLinks';
import type { AnalyticsRangeFilter } from '@/context/AnalyticsFilterContext';
import { cn } from '@/lib/utils';

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

/**
 * Quick 260902-bm9: mirrors — rather than shares — the identical private
 * label maps in `AnalyticsFilterControls.tsx` and `useAutoWidenEmptyRange.ts`.
 * Exporting from either would violate scope (D-06: `useAutoWidenEmptyRange`
 * stays untouched) or trip `react-refresh/only-export-components` on a
 * component module; quick 260901-tj7 already established this local-mirror
 * precedent for exactly this map. `RANGE_DAYS` (the actual cutoff math) is a
 * different matter and IS genuinely shared, via `useFilteredMatches.ts`.
 */
const RANGE_LABEL_KEYS: Record<Exclude<AnalyticsRangeFilter, 'all'>, string> = {
  '3m': 'filters.months3',
  '6m': 'filters.months6',
  '12m': 'filters.months12',
};

/**
 * Quick 260902-bm9 (D-03): shown both as a footer under a partially-hidden
 * table and in place of the table when the range hides every entry — one
 * component, one visual language (the same dashed-box/outline-button chrome
 * `FilteredEmptyNotice` uses), so there is one test target instead of two
 * near-identical variants.
 */
function HiddenByRangeNotice({
  hiddenCount,
  range,
  className,
}: {
  hiddenCount: number;
  range: Exclude<AnalyticsRangeFilter, 'all'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const { setRange } = useAnalyticsFilter();

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/50 px-4 py-3 text-sm',
        className,
      )}
    >
      <span className="text-muted-foreground">
        {t('trends.tournaments.hiddenByRange', {
          count: hiddenCount,
          range: t(RANGE_LABEL_KEYS[range]),
        })}
      </span>
      <Button variant="outline" size="sm" onClick={() => setRange('all')}>
        {t('trends.tournaments.showAllTime')}
      </Button>
    </div>
  );
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
 *
 * Quick 260902-bm9: the card read the UNFILTERED registry while scoping
 * records to already-filtered `matches`, so every event outside the global
 * analytics time range rendered as a dead row (`0-0 / — / 0` for a legacy
 * row, `— / — / —` for an imported one). Rows now filter on the same cutoff
 * `filterByRange` uses for matches and the same display dates the Dates
 * column renders, and the hidden count is surfaced with a one-click widen so
 * the narrowing is never silent. The source filter (All/Casual/Competitive)
 * is deliberately not applied here — tournament entries are inherently
 * competitive (D-02).
 */
export function Tournaments({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const { data: entries, isLoading } = useTournamentEntries();
  const { range } = useAnalyticsFilter();

  const allEntries = entries ?? [];
  const visibleEntries = filterEntriesByRange(allEntries, range);
  const hiddenCount = allEntries.length - visibleEntries.length;
  const rows = buildTournamentEntryRows(visibleEntries, matches);

  return (
    // Plan 39.1-20 [Rule 1]: `h-full` removed — TournamentsPage.tsx renders
    // this card alone in a `flex flex-col` column, never beside a sibling
    // whose height it needs to match (the grid-row it used to share inside
    // TrendsPage.tsx was removed by plan 39.1-15's recomposition), so the
    // class was dead: no definite-height ancestor for it to resolve
    // against, and now a violation of the stretch lint rule (UI-SPEC §13.2).
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.tournaments.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('trends.tournaments.loading')}</p>
        ) : allEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('trends.tournaments.resyncPrefix')}{' '}
            <Link to="/settings/integrations" className="font-medium text-primary underline">
              {t('nav.integrations')}
            </Link>{' '}
            {t('trends.tournaments.resyncSuffix')}
          </p>
        ) : rows.length === 0 && range !== 'all' ? (
          <HiddenByRangeNotice hiddenCount={hiddenCount} range={range} />
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
                // Quick 260901-tj7 (D-04): a percentage computed from zero
                // games is fabricated regardless of row origin —
                // `getWinLossRecord` returns `winRate: 100` for a 0-0
                // record — so the Rate cell below is keyed on
                // `record.total === 0` alone, not `recordUnknown`.
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
                    <TableCell>{record.total === 0 ? '—' : `${record.winRate}%`}</TableCell>
                    <TableCell>{recordUnknown ? '—' : record.total}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 && hiddenCount > 0 && range !== 'all' && (
          <HiddenByRangeNotice hiddenCount={hiddenCount} range={range} className="mt-3" />
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
