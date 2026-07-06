import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { ScoutReportData, ScoutReportRecord } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { useScoutPlayer } from '@/hooks/useScoutPlayer';
import { useMatches } from '@/hooks/useMatches';
import { useGenerateReport, useReportsConfig, useScoutReportsList } from '@/hooks/useScoutReports';
import { getOpponentProfile } from '@/lib/stats';
import { Button } from '@/components/ui/button';
import { ScoutSearchForm } from './components/ScoutSearchForm';
import { ScoutReportHeader } from './components/ScoutReportHeader';
import { ScoutCharactersCard } from './components/ScoutCharactersCard';
import { ScoutStagesCard } from './components/ScoutStagesCard';
import { ScoutRecentEventsCard } from './components/ScoutRecentEventsCard';
import { ScoutCommonOpponentsCard } from './components/ScoutCommonOpponentsCard';
import { YourHistoryStrip } from './components/YourHistoryStrip';
import { ScoutAiReportCard } from './components/ScoutAiReportCard';
import { ScoutPastReportsCard } from './components/ScoutPastReportsCard';

function describeError(error: unknown, fallback: string): string {
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
    return error.message || fallback;
  }
  return fallback;
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
 *
 * V7-B: when AI reports are enabled for the signed-in user
 * (`useReportsConfig`), a "Generate AI report" button appears once a scout
 * result is on screen. The feature is completely invisible when disabled —
 * no button, no past-reports card, nothing rendered at all.
 *
 * V7-B.1: reports are stored server-side, so a refresh or a fresh scout no
 * longer loses them. Once a scout result is on screen, the stored reports
 * list (`useScoutReportsList`) is checked for a report matching this exact
 * scouted player (by start.gg player id — the stable identity field on
 * `scoutPlayerIdentitySchema`); if one exists, its most recent report renders
 * automatically with no click needed, and the generate button becomes
 * "Regenerate report". The past-reports card excludes this player's own
 * reports (they're already shown above) and only lists OTHER players'.
 */
export function ScoutPage() {
  const scout = useScoutPlayer();
  const { data: matches = [] } = useMatches();
  const reportsConfig = useReportsConfig();
  const generateReport = useGenerateReport();
  const pastReports = useScoutReportsList();

  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<ScoutReportRecord | null>(null);

  const report: ScoutReportData | undefined = scout.data;
  const aiReportsEnabled = reportsConfig.data?.enabled ?? false;

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

  // The most recent stored report for the CURRENTLY scouted player, if any —
  // matched by start.gg player id (stable across re-scouts, unlike gamerTag
  // which can change). Newest-first is already guaranteed by GET /api/reports.
  const storedRecordForCurrentPlayer = useMemo(() => {
    if (!report) {
      return null;
    }
    return pastReports.data?.find((record) => record.player.id === report.player.id) ?? null;
  }, [pastReports.data, report]);

  const handleSubmit = (query: string) => {
    setSelectedRecord(null);
    generateReport.reset();
    setLastQuery(query);
    scout.mutate(query);
  };

  const handleGenerateReport = () => {
    if (!lastQuery) {
      return;
    }
    setSelectedRecord(null);
    generateReport.mutate(lastQuery);
  };

  // The record to actually render: a freshly generated report takes priority
  // over a previously-selected past report (a new generation replaces what's
  // on screen), which in turn takes priority over the stored report already
  // on file for this exact player (V7-B.1 persistence), which in turn takes
  // priority over nothing.
  const displayedRecord =
    generateReport.data ?? selectedRecord ?? storedRecordForCurrentPlayer ?? null;

  // Other players' past reports — this player's own reports are already
  // shown automatically above, so they're excluded here to avoid duplication.
  const otherPastReports = (pastReports.data ?? []).filter(
    (record) => record.player.id !== report?.player.id,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scout a Player</h1>

      <ScoutSearchForm onSubmit={handleSubmit} isPending={scout.isPending} />

      {scout.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {describeError(scout.error, 'Something went wrong while scouting that player.')}
        </div>
      )}

      {report && (
        <div className="flex flex-col gap-4">
          <ScoutReportHeader report={report} />
          {yourHistory && <YourHistoryStrip profile={yourHistory} />}

          {aiReportsEnabled && (
            <div className="flex flex-col gap-2">
              <Button
                onClick={handleGenerateReport}
                disabled={generateReport.isPending}
                className="w-fit"
              >
                <Sparkles className={generateReport.isPending ? 'animate-spin' : ''} />
                {generateReport.isPending
                  ? 'Generating report…'
                  : displayedRecord
                    ? 'Regenerate report'
                    : 'Generate AI report'}
              </Button>
              {generateReport.isPending && (
                <p className="text-sm text-muted-foreground">
                  Generating report — this usually takes a minute or two.
                </p>
              )}
              {generateReport.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {describeError(
                    generateReport.error,
                    'Something went wrong while generating the report.',
                  )}
                </div>
              )}
            </div>
          )}

          {displayedRecord && <ScoutAiReportCard record={displayedRecord} />}

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

      {aiReportsEnabled && otherPastReports.length > 0 && (
        <ScoutPastReportsCard
          reports={otherPastReports}
          onSelect={(record) => setSelectedRecord(record)}
        />
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
