import { useMemo } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { matchesForEntry, buildSetTimeline } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useMatches } from '@/hooks/useMatches';
import { TournamentHeader } from './components/TournamentHeader';
import { EventResults } from './components/EventResults';
import { SetTimeline } from './components/SetTimeline';
import { CharactersAndStages } from './components/CharactersAndStages';
import { AdvisorRetrospective } from './components/AdvisorRetrospective';
import { buildRetrospective } from './lib/retrospective';

function NotFoundState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t('tournaments.notFound.title')}</h1>
      <p className="max-w-md text-muted-foreground">{t('tournaments.notFound.body')}</p>
      <Button asChild className="mt-2">
        <Link to="/trends">{t('tournaments.notFound.back')}</Link>
      </Button>
    </div>
  );
}

/**
 * V4 Phase B / V5 Phase B: tournament detail page — header (with
 * seed->placement badge + start.gg deep link), Event Results (top-8
 * standings), set-by-set timeline, characters/stages summary, and the
 * Advisor Retrospective. Reached by clicking a tournament row in Trends, or
 * by direct URL (`/tournaments/:eventId`); an unknown/foreign entryKey
 * renders a friendly not-found state rather than crashing on a missing
 * entry.
 *
 * Phase 7: the route's `:eventId` path segment now carries the
 * source-agnostic `entryKey` (the URL param label is unchanged to avoid
 * touching the route table, but its value is looked up against
 * `entry.entryKey`, never a parsed numeric start.gg `eventId` — parry.gg
 * entries have no numeric id at all). `GET /api/tournaments` always fills
 * `entryKey` from the RTDB child key on read, so every entry the page can
 * see carries one. start.gg-only affordances (the "View on start.gg" link,
 * the Event Results standings table) already gate on the presence of
 * `slug`/`eventSlug`/`topStandings` rather than on `source` directly, so a
 * parry.gg entry (which never has those fields) renders its available data
 * gracefully with no code change needed in the child components.
 */
export function TournamentDetailPage() {
  const { t } = useTranslation();
  const { eventId } = useParams<{ eventId: string }>();
  const { data: entries, isLoading: entriesLoading } = useTournamentEntries();
  const { data: allMatches = [], isLoading: matchesLoading } = useMatches();

  const entry = useMemo(() => {
    if (!entries || !eventId) {
      return undefined;
    }
    return entries.find((e) => e.entryKey === eventId);
  }, [entries, eventId]);

  const entryMatches = useMemo(() => {
    if (!entry) {
      return [];
    }
    return matchesForEntry(allMatches, entry);
  }, [allMatches, entry]);

  const timeline = useMemo(() => buildSetTimeline(entryMatches), [entryMatches]);

  const retrospective = useMemo(() => {
    if (!entry) {
      return null;
    }
    return buildRetrospective(allMatches, entryMatches, entry);
  }, [allMatches, entryMatches, entry]);

  if (entriesLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('tournaments.loading')}</div>;
  }

  if (!entry) {
    return <NotFoundState />;
  }

  return (
    <div className="flex flex-col gap-6">
      <TournamentHeader entry={entry} />
      <EventResults entry={entry} entryMatches={entryMatches} />
      <SetTimeline sets={timeline.sets} otherMatches={timeline.otherMatches} />
      <CharactersAndStages matches={entryMatches} />
      {retrospective && <AdvisorRetrospective retrospective={retrospective} />}
    </div>
  );
}
