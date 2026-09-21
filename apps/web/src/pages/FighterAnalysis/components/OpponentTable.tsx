import { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { LIST_CAP } from '@/components/analytics/BoundedList';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';

/**
 * One row's prepared data — the shape a HOST builds, never something this
 * component derives itself. `key` must be stable across renders (the
 * own-subject host uses the engine's resolved identity string; the
 * third-party host uses the raw scouted tag).
 */
export interface OpponentTableRow {
  key: string;
  /** The label shown in the Opponent column. */
  displayLabel: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}

/**
 * Ports legacy/src/screens/FighterAnalysis/components/OpponentTable —
 * per-human-opponent records for the selected fighter.
 *
 * Phase 38-07 (H-02/Q11.4): this component has TWO hosts with INCOMPATIBLE
 * data scopes — `FighterAnalysisPage.tsx` (the viewer's own, alias-resolved
 * identities) and `Scout/components/FullAnalysisSection.tsx` (a SCOUTED
 * THIRD PARTY's raw-tag-grouped history). It is therefore purely
 * PRESENTATIONAL: it takes an already-ordered `rows` array (the host decides
 * identity resolution AND the descending-by-games sort — this component
 * renders the array in the order given, unchanged) plus an OPTIONAL
 * `hubHref` destination builder. It resolves nothing, fetches nothing, and
 * calls no hook that needs a provider (no `useQuery`, no router hook) —
 * `Link` is only ever rendered from inside `DrillableRow`'s `to`-branch,
 * which never fires when `hubHref` is absent or returns `undefined` for a
 * given row, so the third-party host's bare (no `MemoryRouter`, no
 * `QueryClientProvider`) render stays valid.
 *
 * A row for which `hubHref` returns `undefined` (its identity cannot be
 * addressed — the engine's unnamed bucket has no `displayTag` to link) is
 * rendered as plain text with no chevron and no link, matching D-14's
 * per-row exemption contract.
 */
export function OpponentTable({
  rows,
  hubHref,
}: {
  rows: OpponentTableRow[];
  /** Host-supplied destination builder. Absent entirely at the third-party host (Scout); may still return `undefined` for an individual unaddressable row at the own-subject host. */
  hubHref?: (row: OpponentTableRow) => string | undefined;
}) {
  const { t } = useTranslation();
  // T-39.1-14: this surface's nested vertical scroller is replaced by the
  // bounded-list cap ladder (UI-SPEC §6.4) — capped at `LIST_CAP` (8), with a
  // "Show all"/"Show fewer" toggle instead of an `overflow-y-auto` box. Table
  // semantics stay a real `<table>` (this component's own row/cell-count
  // tests depend on it) rather than `BoundedList`'s own `<ul>`.
  const [expanded, setExpanded] = useState(false);
  const visibleRows = expanded ? rows : rows.slice(0, LIST_CAP);
  const hasMore = rows.length > LIST_CAP;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('fighterAnalysis.opponents.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fighterAnalysis.opponents.empty')}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('matchups.opponent')}</TableHead>
                  <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                  <TableHead>{t('fighterAnalysis.opponents.matches')}</TableHead>
                  <TableHead>{t('common.wins')}</TableHead>
                  <TableHead>{t('common.losses')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  const destination = hubHref?.(row);
                  return (
                    <TableRow key={row.key} className="relative hover:bg-accent">
                      <TableCell className="relative capitalize">
                        {destination != null && (
                          <DrillableRow
                            to={destination}
                            as="overlay"
                            ariaLabel={t('shared.drillableRow.aria', {
                              subject: row.displayLabel,
                              context: t('fighterAnalysis.opponents.title'),
                            })}
                          />
                        )}
                        {row.displayLabel}
                      </TableCell>
                      <TableCell>{row.winRate}%</TableCell>
                      <TableCell>{row.total}</TableCell>
                      <TableCell>{row.wins}</TableCell>
                      <TableCell>
                        <span className="flex items-center justify-between gap-2">
                          {row.losses}
                          {destination != null && <DrillableRowChevron />}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {hasMore && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded
                  ? t('analytics.list.showFewer')
                  : t('analytics.list.showAll', { count: rows.length })}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
