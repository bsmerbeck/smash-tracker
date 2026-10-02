import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match, StageRecord } from '@smash-tracker/shared';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { buildStageEvidence, getBestWorstStages, getStreakSummary } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { MIN_STAGE_MATCHES_OPTIONS } from '@/lib/analyticsSelection';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { cn } from '@/lib/utils';
import { UnknownRow, MixedContextBadge } from '@/components/EvidenceCues';
import { buildStageSeriesRow, pairingWinRate, useStageDrill } from '../lib/stageSeries';
import { TierGlyph } from './StageSeries';

/** The overline role (StatFigure's label): the stages head reads as the streak labels do. */
const OVERLINE_CLASS =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

/**
 * A Best / Worst row label: the translated "Best · {{stage}}" sentence with
 * everything around the stage name drawn in the meta tone (sketch 003 A
 * `stageRow`'s `.t-meta` prefix). The whole sentence is the label's title.
 */
function stageLabel(
  kind: 'best' | 'worst',
  stageName: string,
  t: TFunction,
): { node: ReactNode; title: string } {
  const text = t(`matchups.insights.${kind}Label`, { stage: stageName });
  const at = text.lastIndexOf(stageName);
  if (at < 0) return { node: text, title: text };
  const before = text.slice(0, at).trim();
  const after = text.slice(at + stageName.length).trim();
  // The separating spaces are text nodes OUTSIDE the muted spans, so the row's
  // accessible name reads "Best · Smashville" rather than running the words together.
  return {
    title: text,
    node: (
      <>
        {before && <span className="font-normal text-muted-foreground">{before}</span>}
        {before && ' '}
        {stageName}
        {after && ' '}
        {after && <span className="font-normal text-muted-foreground">{after}</span>}
      </>
    ),
  };
}

function stageRow(
  kind: 'best' | 'worst',
  record: StageRecord,
  t: TFunction,
): ComparisonBarsRow | null {
  const stage = stagesById.get(record.stageId);
  if (!stage) return null;
  const { node, title } = stageLabel(kind, stage.name, t);
  return buildStageSeriesRow({ record, label: node, labelTitle: title });
}

/**
 * The Insights rail card for the selected matchup (sketch 003 A
 * `insightsCard`, plan 39.1-46, PD-46-1): ONE top line — the Fact claim chip,
 * "Matchup Insights · all time" and the confidence glyph (plus the
 * mixed-context badge only when the cohort is mixed) — then the fixed 3-up
 * streak row, then "Stages · min N games" with a "change" link that opens the
 * threshold control in a popover, and the Best / Worst stage as series rows
 * against the pairing's all-time rate (each row drills the results list to its
 * stage). The recent-form pip row, the second By Match Type list and the
 * emerald / destructive headings are gone — the hero's form strip and share
 * bar already carry them, and colour stays on win / loss marks.
 *
 * Phase 35-03 (D-11): the threshold is the one shared per-subject value
 * `useMinStageMatches` owns — changing it here moves Counterpick Advisor and
 * Matchup Stage Guide too. Phase 36 (EVID-06, EVID-10): an abstained read
 * shows the shared sentence once with the exact remaining-games count; an
 * unknown-stage bucket is disclosed as one muted line.
 */
export function MatchupInsights({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useMinStageMatches();
  const minMatchesSelectId = useId();
  const topLineId = useId();
  const stagesHeadId = useId();
  const onSelectRow = useStageDrill();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  const streaks = getStreakSummary(matchupMatches);
  const { best, worst } = getBestWorstStages(matchupMatches, threshold);
  const { claim, unknown, cohort } = buildStageEvidence({
    matches: matchupMatches,
    refreshedAt,
    minMatches: threshold,
  });
  const abstainedGamesNeeded = claim.kind === 'abstained' ? claim.gamesNeeded : 0;

  const bestRow = best ? stageRow('best', best, t) : null;
  const worstRow = worst ? stageRow('worst', worst, t) : null;
  const rows = [bestRow, worstRow].filter((row): row is ComparisonBarsRow => row !== null);
  const referenceRate = pairingWinRate(matchupMatches);

  let stagesBody: ReactNode;
  if (rows.length === 0) {
    // Abstained: the shared sentence, once. (`best` is null only when the whole
    // query is below the floor or no recognised stage qualifies.)
    stagesBody = (
      <p className="text-sm text-muted-foreground">
        {t('shared.evidence.abstained', { count: abstainedGamesNeeded })}
      </p>
    );
  } else {
    stagesBody = (
      <>
        <ComparisonBars
          tone="series"
          rows={rows}
          referenceRate={referenceRate}
          onSelectRow={onSelectRow}
        />
        {!worstRow && claim.kind === 'evidenced' && (
          // WR-02: the query is NOT abstained here — `worst` is null only because
          // exactly one stage qualifies (`getBestWorstStages`: "a single stage
          // can't be both the recommendation and the warning"). The generic
          // abstained sentence would fabricate "0 more games needed"; this copy
          // names what would actually change the state.
          <p className="text-sm text-muted-foreground">{t('matchups.insights.singleStageOnly')}</p>
        )}
      </>
    );
  }

  return (
    <Card role="region" aria-labelledby={topLineId} className="gap-3 p-5 shadow-none">
      <div className="flex flex-wrap items-center gap-2">
        <ClaimChip kind="fact" label={t('insights.kind.fact')} />
        <span id={topLineId} className="text-xs leading-4 text-muted-foreground tabular-nums">
          {t('matchups.insights.meta')}
        </span>
        <span className="text-muted-foreground">
          <TierGlyph total={matchupMatches.length} />
        </span>
        <MixedContextBadge cohort={cohort} />
      </div>

      {matchupMatches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('matchups.insights.empty')}</p>
      ) : (
        <>
          {/*
            Plan 39.1-32 (item 10, UI-SPEC §7.3 StatRow, §4.3 rule 2): one
            fixedColumns StatRow — the kit's 860px two-column collapse would
            otherwise orphan the third of these three short counts (2+1). The
            current streak's direction is carried by the unit WORD
            ("win"/"loss"), never by a coloured value — no chip, no delta
            (D-07: no insight asserts a direction here).
          */}
          <StatRow
            fixedColumns
            figures={[
              <StatFigure
                key="current"
                label={t('matchups.insights.currentStreak')}
                value={streaks.currentStreak}
                unitSuffix={t(
                  streaks.currentStreakIsWin
                    ? 'matchups.insights.streakUnit.win'
                    : 'matchups.insights.streakUnit.loss',
                  { count: streaks.currentStreak },
                )}
              />,
              <StatFigure
                key="longestWin"
                label={t('matchups.insights.longestWin')}
                value={streaks.bestWinStreak}
              />,
              <StatFigure
                key="longestLoss"
                label={t('matchups.insights.longestLoss')}
                value={streaks.worstLossStreak}
              />,
            ]}
          />

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span id={stagesHeadId} className={cn(OVERLINE_CLASS, 'mr-auto')}>
                {t('matchups.insights.stagesHead', { count: threshold })}
              </span>
              {/* The threshold control lives behind this link, never as a select in the card. */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="link"
                    size="sm"
                    aria-describedby={stagesHeadId}
                    className={cn(MUTED_LINK_TONE, 'h-auto px-1 py-0 text-xs underline')}
                  >
                    {t('matchups.insights.change')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="flex w-auto flex-col gap-2">
                  <Label htmlFor={minMatchesSelectId} className="text-sm text-muted-foreground">
                    {t('matchups.insights.minMatches')}
                  </Label>
                  <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
                    {/* WR-05: named by the visible <Label htmlFor> above — no aria-label override. */}
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
                </PopoverContent>
              </Popover>
            </div>
            {stagesBody}
            {unknown && (
              <ul>
                <UnknownRow bucket={unknown} as="li" />
              </ul>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
