import type { ReactNode } from 'react';
import type { Match, StageRecord } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { Record } from '@/components/analytics/Record';
import type { ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { stagesById } from '@/data/stages';
import { TierGlyph } from '../components/StageSeries';
import { useMatchupsContext } from '../MatchupsContext';
import { MATCHUP_TABLE_ANCHOR_ID } from './matchupAnchors';

/**
 * Plan 39.1-46 (sketch 003 A `stageBars` / `stageCard` / `insightsCard`, CSS
 * 236-247): the ONE stage evidence row the Matchups rail cards share — the
 * Stage breakdown and the Insights card's Best / Worst rows. A row is
 * `ComparisonBars`' neutral `series` tone: blue fill, the pairing's all-time
 * rate as the reference tick, grey under the abstention floor, the record
 * and confidence glyph as the value, and a click that drills the results
 * list to the stage (PD-46-3: text only, no thumbnails).
 */

/** The pairing's all-time win rate, 0-100 and unrounded (the reference tick's position); 0 over no games. */
export function pairingWinRate(matches: readonly Match[]): number {
  if (matches.length === 0) return 0;
  const wins = matches.filter((match) => match.win).length;
  return (wins / matches.length) * 100;
}

/** `Record`'s own text as one accessible sentence: `W–L · rate% · n`, no rate under the floor. */
function recordSentence(record: StageRecord): string {
  const base = `${record.wins}–${record.losses}`;
  return record.total >= ABSTENTION_FLOOR_GAMES
    ? `${base} · ${record.winRate}% · ${record.total}`
    : `${base} · ${record.total}`;
}

export interface StageSeriesRowInput {
  record: StageRecord;
  /** The row's label node. Absent: the recognised stage's plain name. */
  label?: ReactNode;
  /** The label's full text for the native tooltip. Absent: the stage's name. */
  labelTitle?: string;
}

/** One stage record as a `series` row; `null` for a stage id `stagesById` does not carry (never an "unknown" row). */
export function buildStageSeriesRow({
  record,
  label,
  labelTitle,
}: StageSeriesRowInput): ComparisonBarsRow | null {
  const stage = stagesById.get(record.stageId);
  if (!stage) return null;
  return {
    key: String(record.stageId),
    label: label ?? stage.name,
    labelTitle: labelTitle ?? stage.name,
    value: record.winRate,
    subFloor: record.total < ABSTENTION_FLOOR_GAMES,
    valueLabel: recordSentence(record),
    valueNode: (
      <>
        <Record
          wins={record.wins}
          losses={record.losses}
          cue="none"
          emphasis
          className="[&>span:first-child]:text-foreground"
        />
        <TierGlyph total={record.total} />
      </>
    ),
  };
}

/**
 * A row click writes the stage axis to the URL (the Matchups context's
 * `setDrillDown`, the same idiom as `CounterpickAdvisor` and the matrix) and
 * scrolls to the results anchor. Numeric stage id only — `row.key` is
 * `String(stageId)`.
 */
export function useStageDrill(): (row: ComparisonBarsRow) => void {
  const { setDrillDown } = useMatchupsContext();
  return (row) => {
    setDrillDown({ stageId: Number(row.key) });
    document
      .getElementById(MATCHUP_TABLE_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}
