import { useTranslation } from 'react-i18next';
import { UNKNOWN_STAGE_ID, type Match } from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { Record } from '@/components/analytics/Record';
import { RecordBar } from '@/components/charts/inlineMarks';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { UnknownRow } from '@/components/EvidenceCues';
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
    // Plan 39.1-49 (OOS-3; UI-SPEC §8.4 "< 640 the bar drops below the name
    // line", §6.5 rules 1-2): a named row container. Below a 480px row width
    // line 2 (bar + record) wraps under line 1 (name + chevron), starting at
    // the name's left edge (thumb 32px + gap 12px); at 480px and wider both
    // wrappers are `display: contents` and the chevron is ordered last, so
    // the one-line row is unchanged.
    <li
      className="@container/stage-row relative flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md p-2 hover:bg-accent"
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
      <div
        className="flex min-w-0 flex-1 items-center gap-3 @min-[480px]/stage-row:contents"
        data-slot="stage-row-line1"
      >
        <span className="min-w-0 flex-1 truncate" title={name} data-truncate-guard>
          {name}
        </span>
        <DrillableRowChevron className="@min-[480px]/stage-row:order-last" />
      </div>
      <div
        className="flex basis-full items-center gap-3 pl-11 @min-[480px]/stage-row:contents"
        data-slot="stage-row-line2"
      >
        <span className="shrink-0">
          <RecordBar wins={record.wins} losses={record.losses} />
        </span>
        <Record wins={record.wins} losses={record.losses} cue="none" />
      </div>
    </li>
  );
}

/**
 * The Match Data stage card (UIX-02/UIX-04, UI-SPEC §8.4, owner note 7):
 * a stage-first `BoundedList` of KNOWN stages ordered by games
 * (`getStageRecords`), each row navigating to the stage detail route; the
 * unknown-stage bucket follows it once, unranked, as an `UnknownRow`. The old centred stage-art header and
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

  // Plan 39.1-54 (UAT 39.1-29c, F8): the unknown-stage bucket is never a
  // ranked, drillable stage nor the headline's most-played stage — it is
  // disclosed once, last, through the shared `UnknownRow` (D-09/EVID-11),
  // the same forced-last disclosure the stage-detail and hub surfaces use.
  const allRecords = getStageRecords(matches);
  const records = allRecords
    .filter((record) => record.stageId !== UNKNOWN_STAGE_ID)
    .sort((a, b) => b.total - a.total || a.stageId - b.stageId);
  const unknownRecord = allRecords.find((record) => record.stageId === UNKNOWN_STAGE_ID);
  const unknownBucket = unknownRecord
    ? { games: unknownRecord.total, wins: unknownRecord.wins, losses: unknownRecord.losses }
    : null;
  const top = records[0];

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
        {/* Plan 39.1-49: a layout-neutral text-fit hook (display: contents —
            the CardContent's own flex column still lays these children out). */}
        <div data-slot="stage-breakdown" className="contents">
          {top ? (
            <StatRow
              // Plan 39.1-38: three short figures stay three-up on a phone
              // (plan 39.1-32's precedent) instead of a 2 + 1 orphan.
              fixedColumns
              figures={[
                <StatFigure key="rate" label={t('common.rate')} value={`${top.winRate}%`} />,
                <StatFigure key="wins" label={t('common.wins')} value={top.wins} />,
                <StatFigure key="losses" label={t('common.losses')} value={top.losses} />,
              ]}
            />
          ) : null}
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
          {unknownBucket ? (
            <ul className="flex flex-col gap-2" data-slot="stage-breakdown-unknown">
              <UnknownRow bucket={unknownBucket} as="li" />
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
