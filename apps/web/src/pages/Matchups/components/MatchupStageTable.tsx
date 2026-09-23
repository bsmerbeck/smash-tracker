import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Match } from '@smash-tracker/shared';
import { getStageRecords } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { StageOption } from '@/components/StageOption';

/**
 * Per-stage records for the selected matchup (39.1-31, item 8): only
 * RECOGNISED stages (present in `stagesById`, id != 0 — `getStageRecords`
 * groups an absent/no-selection map under stage id 0) get a table row,
 * sorted by sample size descending, then stage id ascending for a
 * deterministic tie-break — never an "UNK"/"unknown" row or tile. Every
 * game the engine could not attribute to a real stage (no map selected, or
 * an id `stagesById` doesn't carry) is disclosed with its exact count in
 * ONE footnote below the table, mirroring `shared.evidence.unnamedBucket`'s
 * "never silently drop a counted game" discipline — the rows' summed games
 * plus the footnote's count always equal the pairing's total game count.
 */
export function MatchupStageTable({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchups.stageTable.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {recognised.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('matchups.stageTable.stage')}</TableHead>
                <TableHead>{t('matchups.stageTable.record')}</TableHead>
                <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recognised.map((record) => (
                <TableRow key={record.stageId}>
                  <TableCell>
                    <StageOption stage={stagesById.get(record.stageId)!} />
                  </TableCell>
                  <TableCell>
                    {record.wins}-{record.losses}
                  </TableCell>
                  <TableCell>{record.winRate}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
