import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { getRecordsByFighter, getStageRecords, type FighterRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';
import { useFighterName } from '@/hooks/useFighterName';

function FighterRow({ record }: { record: FighterRecord }) {
  const { t } = useTranslation();
  const sprite = getFighterById(record.fighterId);
  const localizedName = useFighterName(record.fighterId);
  return (
    <li className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {sprite && <img src={sprite.url} alt="" className="size-7 object-contain" />}
        <span className="text-sm">{sprite ? localizedName : t('common.unknown')}</span>
      </div>
      <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
        {record.wins}-{record.losses} · {t('common.games', { count: record.total })}
      </span>
    </li>
  );
}

function FighterCard({
  title,
  matches,
  keyFn,
}: {
  title: string;
  matches: Match[];
  keyFn?: (match: Match) => number;
}) {
  const { t } = useTranslation();
  const records = getRecordsByFighter(matches, keyFn).sort((a, b) => b.total - a.total);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tournaments.charStages.noGames')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((record) => (
              <FighterRow key={record.fighterId} record={record} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StagesCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const records = getStageRecords(matches)
    .filter((r) => r.stageId !== 0)
    .sort((a, b) => b.total - a.total);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('tournaments.charStages.stagesPlayed')}</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tournaments.charStages.noStageData')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((record) => {
              const stage = stagesById.get(record.stageId);
              return (
                <li key={record.stageId} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {stage?.url ? (
                      <img src={stage.url} alt="" className="h-8 w-14 rounded object-cover" />
                    ) : (
                      <span className="flex h-8 w-14 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                        {stage ? stage.name.slice(0, 3).toUpperCase() : '??'}
                      </span>
                    )}
                    <span className="text-sm">{stage?.name ?? t('common.unknown')}</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                    {record.wins}-{record.losses} · {t('common.games', { count: record.total })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Three compact cards summarizing the entry's matches: your characters
 * played (with per-character W-L), the opponents' characters faced, and
 * stages played — all derived from the same entry-scoped match list.
 */
export function CharactersAndStages({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <FighterCard title={t('tournaments.charStages.yourCharacters')} matches={matches} />
      <FighterCard
        title={t('tournaments.charStages.opponentsCharacters')}
        matches={matches}
        keyFn={(m) => m.opponent_id}
      />
      <StagesCard matches={matches} />
    </div>
  );
}
