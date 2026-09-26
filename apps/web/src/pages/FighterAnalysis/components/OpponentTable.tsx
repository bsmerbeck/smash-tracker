import { useId, useState } from 'react';
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
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';

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
  layout: layoutOverride,
}: {
  rows: OpponentTableRow[];
  /** Host-supplied destination builder. Absent entirely at the third-party host (Scout); may still return `undefined` for an individual unaddressable row at the own-subject host. */
  hubHref?: (row: OpponentTableRow) => string | undefined;
  /** Plan 39.1-49: forces one layout (tests / hosts); otherwise read once from the viewport (below 640px: stacked rows). */
  layout?: RowLayout;
}) {
  const { t } = useTranslation();
  // Plan 39.1-49 (UI-SPEC §6.6): exactly one root mounts — the table, or
  // below 640px the stacked two-line rows. Provider-free (Scout host).
  const layout = useRowLayout(layoutOverride);
  // T-39.1-14: this surface's nested vertical scroller is replaced by the
  // bounded-list cap ladder (UI-SPEC §6.4) — capped at `LIST_CAP` (8), with a
  // "Show all"/"Show fewer" toggle instead of an `overflow-y-auto` box. Table
  // semantics stay a real `<table>` (this component's own row/cell-count
  // tests depend on it) rather than `BoundedList`'s own `<ul>`.
  const [expanded, setExpanded] = useState(false);
  // WR-C06 (39.1-REVIEW.md): `useId()`, not a hardcoded string — this
  // component has TWO hosts (`FighterAnalysisPage.tsx`'s own-subject render
  // and Scout's third-party render) and could in principle mount more than
  // once in one tree, so the show-all toggle's `aria-controls` target needs
  // a per-instance-unique id.
  const tableId = useId();
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
            {layout === 'stack' ? (
              // Plan 39.1-49 (UI-SPEC §6.6 / §6.5 rules 1-2): one stacked row
              // per opponent — line 1 the label in the one flexible
              // truncating slot (full label as its title) plus the chevron,
              // line 2 the record, rate and matches as whole tokens. Same
              // overlay link per addressable row as the table.
              <ul id={tableId} data-slot="opponent-table" className="flex flex-col divide-y">
                {visibleRows.map((row) => {
                  const destination = hubHref?.(row);
                  return (
                    <li
                      key={row.key}
                      data-slot="opponent-table-row"
                      className="relative flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 hover:bg-accent"
                    >
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
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          title={row.displayLabel}
                          className="min-w-0 flex-1 truncate text-sm font-medium capitalize"
                        >
                          {row.displayLabel}
                        </span>
                        {destination != null && <DrillableRowChevron />}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                        <span className="whitespace-nowrap">
                          <span className="sr-only">{t('common.wins')} </span>
                          {row.wins}
                          <span aria-hidden="true">–</span>
                          <span className="sr-only"> {t('common.losses')} </span>
                          {row.losses}
                        </span>
                        <span className="whitespace-nowrap">
                          <span className="sr-only">{t('matchups.stageTable.winRate')} </span>
                          {row.winRate}%
                        </span>
                        <span className="whitespace-nowrap">
                          {row.total} {t('fighterAnalysis.opponents.matches')}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Table id={tableId} data-slot="opponent-table">
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
            )}
            {hasMore && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className={MUTED_LINK_TONE}
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={tableId}
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
