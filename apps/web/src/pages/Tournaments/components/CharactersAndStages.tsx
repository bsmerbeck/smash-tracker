import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { getRecordsByFighter, getStageRecords, type FighterRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';
import { useFighterName } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { DrillableRow } from '@/components/DrillableRow';

/** Which drill-down axis a `FighterCard`'s rows write — the user's own character column or the opponent's. */
type FighterAxis = 'mine' | 'theirs';

function FighterRow({
  record,
  axis,
  destination,
}: {
  record: FighterRecord;
  axis: FighterAxis;
  destination?: string;
}) {
  const { t } = useTranslation();
  const sprite = getFighterById(record.fighterId);
  const localizedName = useFighterName(record.fighterId);
  const label = sprite ? localizedName : t('common.unknown');
  const detail = `${record.wins}-${record.losses} · ${t('common.games', { count: record.total })}`;

  const content = (
    <>
      <div className="flex items-center gap-2">
        {sprite && <img src={sprite.url} alt="" className="size-7 object-contain" />}
        <span className="text-sm">{label}</span>
      </div>
      <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">{detail}</span>
    </>
  );

  if (destination == null) {
    return <li className="flex items-center justify-between gap-2">{content}</li>;
  }

  return (
    <li>
      <DrillableRow
        to={destination}
        ariaLabel={t('shared.drillableRow.aria', {
          subject: label,
          context: t(
            axis === 'mine'
              ? 'tournaments.charStages.yourCharacters'
              : 'tournaments.charStages.opponentsCharacters',
          ),
        })}
        className="justify-between px-1"
      >
        {content}
      </DrillableRow>
    </li>
  );
}

function FighterCard({
  title,
  matches,
  axis,
  subjectPath,
  keyFn,
}: {
  title: string;
  matches: Match[];
  axis: FighterAxis;
  subjectPath: (path: string) => string;
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
            {records.map((record) => {
              const search = buildDrillDownSearch(
                axis === 'mine'
                  ? { fighterId: record.fighterId }
                  : { vsFighterId: record.fighterId },
              ).toString();
              const destination = subjectPath(`/matchups?${search}`);
              return (
                <FighterRow
                  key={record.fighterId}
                  record={record}
                  axis={axis}
                  destination={destination}
                />
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StagesCard({
  matches,
  subjectPath,
  eventKeyForStage,
}: {
  matches: Match[];
  subjectPath: (path: string) => string;
  /**
   * WR-04 (38-REVIEW-FIX): now a per-(stage, proximity-block) lookup — this
   * card's own aggregate row has no single match of its own (it summarizes
   * every game on the stage across the whole entry), so it calls this with
   * only `stageId`, which resolves to the MOST RECENT block for that stage
   * (see `TournamentDetailPage.tsx`'s `eventKeyForStage`).
   */
  eventKeyForStage?: (stageId: number, matchId?: string) => string | undefined;
}) {
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
              const name = stage?.name ?? t('common.unknown');
              const detail = `${record.wins}-${record.losses} · ${t('common.games', { count: record.total })}`;
              const eventKey = eventKeyForStage?.(record.stageId);
              const search = buildDrillDownSearch(eventKey ? { eventKey } : {}).toString();
              const destination = subjectPath(
                `/stages/${record.stageId}${search ? `?${search}` : ''}`,
              );
              return (
                <li key={record.stageId}>
                  <DrillableRow
                    to={destination}
                    ariaLabel={t('shared.drillableRow.aria', {
                      subject: name,
                      context: t('tournaments.charStages.stagesPlayed'),
                    })}
                    className="justify-between px-1"
                  >
                    <div className="flex items-center gap-2">
                      {stage?.url ? (
                        <img src={stage.url} alt="" className="h-8 w-14 rounded object-cover" />
                      ) : (
                        <span className="flex h-8 w-14 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                          {stage ? stage.name.slice(0, 3).toUpperCase() : '??'}
                        </span>
                      )}
                      <span className="text-sm">{name}</span>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                      {detail}
                    </span>
                  </DrillableRow>
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
 *
 * Phase 38-07 (D-14): every row is now drillable per the Uniform
 * Drillable-Row Contract. This card's only host is `TournamentDetailPage.tsx`
 * (own-account only, D-04), so it calls `useSubjectPath()` directly rather
 * than taking a host-supplied builder — there is no third-party-data host
 * rendering this component.
 *
 * CR-03 (38-REVIEW-FIX): `eventKeyForStage` (a per-STAGE lookup, not a single
 * flat string) is threaded down for the stage rows' event axis — a flat key
 * shared by every row could only ever match ONE stage's real event-series
 * anchor on `StageDetailPage.tsx` (that page scopes matches by stage BEFORE
 * grouping into anchors, so each stage's anchor carries its OWN start time).
 * Optional because a legacy entry may resolve no anchor for a given stage.
 */
export function CharactersAndStages({
  matches,
  eventKeyForStage,
}: {
  matches: Match[];
  eventKeyForStage?: (stageId: number, matchId?: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <FighterCard
        title={t('tournaments.charStages.yourCharacters')}
        matches={matches}
        axis="mine"
        subjectPath={subjectPath}
      />
      <FighterCard
        title={t('tournaments.charStages.opponentsCharacters')}
        matches={matches}
        axis="theirs"
        subjectPath={subjectPath}
        keyFn={(m) => m.opponent_id}
      />
      <StagesCard matches={matches} subjectPath={subjectPath} eventKeyForStage={eventKeyForStage} />
    </div>
  );
}
