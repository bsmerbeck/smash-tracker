import { Link } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getWinLossRecord } from '@/lib/stats';

export interface TournamentSummary {
  tournamentName: string;
  /** Distinct event names within this tournament, in first-seen order. */
  eventNames: string[];
  /** Epoch ms of the earliest and latest match in this tournament. */
  startTime: number;
  endTime: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}

/**
 * Groups matches that have a `tournamentName` set, one summary row per
 * tournament, sorted by most recent (`endTime` descending). Matches missing
 * `tournamentName` are excluded entirely — callers use that to detect the
 * "no tournament names yet" resync-hint state. Exported as a pure builder so
 * the grouping/date-range/sort math is unit-testable without rendering.
 */
export function buildTournamentSummaries(matches: Match[]): TournamentSummary[] {
  const withTournament = matches.filter(
    (m): m is Match & { tournamentName: string } =>
      m.tournamentName != null && m.tournamentName !== '',
  );

  const byTournament = new Map<string, Match[]>();
  for (const match of withTournament) {
    const group = byTournament.get(match.tournamentName);
    if (group) {
      group.push(match);
    } else {
      byTournament.set(match.tournamentName, [match]);
    }
  }

  const summaries: TournamentSummary[] = [...byTournament.entries()].map(([tournamentName, ms]) => {
    const sorted = [...ms].sort((a, b) => a.time - b.time);
    const eventNames: string[] = [];
    for (const m of sorted) {
      if (m.eventName && !eventNames.includes(m.eventName)) {
        eventNames.push(m.eventName);
      }
    }
    const record = getWinLossRecord(ms);
    return {
      tournamentName,
      eventNames,
      startTime: sorted[0]!.time,
      endTime: sorted[sorted.length - 1]!.time,
      ...record,
    };
  });

  return summaries.sort((a, b) => b.endTime - a.endTime);
}

function formatDate(time: number): string {
  return new Date(time).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateRange(summary: TournamentSummary): string {
  const start = formatDate(summary.startTime);
  const end = formatDate(summary.endTime);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * V3 Phase F: per-tournament results, grouped from matches carrying the
 * optional `tournamentName`/`eventName` fields (Phase B sync enrichment).
 * Imported matches synced before that enrichment shipped lack these fields
 * entirely, so when no match has a `tournamentName` this renders a friendly
 * resync hint instead of an empty table.
 */
export function Tournaments({ matches }: { matches: Match[] }) {
  const summaries = buildTournamentSummaries(matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tournaments</CardTitle>
      </CardHeader>
      <CardContent>
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tournament names attach on your next start.gg sync — head to{' '}
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
                <TableHead>Event(s)</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>W-L</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Games</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summaries.map((summary) => (
                <TableRow key={summary.tournamentName}>
                  <TableCell className="font-medium">{summary.tournamentName}</TableCell>
                  <TableCell className="whitespace-normal">
                    {summary.eventNames.length > 0 ? summary.eventNames.join(', ') : '—'}
                  </TableCell>
                  <TableCell>{formatDateRange(summary)}</TableCell>
                  <TableCell>
                    {summary.wins}-{summary.losses}
                  </TableCell>
                  <TableCell>{summary.winRate}%</TableCell>
                  <TableCell>{summary.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
