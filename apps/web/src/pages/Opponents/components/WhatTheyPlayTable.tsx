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
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';

/**
 * "What they play" — the opponent's characters against you, your record per
 * character, evidence-ranked (Wilson lower bound) so the matchups you most
 * reliably win sit at the top.
 *
 * Phase 38-07 (C2-H-01): this component has TWO hosts with incompatible data
 * scopes — `OpponentHubPage.tsx` (the hub's own, resolved opponent) and
 * `Scout/components/FullAnalysisSection.tsx` (a SCOUTED THIRD PARTY's
 * per-game history). It therefore takes an OPTIONAL host-supplied `rowHref`
 * destination builder and calls no router hook itself: with a builder, a
 * row with a known fighter is a real anchor into the param-aware Matchups
 * page; with none supplied (the Scout host), no row renders an anchor at
 * all — preserving that host's six bare-render test cases.
 */
export function WhatTheyPlayTable({
  byTheirFighter,
  rowHref,
  layout: layoutOverride,
}: {
  byTheirFighter: RankedMatchup[];
  /** Host-supplied destination builder — absent entirely at the third-party host (Scout). */
  rowHref?: (row: RankedMatchup) => string;
  /** Plan 39.1-49: forces one layout (tests); otherwise read once from the viewport (below 640px: stacked rows). */
  layout?: RowLayout;
}) {
  const { t } = useTranslation();
  // Plan 39.1-49 (UI-SPEC §6.6): exactly one root mounts per render; the
  // hook is provider-free, so the Scout host's bare render stays valid.
  const layout = useRowLayout(layoutOverride);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.whatTheyPlay.title')}</CardTitle>
        <CardDescription>{t('opponents.whatTheyPlay.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {byTheirFighter.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.whatTheyPlay.empty')}</p>
        ) : layout === 'stack' ? (
          // Plan 39.1-49 (UI-SPEC §6.6 / §6.5 rules 1-2): one stacked row per
          // character — line 1 the sprite and name in the one truncating slot
          // (full name as its title) plus the chevron, line 2 record, rate
          // and games as whole tokens. Same overlay link when rowHref
          // resolves; the root keeps the hub's clip-target data-slot.
          <ul data-slot="what-they-play" className="flex flex-col divide-y">
            {byTheirFighter.map((row) => {
              const sprite = getFighterById(row.opponentFighterId);
              const label = sprite
                ? localizedFighterName(row.opponentFighterId, t)
                : t('common.unknown');
              const destination = sprite ? rowHref?.(row) : undefined;
              return (
                <li
                  key={row.opponentFighterId}
                  data-slot="what-they-play-row"
                  className="relative flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 hover:bg-accent"
                >
                  {destination != null && (
                    <DrillableRow
                      as="overlay"
                      to={destination}
                      ariaLabel={t('shared.drillableRow.aria', {
                        subject: label,
                        context: t('opponents.whatTheyPlay.title'),
                      })}
                    />
                  )}
                  <div className="flex min-w-0 items-center gap-2">
                    {sprite && (
                      <img src={sprite.url} alt="" className="size-6 shrink-0 object-contain" />
                    )}
                    <span title={label} className="min-w-0 flex-1 truncate text-sm font-medium">
                      {label}
                    </span>
                    {destination != null && <DrillableRowChevron />}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                    <span className="whitespace-nowrap">
                      <span className="sr-only">{t('matchups.stageTable.record')} </span>
                      {row.wins}-{row.losses}
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="sr-only">{t('matchups.stageTable.winRate')} </span>
                      {row.ratio}%
                    </span>
                    <span className="whitespace-nowrap">
                      {row.totalMatches} {t('trends.monthly.games')}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Table data-slot="what-they-play">
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
                const label = sprite
                  ? localizedFighterName(row.opponentFighterId, t)
                  : t('common.unknown');
                // The unknown-character case (D-14's per-row exemption) never
                // gets a destination, even when the host supplied a builder.
                const destination = sprite ? rowHref?.(row) : undefined;
                return (
                  <TableRow key={row.opponentFighterId} className="relative hover:bg-accent">
                    <TableCell className="relative">
                      {destination != null && (
                        <DrillableRow
                          as="overlay"
                          to={destination}
                          ariaLabel={t('shared.drillableRow.aria', {
                            subject: label,
                            context: t('opponents.whatTheyPlay.title'),
                          })}
                        />
                      )}
                      <div className="flex items-center gap-2">
                        {sprite && (
                          <img src={sprite.url} alt="" className="size-6 object-contain" />
                        )}
                        <span>{label}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.wins}-{row.losses}
                    </TableCell>
                    <TableCell>{row.ratio}%</TableCell>
                    <TableCell className="text-right">
                      <span className="flex items-center justify-end gap-2">
                        {row.totalMatches}
                        {destination != null && <DrillableRowChevron />}
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
