import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { getOpponentProfile, getOpponentRecords } from '@/lib/stats';
import { OpponentList } from './components/OpponentList';
import { ScoutingHeader } from './components/ScoutingHeader';
import { WhatTheyPlayTable } from './components/WhatTheyPlayTable';
import { ScoutingStagesCard } from './components/ScoutingStagesCard';
import { ScoutingTrendChart } from './components/ScoutingTrendChart';
import { RecentEncounters } from './components/RecentEncounters';
import { TournamentHistory } from './components/TournamentHistory';
import { groupTournamentBlocks, getEncounterContext } from './tournamentHistory';

/**
 * Phase E (docs/analytics-vision.md): scouting reports per human opponent —
 * H2H record + timeline, what they play against you, stages they take you
 * to, and recent encounters. Searchable list ranked by games played.
 */
export function OpponentsPage() {
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();
  const { data: tournamentEntries } = useTournamentEntries();

  const opponentRecords = useMemo(() => getOpponentRecords(matches), [matches]);

  const mostPlayed = useMemo(() => {
    return [...opponentRecords].sort((a, b) => b.total - a.total)[0]?.opponent ?? null;
  }, [opponentRecords]);

  // Tracks an explicit user selection only; when unset, or when the previous
  // selection has dropped out of the filtered set (e.g. the global
  // source/time filter changed), the most-played opponent is used instead —
  // derived during render like Dashboard's fighter selection, no effect
  // needed to seed state from data that just loaded.
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(null);

  const selected =
    selectedOpponent && opponentRecords.some((o) => o.opponent === selectedOpponent)
      ? selectedOpponent
      : mostPlayed;

  const profile = useMemo(() => {
    if (!selected) {
      return null;
    }
    return getOpponentProfile(matches, selected);
  }, [matches, selected]);

  const opponentMatches = useMemo(
    () => (profile ? matches.filter((m) => m.opponent === profile.opponent) : []),
    [matches, profile],
  );

  const tournamentBlocks = useMemo(() => groupTournamentBlocks(opponentMatches), [opponentMatches]);

  const encounterContext = useMemo(() => getEncounterContext(tournamentBlocks), [tournamentBlocks]);

  if (isLoading) {
    return <div className="text-muted-foreground">Loading scouting reports...</div>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">No matches to scout yet!</h1>
        <p className="max-w-md text-muted-foreground">
          Report a match on the Dashboard, or connect start.gg to sync your tournament sets, and
          opponent scouting reports will show up here.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/dashboard">Go to Dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/settings/integrations">Connect start.gg</Link>
          </Button>
        </div>
      </div>
    );
  }

  const allOpponentsNamed = getOpponentRecords(allMatches);
  if (allOpponentsNamed.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          None of your matches have an opponent tag recorded.
        </h2>
        <p className="max-w-md text-muted-foreground">
          Add an opponent name when reporting a match to unlock scouting reports for them.
        </p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">Go to Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <OpponentList matches={matches} selected={selected} onSelect={setSelectedOpponent} />

        {profile ? (
          <div key={profile.opponent} className="flex flex-col gap-4">
            <ScoutingHeader profile={profile} encounterContext={encounterContext} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <WhatTheyPlayTable byTheirFighter={profile.byTheirFighter} />
              <ScoutingStagesCard byStage={profile.byStage} />
            </div>
            <ScoutingTrendChart matches={opponentMatches} />
            <RecentEncounters matches={profile.recent} />
            <TournamentHistory
              blocks={tournamentBlocks}
              tournamentEntries={tournamentEntries ?? []}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
            Select an opponent from the list to see their scouting report.
          </div>
        )}
      </div>
    </div>
  );
}
