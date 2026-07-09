import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StageOption } from '@/components/StageOption';
import type { Match } from '@smash-tracker/shared';
import { rankStagesByEvidence, type RankedStage } from '@/lib/stats';
import { stagesById } from '@/data/stages';

/** Stages need at least this many recorded games in the pairing to be surfaced as a recommendation. */
const MIN_GAMES = 2;
const PICK_BAN_COUNT = 3;

/**
 * Stage counterpick advisor for the selected pairing: the top 3
 * evidence-ranked stages ("Pick these") and the bottom 3 ("Ban/avoid
 * these"), each shown with its stage art, record, rate, and sample size.
 * Only stages with at least `MIN_GAMES` recorded matches in this pairing
 * qualify; when there isn't enough qualifying data yet, a hint nudges the
 * user to log more matches instead of showing a misleading recommendation.
 */
export function CounterpickAdvisor({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const ranked = rankStagesByEvidence(matchupMatches, MIN_GAMES);
  const picks = ranked.slice(0, PICK_BAN_COUNT);
  // Bottom N, worst-first: take the tail (never overlapping the picks
  // already claimed above) and reverse it into worst-to-better order.
  const banCount = Math.min(PICK_BAN_COUNT, ranked.length - picks.length);
  const bans = banCount > 0 ? ranked.slice(ranked.length - banCount).reverse() : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchups.counterpick.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ranked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('matchups.counterpick.gather', { count: MIN_GAMES })}
          </p>
        ) : (
          <>
            <StageGroup title={t('matchups.counterpick.pickThese')} tone="emerald" stages={picks} />
            {bans.length > 0 && (
              <StageGroup
                title={t('matchups.counterpick.banThese')}
                tone="destructive"
                stages={bans}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StageGroup({
  title,
  tone,
  stages,
}: {
  title: string;
  tone: 'emerald' | 'destructive';
  stages: RankedStage[];
}) {
  const { t } = useTranslation();
  return (
    <div>
      <h3
        className={`mb-2 text-sm font-medium ${tone === 'emerald' ? 'text-emerald-500' : 'text-destructive'}`}
      >
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {stages.map((stage) => {
          const stageData = stagesById.get(stage.stageId);
          return (
            <li key={stage.stageId} className="flex items-center justify-between gap-2">
              {stageData ? (
                <StageOption stage={stageData} />
              ) : (
                <span className="text-sm">{t('matchups.counterpick.unknownStage')}</span>
              )}
              <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                {stage.wins}-{stage.losses}{' '}
                {t('common.rateOverSample', { rate: stage.winRate, total: stage.total })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
