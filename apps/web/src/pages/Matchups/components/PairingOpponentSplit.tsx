import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Match } from '@smash-tracker/shared';
import { getOpponentRecords } from '@/lib/stats';

const TOP_N = 5;

/**
 * Per-human-opponent split for the selected pairing: which real people you
 * actually play in this fighter-vs-fighter matchup, and your record against
 * each — top 5 by games played.
 */
export function PairingOpponentSplit({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const records = getOpponentRecords(matchupMatches)
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_N);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchups.opponentSplit.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('matchups.opponentSplit.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {records.map((record) => (
              <li key={record.opponent} className="flex items-center justify-between gap-2">
                <span className="truncate capitalize">{record.opponent}</span>
                <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                  {record.wins}-{record.losses} ({record.winRate}%)
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
