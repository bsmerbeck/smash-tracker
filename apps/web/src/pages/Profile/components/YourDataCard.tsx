import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMatches } from '@/hooks/useMatches';
import { useGroups } from '@/hooks/useGroups';
import { useReportsConfig, useScoutReportsList } from '@/hooks/useScoutReports';

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Profile > Your data: read-only counts across the app's data sources.
 * Match source breakdown mirrors `matchRecordSchema.source` — undefined
 * means manually entered (all legacy data + hand-added matches), 'startgg'
 * / 'parrygg' mean server-synced imports. AI reports count is only shown
 * when reports are enabled, matching how the rest of the app hides that
 * feature entirely when it's off.
 */
export function YourDataCard() {
  const { data: matches = [] } = useMatches();
  const { data: groups = [] } = useGroups();
  const reportsConfig = useReportsConfig();
  const reportsEnabled = reportsConfig.data?.enabled ?? false;
  const pastReports = useScoutReportsList();

  const startggMatches = matches.filter((m) => m.source === 'startgg').length;
  const parryggMatches = matches.filter((m) => m.source === 'parrygg').length;
  const manualMatches = matches.length - startggMatches - parryggMatches;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>What smash-tracker has on file for you.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatBox label="Total matches" value={matches.length} />
        <StatBox label="From start.gg" value={startggMatches} />
        <StatBox label="From parry.gg" value={parryggMatches} />
        <StatBox label="Manually entered" value={manualMatches} />
        <StatBox label="Groups joined" value={groups.length} />
        {reportsEnabled && (
          <StatBox label="AI reports generated" value={pastReports.data?.length ?? 0} />
        )}
      </CardContent>
    </Card>
  );
}
