import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { getWinLossRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';

/** Ports legacy/src/screens/Matchups/components/MatchWinLossCard — record for the specific fighter-vs-opponent matchup. */
export function MatchWinLossCard({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  if (matchupMatches.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{t('matchups.record.empty')}</p>
        </CardContent>
      </Card>
    );
  }

  const { wins, losses, total } = getWinLossRecord(matchupMatches);

  return (
    <Card>
      <CardContent className="flex justify-evenly pt-6">
        <Stat label={t('common.wins')} value={wins} />
        <Stat label={t('matchups.record.totalMatches')} value={total} />
        <Stat label={t('common.losses')} value={losses} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-medium">{value}</span>
    </div>
  );
}
