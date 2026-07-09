import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match } from '@smash-tracker/shared';
import { getBestWorstStages, getMatchTypeRecords, getStreakSummary } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { WinLossPips } from '@/components/WinLossPips';

const THRESHOLD_OPTIONS = [1, 2, 3, 5];

/**
 * v2 analytics for the selected matchup: current/best/worst streaks, recent
 * form, the best and worst stage to take this matchup to (threshold-based),
 * and the record split by match type.
 */
export function MatchupInsights({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(3);

  const streaks = getStreakSummary(matchupMatches);
  const { best, worst } = getBestWorstStages(matchupMatches, threshold);
  const typeRecords = getMatchTypeRecords(matchupMatches);

  const bestName = best ? (stagesById.get(best.stageId)?.name ?? t('common.unknown')) : null;
  const worstName = worst ? (stagesById.get(worst.stageId)?.name ?? t('common.unknown')) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('matchups.insights.title')}</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('matchups.insights.minMatches')}</span>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger className="w-[72px]" aria-label={t('matchups.insights.minMatchesAria')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {matchupMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('matchups.insights.empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.currentStreak')}
                </h3>
                <p
                  className={`text-lg font-semibold ${streaks.currentStreakIsWin ? 'text-emerald-500' : 'text-destructive'}`}
                >
                  {streaks.currentStreakIsWin
                    ? t('matchups.insights.streakWins', { count: streaks.currentStreak })
                    : t('matchups.insights.streakLosses', { count: streaks.currentStreak })}
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.longestWin')}
                </h3>
                <p className="text-lg font-semibold">{streaks.bestWinStreak}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.longestLoss')}
                </h3>
                <p className="text-lg font-semibold">{streaks.worstLossStreak}</p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                {t('matchups.insights.recentForm')}
              </h3>
              <WinLossPips matches={matchupMatches} limit={10} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium text-emerald-500">
                  {t('matchups.insights.bestStage')}
                </h3>
                <p className="text-sm">
                  {bestName ? (
                    <>
                      {bestName}{' '}
                      <span className="text-muted-foreground">
                        {t('common.rateOverSample', { rate: best?.winRate, total: best?.total })}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('matchups.insights.notEnoughStageData')}
                    </span>
                  )}
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-destructive">
                  {t('matchups.insights.worstStage')}
                </h3>
                <p className="text-sm">
                  {worstName ? (
                    <>
                      {worstName}{' '}
                      <span className="text-muted-foreground">
                        {t('common.rateOverSample', { rate: worst?.winRate, total: worst?.total })}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('matchups.insights.notEnoughStageData')}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {typeRecords.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.byMatchType')}
                </h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {typeRecords.map((record) => (
                    <li key={record.matchType} className="flex justify-between">
                      <span>{record.matchType}</span>
                      <span className="text-muted-foreground">
                        {record.wins}-{record.losses} ({record.winRate}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
