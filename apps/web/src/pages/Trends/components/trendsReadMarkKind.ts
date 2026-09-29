import { readSessionBucketsMark, readSetStripMark, type Insight } from '@smash-tracker/shared';

/**
 * Plan 39.1-40 (sketch 002-C, UI-SPEC §7.8 / §9.4): which evidence mark a
 * Trends read card draws, or null when it draws none. Shared by
 * `TrendsReadMark` (which renders it) and `TrendsReadsRail` (which passes a
 * `mark` to `InsightCard` only when there is one, so a card without a mark
 * gets no empty mark row). A plain module — `TrendsReadMarks.tsx` exports
 * components only (react-refresh).
 *
 * - TiltCost in trend / suggestion: a one-row "Next game" dumbbell.
 * - SessionFatigue in trend / suggestion with a well-formed bucket mark.
 * - Best / Toughest record as a fact: a RecordBar of its record.
 * - LastEventRecap as a fact with a well-formed set-strip mark.
 * Every other template or state (steady / thin / locked / hidden / collapsed
 * and RatingMove) draws nothing.
 */
export type TrendsReadMarkKind = 'dumbbell' | 'sessionBuckets' | 'recordBar' | 'setStrip';

const ASSERTIVE_STATES: ReadonlySet<Insight['state']> = new Set(['trend', 'suggestion']);

export function trendsReadMarkKind(insight: Insight): TrendsReadMarkKind | null {
  switch (insight.templateId) {
    case 'tiltCost':
      return ASSERTIVE_STATES.has(insight.state) &&
        insight.recent.kind === 'evidenced' &&
        insight.baseline.kind === 'evidenced'
        ? 'dumbbell'
        : null;
    case 'sessionFatigue':
      return ASSERTIVE_STATES.has(insight.state) && readSessionBucketsMark(insight.mark) !== null
        ? 'sessionBuckets'
        : null;
    case 'bestMatchup':
    case 'worstMatchup':
      return insight.state === 'fact' && insight.recent.kind === 'evidenced' ? 'recordBar' : null;
    case 'lastEventRecap':
      return insight.state === 'fact' && readSetStripMark(insight.mark) !== null
        ? 'setStrip'
        : null;
    default:
      return null;
  }
}
