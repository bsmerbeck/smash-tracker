import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import type { Match } from '@smash-tracker/shared';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { getStageRecords } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { buildStageSeriesRow, pairingWinRate, useStageDrill } from '../lib/stageSeries';
import { ReferenceSwatch } from './StageSeries';

/**
 * Stage breakdown for the selected matchup (sketch 003 A `stageCard`, plan
 * 39.1-46): one neutral series row per RECOGNISED stage (present in
 * `stagesById`, id != 0 — `getStageRecords` groups an absent/no-selection map
 * under stage id 0), most games first then stage id ascending for a
 * deterministic tie-break — never an "UNK"/"unknown" row. Each row is the
 * record, rate, sample size and confidence glyph against the pairing's
 * all-time rate (the reference tick); a stage under the 3-game floor is grey.
 * Every row drills the results list to that stage (PD-46-3), so the card has
 * no inert row (`noInertRow.test.tsx` enumerates it).
 *
 * Every game the engine could not attribute to a real stage (no map selected,
 * or an id `stagesById` doesn't carry) is disclosed with its exact count in
 * ONE footnote, mirroring `shared.evidence.unnamedBucket`'s "never silently
 * drop a counted game" discipline — the rows' summed games plus the
 * footnote's count always equal the pairing's total game count.
 */
export function MatchupStageTable({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const onSelectRow = useStageDrill();
  const records = getStageRecords(matchupMatches);

  if (records.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('matchups.stageTable.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('matchups.insights.empty')}</p>
        </CardContent>
      </Card>
    );
  }

  const recognised = records
    .filter((record) => record.stageId !== 0 && stagesById.has(record.stageId))
    .sort((a, b) => (b.total !== a.total ? b.total - a.total : a.stageId - b.stageId));
  const noStageGames = records
    .filter((record) => record.stageId === 0 || !stagesById.has(record.stageId))
    .reduce((sum, record) => sum + record.total, 0);
  const rows = recognised
    .map((record) => buildStageSeriesRow({ record }))
    .filter((row): row is ComparisonBarsRow => row !== null);
  const referenceRate = pairingWinRate(matchupMatches);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <CardTitle>{t('matchups.stageTable.title')}</CardTitle>
        <p className="min-w-0 text-xs leading-4 text-muted-foreground tabular-nums">
          {t('matchups.stageTable.meta')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.length > 0 && (
          <>
            <ComparisonBars
              tone="series"
              divided
              rows={rows}
              referenceRate={referenceRate}
              onSelectRow={onSelectRow}
            />
            <p
              data-slot="stage-table-legend"
              className="flex flex-wrap items-center gap-x-1.5 text-xs leading-4 text-muted-foreground"
            >
              <ReferenceSwatch />
              <span>
                {t('analytics.trend.legend.reference', {
                  rate: `${Math.round(referenceRate)}%`,
                })}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {t('matchups.stageTable.legendSubFloor', { count: ABSTENTION_FLOOR_GAMES })}
              </span>
            </p>
          </>
        )}
        {noStageGames > 0 && (
          <p
            className="text-xs leading-4 text-muted-foreground tabular-nums"
            data-slot="stage-table-no-stage"
          >
            {t('matchups.stageTable.noStage', { count: noStageGames })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
