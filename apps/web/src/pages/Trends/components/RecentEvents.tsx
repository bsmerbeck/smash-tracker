import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { Record } from '@/components/analytics/Record';
import { RecordBar } from '@/components/charts/inlineMarks';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { filterEntriesByRange } from '@/hooks/useFilteredMatches';
import { entryDisplayDateRange } from '@/lib/historicalTournament';
import { formatDate, formatDaySpan } from '@/lib/format';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildTournamentEntryRows, type TournamentEntryRow } from '@/lib/tournamentEntryRows';
import { INLINE_LINK_TONE } from '@/components/analytics/linkTone';

function formatDateRange(entry: TournamentEntryRow['entry'], locale: string): string {
  const range = entryDisplayDateRange(entry);
  if (range == null) {
    return '—';
  }
  return range.startMs === range.endMs
    ? formatDate(range.startMs, locale)
    : formatDaySpan(range.startMs, range.endMs, locale);
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
  /** The page's range-filtered matches — the default record cells. */
  matches: Match[];
  /** Plan 41-04 (B3): ALL own-account matches — the "All time" list's record cells, so an out-of-range row is never shown as 0-0. */
  allMatches: Match[];
}

/**
 * The left rail's second card (UI-SPEC §8.2 Row 3, replaces the six-column
 * `Tournaments` table on Trends — it clipped its W-L column in a half-width
 * slot). Plan 39.2-07 (F8) moved its row builder `buildTournamentEntryRows` to
 * `@/lib/tournamentEntryRows`, shared with the Tournaments page.
 *
 * Plan 41-04 (B3, DD-41-10): follows the global range by default. When the range hides entries it
 * offers a one-click, card-scoped "All time" override — in-memory state only, never persisted and
 * never written to the global range, so every other card keeps following the range.
 */
export function RecentEvents({ matches, allMatches }: RecentEventsProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: entries, isLoading } = useTournamentEntries();
  const { range } = useAnalyticsFilter();

  const [showAllTime, setShowAllTime] = useState(false);

  const allEntries = entries ?? [];
  const visibleEntries = filterEntriesByRange(allEntries, range);
  const hiddenCount = allEntries.length - visibleEntries.length;
  // The control only exists while the range hides something (E9); a stale toggle with nothing hidden is inert.
  const hasHidden = range !== 'all' && hiddenCount > 0;
  const allTimeActive = showAllTime && hasHidden;
  const rows = allTimeActive
    ? buildTournamentEntryRows(allEntries, allMatches)
    : buildTournamentEntryRows(visibleEntries, matches);

  const empty = (
    <p className="text-sm text-muted-foreground">
      {t('trends.tournaments.resyncPrefix')}{' '}
      <Link to="/settings/integrations" className={`font-medium ${INLINE_LINK_TONE}`}>
        {t('nav.integrations')}
      </Link>{' '}
      {t('trends.tournaments.resyncSuffix')}
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.recentEvents.title')}</CardTitle>
        {hasHidden && (
          <>
            <CardAction>
              <Button
                type="button"
                variant="link"
                size="sm"
                className={INLINE_LINK_TONE}
                aria-pressed={allTimeActive}
                onClick={() => setShowAllTime((on) => !on)}
              >
                {allTimeActive
                  ? t('trends.recentEvents.backToRange')
                  : t('trends.recentEvents.allTime')}
              </Button>
            </CardAction>
            <CardDescription className="text-xs" data-slot="recent-events-range-note">
              {allTimeActive
                ? t('trends.recentEvents.allTimeNote')
                : t('trends.recentEvents.outsideRange', { count: hiddenCount })}
            </CardDescription>
          </>
        )}
      </CardHeader>
      {/* Plan 41-09 (SC4): the content root is the text-fit oracle's target (the `Card` keeps `data-slot="card"`). */}
      <CardContent data-slot="recent-events">
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
