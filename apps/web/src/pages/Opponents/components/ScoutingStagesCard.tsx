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
import type { StageRecord } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';

const MAX_STAGES = 6;

/**
 * Stages this opponent takes you to most, sorted by sample size, top 6.
 *
 * Phase 38-07 (D-12/D-14): single host (`OpponentHubPage.tsx`, after plan
 * 38-05 Task 2), so the hub host builds and passes down the per-stage
 * destination — this card takes `{ byStage }` alone and cannot know the
 * opponent identity, so it never derives a destination itself. Absent a
 * `stageHref`, a row renders plain text (matching the pre-existing
 * unknown-stage branch's own no-link treatment).
 */
export function ScoutingStagesCard({
  byStage,
  stageHref,
}: {
  byStage: StageRecord[];
  /** Host-supplied destination builder (the hub's only host, so this is never absent in production — kept optional for the empty/loading render path). */
  stageHref?: (stageId: number) => string;
}) {
  const { t } = useTranslation();
  const top = byStage.slice(0, MAX_STAGES);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.stages.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.stages.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('matchups.stageTable.stage')}</TableHead>
                <TableHead>{t('matchups.stageTable.record')}</TableHead>
                <TableHead className="text-right">{t('matchups.stageTable.winRate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((record) => {
                const isUnknown = record.stageId === 0;
                const name = isUnknown
                  ? 'unknown'
                  : (stagesById.get(record.stageId)?.name ?? t('common.unknown'));
                const destination = isUnknown ? undefined : stageHref?.(record.stageId);
                return (
                  <TableRow key={record.stageId} className="relative hover:bg-accent">
                    <TableCell className="relative">
                      {destination != null && (
                        <DrillableRow
                          as="overlay"
                          to={destination}
                          ariaLabel={t('shared.drillableRow.aria', {
                            subject: name,
                            context: t('opponents.stages.title'),
                          })}
                        />
                      )}
                      {name}
                    </TableCell>
                    <TableCell>
                      {record.wins}-{record.losses}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="flex items-center justify-end gap-2">
                        {record.winRate}%{destination != null && <DrillableRowChevron />}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
