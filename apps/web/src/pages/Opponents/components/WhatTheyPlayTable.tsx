import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RankedMatchup } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';

/**
 * "What they play" — the opponent's characters against you, your record per
 * character, evidence-ranked (Wilson lower bound) so the matchups you most
 * reliably win sit at the top.
 */
export function WhatTheyPlayTable({ byTheirFighter }: { byTheirFighter: RankedMatchup[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.whatTheyPlay.title')}</CardTitle>
        <CardDescription>{t('opponents.whatTheyPlay.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {byTheirFighter.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.whatTheyPlay.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('opponents.whatTheyPlay.character')}</TableHead>
                <TableHead>{t('matchups.stageTable.record')}</TableHead>
                <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                <TableHead className="text-right">{t('trends.monthly.games')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byTheirFighter.map((row) => {
                const sprite = getFighterById(row.opponentFighterId);
                return (
                  <TableRow key={row.opponentFighterId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {sprite && (
                          <img src={sprite.url} alt="" className="size-6 object-contain" />
                        )}
                        <span>
                          {sprite
                            ? localizedFighterName(row.opponentFighterId, t)
                            : t('common.unknown')}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.wins}-{row.losses}
                    </TableCell>
                    <TableCell>{row.ratio}%</TableCell>
                    <TableCell className="text-right">{row.totalMatches}</TableCell>
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
