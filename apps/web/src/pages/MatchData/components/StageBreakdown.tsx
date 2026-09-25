import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { Record } from '@/components/analytics/Record';
import { RecordBar } from '@/components/charts/inlineMarks';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getStageById } from '@/data/stages';
import { getStageRecords, type StageRecord } from '@/lib/stats';
import { stageAbbreviation } from '@/components/StageOption';

const STAGE_THUMB_WIDTH_PX = 32;
const STAGE_THUMB_HEIGHT_PX = 20;

/**
 * One stage row (UI-SPEC §8.4): a 32x20 stage thumbnail, the localised
 * stage name in the row's one flexible truncating slot, a `Record` and a
 * `RecordBar`, navigating to Phase 38's `/stages/:stageId` route. Wraps in
 * `DrillableRow` (`as="overlay"`), matching `PairingOpponents.tsx`'s
 * established multi-segment-row pattern.
 */
function StageRow({
  record,
  t,
  subjectPath,
}: {
  record: StageRecord;
  t: ReturnType<typeof useTranslation>['t'];
  subjectPath: (path: string) => string;
}) {
  const stage = getStageById(record.stageId);
  const name = stage?.name ?? t('common.unknown');
  const to = subjectPath(`/stages/${record.stageId}`);
  const recordText = `${record.wins}–${record.losses}`;

  return (
    <li
      className="relative flex items-center gap-3 rounded-md p-2 hover:bg-accent"
      data-slot="stage-row"
    >
      <DrillableRow
        as="overlay"
        to={to}
        ariaLabel={t('shared.drillableRow.aria', { subject: name, context: recordText })}
      />
      {stage?.url ? (
        <img
          src={stage.url}
          alt=""
          className="shrink-0 rounded object-cover"
          style={{ width: STAGE_THUMB_WIDTH_PX, height: STAGE_THUMB_HEIGHT_PX }}
        />
      ) : (
        <span
          className="flex shrink-0 items-center justify-center rounded bg-muted text-[9px] font-semibold text-muted-foreground"
          style={{ width: STAGE_THUMB_WIDTH_PX, height: STAGE_THUMB_HEIGHT_PX }}
          aria-hidden="true"
        >
          {stageAbbreviation(name)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={name} data-truncate-guard>
        {name}
      </span>
      <span className="shrink-0">
        <RecordBar wins={record.wins} losses={record.losses} />
      </span>
      <Record wins={record.wins} losses={record.losses} cue="none" />
      <DrillableRowChevron />
    </li>
  );
}

/**
 * The Match Data stage card (UIX-02/UIX-04, UI-SPEC §8.4, owner note 7):
 * a stage-first `BoundedList` ordered by games (`getStageRecords`), each row
 * navigating to the stage detail route. The old centred stage-art header and
 * the colliding flex-distribution stat row are gone — replaced by a
 * `StatRow` headlining the most-played stage's rate/wins/losses (the same
 * three figures the deleted local `Stat` used, same `common.*` keys, now on
 * a gapped grid that cannot collide) — and the per-fighter split no longer
 * renders here; it lives on the stage detail route (Phase 38).
 */
export function StageBreakdown({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();

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

  const records = [...getStageRecords(matches)].sort(
    (a, b) => b.total - a.total || a.stageId - b.stageId,
  );
  const top = records[0]!;

  const rows = records.map((record) => (
    <StageRow key={record.stageId} record={record} t={t} subjectPath={subjectPath} />
  ));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchData.stages.title')}</CardTitle>
        <CardDescription>{t('analytics.list.sortMostGames')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <StatRow
          figures={[
            <StatFigure key="rate" label={t('common.rate')} value={`${top.winRate}%`} />,
            <StatFigure key="wins" label={t('common.wins')} value={top.wins} />,
            <StatFigure key="losses" label={t('common.losses')} value={top.losses} />,
          ]}
        />
        <BoundedList
          cap={LIST_CAP}
          rows={rows}
          labels={{
            showAll: t('analytics.list.showAll', { count: records.length }),
            showFewer: t('analytics.list.showFewer'),
            showMore: t('analytics.list.showMore50'),
            terminus: t('analytics.list.allStages', { count: records.length }),
          }}
          empty={<p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>}
        />
      </CardContent>
    </Card>
  );
}
