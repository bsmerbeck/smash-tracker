import { useMemo } from 'react';
import type { ScoutReportData } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { useScoutPlayer } from '@/hooks/useScoutPlayer';
import { useMatches } from '@/hooks/useMatches';
import { getOpponentProfile } from '@/lib/stats';
import { ScoutSearchForm } from './components/ScoutSearchForm';
import { ScoutReportHeader } from './components/ScoutReportHeader';
import { ScoutCharactersCard } from './components/ScoutCharactersCard';
import { ScoutStagesCard } from './components/ScoutStagesCard';
import { ScoutRecentEventsCard } from './components/ScoutRecentEventsCard';
import { ScoutCommonOpponentsCard } from './components/ScoutCommonOpponentsCard';
import { YourHistoryStrip } from './components/YourHistoryStrip';

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "We couldn't find a start.gg player for that query. Double-check the URL, slug, or player id.";
    }
    if (error.status === 400) {
      return error.message || "That doesn't look like a start.gg profile URL, slug, or player id.";
    }
    if (error.status === 429) {
      return 'start.gg is rate-limiting requests right now. Try again in a minute.';
    }
    return error.message || 'Something went wrong while scouting that player.';
  }
  return 'Something went wrong while scouting that player.';
}

/**
 * `/scout` — "opponent research before bracket": scout ANY start.gg player
 * (not just linked accounts) by pasting their profile URL, slug, or numeric
 * player id. The API resolves the identity and aggregates their public SSBU
 * set history server-side into a `ScoutReportData` (see
 * apps/api/src/startgg/scout.ts); this page just renders it.
 *
 * When the scouted gamer tag matches an opponent already in the caller's own
 * match history, a "Your History vs Them" strip surfaces the existing
 * head-to-head record (same data the Scouting page shows) above the public
 * report.
 */
export function ScoutPage() {
  const scout = useScoutPlayer();
  const { data: matches = [] } = useMatches();

  const report: ScoutReportData | undefined = scout.data;

  const yourHistory = useMemo(() => {
    if (!report) {
      return null;
    }
    const needle = report.player.gamerTag.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    return getOpponentProfile(matches, needle);
  }, [matches, report]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scout a Player</h1>

      <ScoutSearchForm onSubmit={(query) => scout.mutate(query)} isPending={scout.isPending} />

      {scout.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {describeError(scout.error)}
        </div>
      )}

      {report && (
        <div className="flex flex-col gap-4">
          <ScoutReportHeader report={report} />
          {yourHistory && <YourHistoryStrip profile={yourHistory} />}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ScoutCharactersCard characters={report.characters} />
            <ScoutStagesCard stages={report.stages} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ScoutRecentEventsCard events={report.recentEvents} />
            <ScoutCommonOpponentsCard opponents={report.commonOpponents} />
          </div>
        </div>
      )}

      {!report && !scout.isError && !scout.isPending && (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
          Paste a start.gg profile URL, slug, or player id above to pull up their public tournament
          history.
        </div>
      )}
    </div>
  );
}
