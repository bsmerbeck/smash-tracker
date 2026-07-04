import { useMemo } from 'react';
import { useParams, Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useMatches } from '@/hooks/useMatches';
import { TournamentHeader } from './components/TournamentHeader';
import { EventResults } from './components/EventResults';
import { SetTimeline } from './components/SetTimeline';
import { CharactersAndStages } from './components/CharactersAndStages';
import { AdvisorRetrospective } from './components/AdvisorRetrospective';
import { matchesForEntry } from './lib/matchesForEntry';
import { buildSetTimeline } from './lib/setTimeline';
import { buildRetrospective } from './lib/retrospective';

function NotFoundState() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Tournament not found</h1>
      <p className="max-w-md text-muted-foreground">
        We couldn&apos;t find a tournament entry for that link. It may have been synced under a
        different account, or you followed a stale link.
      </p>
      <Button asChild className="mt-2">
        <Link to="/trends">Back to Trends</Link>
      </Button>
    </div>
  );
}

/**
 * V4 Phase B / V5 Phase B: tournament detail page — header (with
 * seed->placement badge + start.gg deep link), Event Results (top-8
 * standings), set-by-set timeline, characters/stages summary, and the
 * Advisor Retrospective. Reached by clicking a tournament row in Trends, or
 * by direct URL (`/tournaments/:eventId`); an unknown/foreign eventId
 * renders a friendly not-found state rather than crashing on a missing
 * entry.
 */
export function TournamentDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { data: entries, isLoading: entriesLoading } = useTournamentEntries();
  const { data: allMatches = [], isLoading: matchesLoading } = useMatches();

  const entry = useMemo(() => {
    if (!entries || !eventId) {
      return undefined;
    }
    const parsedId = Number(eventId);
    return entries.find((e) => e.eventId === parsedId);
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
    return <div className="text-muted-foreground">Loading tournament...</div>;
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
