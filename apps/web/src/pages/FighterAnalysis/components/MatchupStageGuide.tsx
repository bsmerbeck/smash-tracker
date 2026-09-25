import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match, SampleMeta } from '@smash-tracker/shared';
import {
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
  UNKNOWN_STAGE_ID,
  confidenceTierFor,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { LIST_CAP } from '@/components/analytics/BoundedList';
import { buildStageEvidence, getMatchupStageGuide, type StageRecord } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import { MIN_STAGE_MATCHES_OPTIONS } from '@/lib/analyticsSelection';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { SampleCue, UnknownRow, MixedContextBadge } from '@/components/EvidenceCues';

/** WR-C06 (39.1-REVIEW.md): a stable id the show-all/show-fewer toggle's `aria-controls` points at — this component mounts once per `FighterAnalysisPage`, so a single static id is safe. */
const STAGE_GUIDE_TABLE_ID = 'matchup-stage-guide-table';

/**
 * Phase 38-06 (ADV-03): this card's only host is `FighterAnalysisPage.tsx`
 * (own-subject, `MemoryRouter`-wrapped test harness) — unlike
 * `StageMastery.tsx`, there is no third-party-data host rendering this
 * component bare, so it calls `useSubjectPath()` directly rather than
 * taking a host-supplied builder.
 */
function stageCell(
  record: StageRecord | null,
  opponentFighterId: number,
  t: TFunction,
  refreshedAt: number,
  subjectPath: (path: string) => string,
) {
  if (!record) {
    return <span className="text-muted-foreground">—</span>;
  }
  const name = stagesById.get(record.stageId)?.name ?? t('common.unknown');
  const sample: SampleMeta = {
    rawSampleSize: record.total,
    eligibleDenominator: record.total,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(record.total),
  };
  const label = (
    <>
      {name}{' '}
      <span className="text-muted-foreground">
        {t('common.rateOverSample', { rate: record.winRate, total: record.total })}
      </span>{' '}
      <SampleCue sample={sample} />
    </>
  );
  // An unaddressable target (the unknown-stage sentinel) is an enumerated
  // exemption, not an inert row — plain text, never a link.
  if (record.stageId === UNKNOWN_STAGE_ID) {
    return <span>{label}</span>;
  }
  const destination = subjectPath(
    `/stages/${record.stageId}?${buildDrillDownSearch({ vsFighterId: opponentFighterId }).toString()}`,
  );
  return <Link to={destination}>{label}</Link>;
}

/**
 * The v2 matchup guide (replaces the legacy-quirk RosterBreakdown): for every
 * opponent fighter actually faced, the record for that matchup plus the best
 * and worst stage to take them to, qualified by a user-adjustable per-stage
 * minimum match threshold. Rows sort by sample size so the most-informed
 * matchups lead. Phase 35-03 (D-11): the threshold is the one shared
 * per-subject value `useMinStageMatches` owns — changing it here moves
 * Matchup Insights and Counterpick Advisor too.
 *
 * Phase 36 (EVID-06, EVID-10): the empty branch now reads the shared
 * abstained sentence, each best/worst stage cell carries the shared
 * sample/confidence cue, an evidence-type caption marks this card as an
 * inference, an unknown-stage row is forced last in the table body when
 * present, and a mixed-context badge flags a session-type/provenance split —
 * the same claim shape every other advisor surface renders from (D-13).
 */
export function MatchupStageGuide({ fighterMatches }: { fighterMatches: Match[] }) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const [threshold, setThreshold] = useMinStageMatches();
  // IN-06 (39.1-REVIEW iteration 2): associates the visible caption with the
  // select trigger — the Matchups page's WR-05 pattern (label-in-name).
  const minMatchesSelectId = useId();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());
  // T-39.1-14: this surface's nested vertical scroller is replaced by the
  // bounded-list cap ladder (UI-SPEC §6.4) — capped at `LIST_CAP` (8), with a
  // "Show all"/"Show fewer" toggle instead of an `overflow-y-auto` box. Table
  // semantics stay a real `<table>` (the row/cell-count tests this component
  // already carries depend on it) rather than `BoundedList`'s own `<ul>`.
  const [expanded, setExpanded] = useState(false);
  const rows = getMatchupStageGuide(fighterMatches, threshold);
  const visibleRows = expanded ? rows : rows.slice(0, LIST_CAP);
  const hasMore = rows.length > LIST_CAP;
  const { claim, unknown, cohort } = buildStageEvidence({
    matches: fighterMatches,
    refreshedAt,
    minMatches: threshold,
  });
  const abstainedGamesNeeded = claim.kind === 'abstained' ? claim.gamesNeeded : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <CardTitle>{t('fighterAnalysis.guide.title')}</CardTitle>
            <MixedContextBadge cohort={cohort} />
          </div>
          <CardDescription>{t('shared.evidence.type.inference')}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={minMatchesSelectId} className="text-sm text-muted-foreground">
            {t('matchups.insights.minMatches')}
          </Label>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            {/* Named by the visible <Label htmlFor> above — no aria-label override. */}
            <SelectTrigger id={minMatchesSelectId} className="w-[72px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_STAGE_MATCHES_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('shared.evidence.abstained', { count: abstainedGamesNeeded })}
          </p>
        ) : (
          <>
            <Table id={STAGE_GUIDE_TABLE_ID}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('matchups.opponent')}</TableHead>
                  <TableHead>{t('matchups.stageTable.record')}</TableHead>
                  <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                  <TableHead>{t('matchups.insights.bestStage')}</TableHead>
                  <TableHead>{t('matchups.insights.worstStage')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
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
                        {row.record.wins}-{row.record.losses}
                      </TableCell>
                      <TableCell>{row.record.winRate}%</TableCell>
                      <TableCell>
                        {stageCell(
                          row.bestStage,
                          row.opponentFighterId,
                          t,
                          refreshedAt,
                          subjectPath,
                        )}
                      </TableCell>
                      <TableCell>
                        {stageCell(
                          row.worstStage,
                          row.opponentFighterId,
                          t,
                          refreshedAt,
                          subjectPath,
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <UnknownRow bucket={unknown} as="tr" />
              </TableBody>
            </Table>
            {hasMore && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={STAGE_GUIDE_TABLE_ID}
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
