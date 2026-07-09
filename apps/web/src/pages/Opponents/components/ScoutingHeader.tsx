import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WinLossPips } from '@/components/WinLossPips';
import type { OpponentProfile } from '@/lib/stats';
import type { OpponentSource } from '@/hooks/useFilteredMatches';
import type { EncounterContext } from '../tournamentHistory';
import { OpponentSourceBadge } from './OpponentSourceBadge';

function formatEncounterContext(
  context: EncounterContext,
  t: TFunction,
  locale: string,
): string | null {
  if (context.tournamentCount === 0 || !context.span) {
    return null;
  }
  const count = context.tournamentCount;
  const start = new Date(context.span.start).toLocaleDateString(locale, {
    month: 'short',
    year: 'numeric',
  });
  const end = new Date(context.span.end).toLocaleDateString(locale, {
    month: 'short',
    year: 'numeric',
  });
  const span = start === end ? start : t('opponents.header.encounterSpan', { start, end });
  return t('opponents.header.metAt', { count, span });
}

/**
 * Scouting report header: opponent tag, overall H2H record + rate + sample
 * size, first/last played dates, last-10 form pips vs this opponent, and (when
 * tournament-tagged encounters exist) an encounter context line summarizing
 * how many tournaments and over what date span you've met them.
 */
export function ScoutingHeader({
  profile,
  encounterContext,
  source,
}: {
  profile: OpponentProfile;
  encounterContext: EncounterContext;
  source: OpponentSource;
}) {
  const { t, i18n } = useTranslation();
  const { record } = profile;
  const encounterLine = formatEncounterContext(encounterContext, t, i18n.language);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-2xl">{profile.opponent}</CardTitle>
            <OpponentSourceBadge source={source} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('opponents.header.playedRange', {
              first: new Date(profile.firstPlayedAt).toLocaleDateString(i18n.language),
              last: new Date(profile.lastPlayedAt).toLocaleDateString(i18n.language),
            })}
          </p>
          {encounterLine && <p className="mt-1 text-sm text-muted-foreground">{encounterLine}</p>}
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold">
            {record.wins}-{record.losses}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('opponents.header.rateOverGames', { rate: record.winRate, count: record.total })}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          {t('fighterAnalysis.hero.last10')}
        </h3>
        <WinLossPips matches={profile.recent} limit={10} />
      </CardContent>
    </Card>
  );
}
