import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { Record } from '@/components/analytics/Record';
import { RecordBar } from '@/components/charts/inlineMarks';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { filterEntriesByRange } from '@/hooks/useFilteredMatches';
import { entryDisplayDateRange } from '@/lib/historicalTournament';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildTournamentEntryRows, type TournamentEntryRow } from './Tournaments';

function formatDateRange(entry: TournamentEntryRow['entry'], locale: string): string {
  const range = entryDisplayDateRange(entry);
  if (range == null) {
    return '—';
  }
  const format = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const start = format(range.startMs);
  const end = format(range.endMs);
  return start === end ? start : `${start} – ${end}`;
}

interface RecentEventRowProps {
  row: TournamentEntryRow;
  href: string;
  locale: string;
}

/**
 * One row's right side (UI-SPEC §8.2 rail table): placement (+ entrants) and
 * seed when the registry entry carries them (D-15's "never inferred"
 * honesty rule — read only when present), the plain `Record`/`RecordBar`
 * otherwise.
 */
function RecentEventRight({ row }: { row: TournamentEntryRow }) {
  const { t } = useTranslation();
  const { entry, record } = row;
  const hasPlacementBlock = entry.placement != null && entry.numEntrants != null;
  const hasSeed = entry.seed != null;

  if (hasPlacementBlock && hasSeed) {
    return (
      <span data-slot="recent-event-placement">
        {t('trends.recentEvents.placementAndSeed', {
          placement: entry.placement,
          entrants: entry.numEntrants,
          seed: entry.seed,
        })}
      </span>
    );
  }
  if (hasPlacementBlock) {
    return (
      <span data-slot="recent-event-placement">
        {t('trends.recentEvents.placementOnly', {
          placement: entry.placement,
          entrants: entry.numEntrants,
        })}
      </span>
    );
  }
  if (hasSeed) {
    return (
      <span data-slot="recent-event-placement">
        {t('trends.recentEvents.seedOnly', { seed: entry.seed })}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1" data-slot="recent-event-record">
      <Record wins={record.wins} losses={record.losses} cue="none" />
      <RecordBar wins={record.wins} losses={record.losses} />
    </span>
  );
}

function RecentEventRow({ row, href, locale }: RecentEventRowProps) {
  const { t } = useTranslation();
  const { entry } = row;
  const name = entry.tournamentName ?? entry.eventName;
  const dateRange = formatDateRange(entry, locale);

  return (
    <li className="relative flex items-center gap-2 rounded-md p-2 hover:bg-accent">
      <DrillableRow
        as="overlay"
        to={href}
        ariaLabel={t('shared.drillableRow.aria', { subject: name, context: dateRange })}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate" title={name}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground">{dateRange}</p>
      </div>
      <RecentEventRight row={row} />
      <DrillableRowChevron />
    </li>
  );
}

export interface RecentEventsProps {
  matches: Match[];
}

/**
 * The left rail's second card (UI-SPEC §8.2 Row 3, replaces the six-column
 * `Tournaments` table on Trends — it clipped its W-L column in a half-width
 * slot). `Tournaments.tsx` itself stays: `TournamentsPage.tsx` still imports
 * it, so it is retained (never deleted) and its buider `buildTournamentEntryRows`
 * is reused here rather than duplicated.
 */
export function RecentEvents({ matches }: RecentEventsProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: entries, isLoading } = useTournamentEntries();
  const { range } = useAnalyticsFilter();

  const allEntries = entries ?? [];
  const visibleEntries = filterEntriesByRange(allEntries, range);
  const rows = buildTournamentEntryRows(visibleEntries, matches);

  const empty = (
    <p className="text-sm text-muted-foreground">
      {t('trends.tournaments.resyncPrefix')}{' '}
      <Link to="/settings/integrations" className="font-medium text-primary underline">
        {t('nav.integrations')}
      </Link>{' '}
      {t('trends.tournaments.resyncSuffix')}
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.recentEvents.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('trends.tournaments.loading')}</p>
        ) : allEntries.length === 0 ? (
          empty
        ) : (
          <BoundedList
            cap={LIST_CAP_RAIL}
            rows={rows.map((row) => (
              <RecentEventRow
                key={row.entry.entryKey ?? row.entry.eventId}
                row={row}
                href={subjectPath(`/tournaments/${row.entry.entryKey}`)}
                locale={i18n.language}
              />
            ))}
            labels={{
              showAll: t('analytics.list.showAll', { count: rows.length }),
              showFewer: t('analytics.list.showFewer'),
              showMore: t('analytics.list.showMore50'),
              terminus: t('analytics.list.allTournaments', { count: rows.length }),
            }}
            empty={empty}
            terminusHref={subjectPath('/tournaments')}
          />
        )}
      </CardContent>
    </Card>
  );
}
