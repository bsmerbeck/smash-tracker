import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
        <CardTitle>{t('profile.data.title')}</CardTitle>
        <CardDescription>{t('profile.data.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatBox label={t('profile.data.totalMatches')} value={matches.length} />
        <StatBox label={t('profile.data.fromStartgg')} value={startggMatches} />
        <StatBox label={t('profile.data.fromParrygg')} value={parryggMatches} />
        <StatBox label={t('profile.data.manual')} value={manualMatches} />
        <StatBox label={t('profile.data.groupsJoined')} value={groups.length} />
        {reportsEnabled && (
          <StatBox label={t('profile.data.aiReports')} value={pastReports.data?.length ?? 0} />
        )}
      </CardContent>
    </Card>
  );
}
