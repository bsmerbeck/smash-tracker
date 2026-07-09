import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { getFighterById } from '@/data/sprites';
import { getStageRecords, getWinLossRecord } from '@/lib/stats';
import { getGroupedStageOptions, stageOptions } from '@/lib/stageOptions';
import { stageAbbreviation } from '@/components/StageOption';
import { StageSelectGroups, StageSelectValue } from '@/components/StageSelectGroups';

/**
 * Ports legacy/src/screens/MatchData/components/StageBreakdown — pick a
 * stage, see the overall record for it (via `getStageRecords`) plus a
 * per-fighter breakdown for matches played on that stage.
 */
export function StageBreakdown({
  matches,
  usageMatches,
  favoriteStageIds,
  onToggleFavorite,
}: {
  matches: Match[];
  /** Unfiltered matches used to compute "Most played" ordering; defaults to `matches` when omitted. */
  usageMatches?: Match[];
  /** The user's favorited stage ids, pinned as a "Favorites" group. Passed in as a prop (rather than read via `useStageFavorites` here) to keep this component hook/provider-free for tests. */
  favoriteStageIds?: number[];
  /** Heart-button toggle for the picker rows (see `StageSelectGroups`); a prop for the same provider-free reason as `favoriteStageIds`. */
  onToggleFavorite?: (stageId: number) => void;
}) {
  const { t } = useTranslation();
  const [stageId, setStageId] = useState<number>(NO_SELECTION_STAGE.id);
  const stageGroups = useMemo(
    () => getGroupedStageOptions(usageMatches ?? matches, favoriteStageIds),
    [usageMatches, matches, favoriteStageIds],
  );

  if (matches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('matchData.stages.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        </CardContent>
      </Card>
    );
  }

  const selectedStage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
  const stageRecords = getStageRecords(matches);
  const record = stageRecords.find((r) => r.stageId === stageId);

  const stageMatches = matches.filter((m) => (m.map?.id ?? 0) === stageId);
  const fighterIds = [...new Set(stageMatches.map((m) => m.fighter_id))];
  const fighterStats = fighterIds
    .map((fid) => {
      const fighter = getFighterById(fid);
      if (!fighter) return null;
      const fighterMatches = stageMatches.filter((m) => m.fighter_id === fid);
      return { fighter, ...getWinLossRecord(fighterMatches) };
    })
    .filter((f): f is NonNullable<typeof f> => f != null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchData.stages.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Select value={String(stageId)} onValueChange={(v) => setStageId(Number(v))}>
          <SelectTrigger className="w-full max-w-xs" aria-label={t('matchData.stages.selectAria')}>
            <StageSelectValue stageId={stageId} />
          </SelectTrigger>
          <SelectContent>
            <StageSelectGroups groups={stageGroups} onToggleFavorite={onToggleFavorite} />
          </SelectContent>
        </Select>

        <div className="flex flex-col items-center gap-2 text-center">
          {selectedStage.id !== NO_SELECTION_STAGE.id &&
            ('url' in selectedStage && selectedStage.url ? (
              <img
                src={selectedStage.url}
                alt=""
                className="h-20 w-36 rounded-md object-cover"
                loading="lazy"
              />
            ) : (
              <span
                className="flex h-20 w-36 items-center justify-center rounded-md bg-muted text-sm font-semibold text-muted-foreground"
                aria-hidden="true"
              >
                {stageAbbreviation(selectedStage.name)}
              </span>
            ))}
          <h3 className="text-lg font-medium">{selectedStage.name}</h3>
          {!record || record.total === 0 ? (
            <p className="text-sm text-muted-foreground">{t('matchData.stages.noneOnStage')}</p>
          ) : (
            <div className="flex justify-evenly pt-2">
              <Stat label={t('common.rate')} value={`${record.winRate}%`} />
              <Stat label={t('common.wins')} value={record.wins} />
              <Stat label={t('common.losses')} value={record.losses} />
            </div>
          )}
        </div>

        {fighterStats.length > 0 && (
          <ul className="flex flex-col gap-2">
            {fighterStats.map(({ fighter, wins, losses, winRate }) => (
              <li key={fighter.id} className="flex items-center gap-3 rounded-md border p-2">
                <img src={fighter.url} alt="" className="size-8 object-contain" />
                <span className="flex-1 font-medium">{fighter.name}</span>
                <div className="flex gap-4 text-sm text-muted-foreground">
                  <span>{winRate}%</span>
                  <span>{t('matchData.stages.winsShort', { count: wins })}</span>
                  <span>{t('matchData.stages.lossesShort', { count: losses })}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
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
