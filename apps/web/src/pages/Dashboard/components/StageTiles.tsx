import { useTranslation } from 'react-i18next';
import type { Match, Stage } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { stageAbbreviation } from '@/components/StageOption';
import { stagesById, NO_SELECTION_STAGE } from '@/data/stages';
import { getStageRecords, type StageRecord } from '@/lib/stats';

const TOP_STAGE_COUNT = 6;

export interface StageTile {
  stage: Stage;
  record: StageRecord;
}

/**
 * Top stages by usage (account-wide, filtered), most-played first, capped at
 * `TOP_STAGE_COUNT`. Excludes the id-0 "no selection" sentinel — it isn't a
 * real stage to feature. Exported as a pure builder so ordering/capping can
 * be unit-tested without rendering.
 */
export function buildTopStageTiles(matches: Match[]): StageTile[] {
  return getStageRecords(matches)
    .filter((record) => record.stageId !== NO_SELECTION_STAGE.id)
    .map((record) => {
      const stage = stagesById.get(record.stageId);
      return stage ? { stage, record } : null;
    })
    .filter((tile): tile is StageTile => tile != null)
    .sort((a, b) =>
      b.record.total === a.record.total
        ? b.record.winRate - a.record.winRate
        : b.record.total - a.record.total,
    )
    .slice(0, TOP_STAGE_COUNT);
}

/** Most-played stages as art tiles (account-wide, respects the global filter), per docs/analytics-vision.md Phase C. */
export function StageTiles({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const tiles = buildTopStageTiles(matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.stages.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {tiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.stages.empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map(({ stage, record }) => (
              <StageTileCard key={stage.id} stage={stage} record={record} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StageTileCard({ stage, record }: { stage: Stage; record: StageRecord }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border">
      {stage.url ? (
        <img src={stage.url} alt="" className="h-20 w-full object-cover" loading="lazy" />
      ) : (
        <div
          className="flex h-20 w-full items-center justify-center bg-muted text-lg font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {stageAbbreviation(stage.name)}
        </div>
      )}
      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-sm font-medium">{stage.name}</span>
        <span className="text-xs text-muted-foreground">
          {record.wins}-{record.losses} &middot; {record.winRate}% ({record.total})
        </span>
      </div>
    </div>
  );
}
