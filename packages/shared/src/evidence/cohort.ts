import type { Match } from '../match.js';
import { MIXED_CONTEXT_THRESHOLD } from './policy.js';

/**
 * The six mutually-exclusive-within-their-own-axis buckets `describeCohort`
 * tallies: `online`/`offline`/`unspecified` partition a sample by session
 * type, `manual`/`startgg`/`parrygg` partition the SAME sample by
 * provenance. A composition never claims a bucket outside these six.
 */
export type CohortLabel = 'online' | 'offline' | 'unspecified' | 'manual' | 'startgg' | 'parrygg';

export interface CohortComposition {
  online: number;
  offline: number;
  unspecified: number;
  manual: number;
  startgg: number;
  parrygg: number;
  /** True when either axis (session type or provenance) has a minority bucket at or above `MIXED_CONTEXT_THRESHOLD` of the total. */
  mixedContext: boolean;
  /** The winning axis's minority share (0 when `mixedContext` is false). */
  minorityShare: number;
  minorityLabel: CohortLabel | null;
  majorityLabel: CohortLabel | null;
}

interface Bucket {
  label: CohortLabel;
  count: number;
}

interface AxisSummary {
  majority: Bucket | null;
  minority: Bucket | null;
  minorityShare: number;
}

/**
 * Sorts one axis's populated buckets by count descending: the majority is
 * the largest, the minority is the smallest — `null` for either when the
 * axis has fewer than two populated buckets (nothing to call a minority
 * against) or the sample is empty.
 */
function summarizeAxis(buckets: Bucket[], total: number): AxisSummary {
  const populated = buckets.filter((b) => b.count > 0);
  if (populated.length === 0 || total === 0) {
    return { majority: null, minority: null, minorityShare: 0 };
  }
  const sorted = [...populated].sort((a, b) => b.count - a.count);
  const majority = sorted[0]!;
  const minority = sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : null;
  return { majority, minority, minorityShare: minority ? minority.count / total : 0 };
}

/**
 * EVID-02/D-10: reports the match sample's session-type (online/offline/
 * unspecified) and provenance (manual/startgg/parrygg) composition. The
 * engine never auto-splits a cohort — it reports composition and a
 * `mixedContext` flag and leaves the pooled aggregate intact; a caller that
 * wants to act on the split does so explicitly (this phase renders neither
 * split — see the `<threat_model>`'s T-36-01-04 disposition).
 *
 * Session-type branching reuses `getOnlineOfflineSplit`'s exact rule
 * ('quickplay' or a `matchType` starting with 'online' is online, starting
 * with 'offline' is offline, anything else — including the legacy empty
 * string — is unspecified) so the two can never disagree. `source` is
 * compared by exact equality against the literals 'startgg' and 'parrygg',
 * with an absent `source` counted as 'manual' — no case folding, no
 * trimming.
 *
 * `mixedContext` is true when EITHER axis's minority bucket share is >=
 * `MIXED_CONTEXT_THRESHOLD` (inclusive at exactly 0.25 — EVID-02/adjacency).
 * When both axes qualify, the session-type axis's minority/majority/share
 * is reported (a deterministic but otherwise arbitrary tie-break — nothing
 * in Phase 36 renders this pair, D-13's visible-change cap).
 */
export function describeCohort(matches: Match[]): CohortComposition {
  let online = 0;
  let offline = 0;
  let unspecified = 0;
  let manual = 0;
  let startgg = 0;
  let parrygg = 0;

  for (const match of matches) {
    const type = match.matchType ?? '';
    if (type === 'quickplay' || type.startsWith('online')) {
      online += 1;
    } else if (type.startsWith('offline')) {
      offline += 1;
    } else {
      unspecified += 1;
    }

    if (match.source === 'startgg') {
      startgg += 1;
    } else if (match.source === 'parrygg') {
      parrygg += 1;
    } else {
      manual += 1;
    }
  }

  const total = matches.length;
  const session = summarizeAxis(
    [
      { label: 'online', count: online },
      { label: 'offline', count: offline },
    ],
    total,
  );
  const source = summarizeAxis(
    [
      { label: 'manual', count: manual },
      { label: 'startgg', count: startgg },
      { label: 'parrygg', count: parrygg },
    ],
    total,
  );

  const sessionMixed =
    session.minority !== null && session.minorityShare >= MIXED_CONTEXT_THRESHOLD;
  const sourceMixed = source.minority !== null && source.minorityShare >= MIXED_CONTEXT_THRESHOLD;
  const winner = sessionMixed ? session : sourceMixed ? source : null;

  return {
    online,
    offline,
    unspecified,
    manual,
    startgg,
    parrygg,
    mixedContext: sessionMixed || sourceMixed,
    minorityShare: winner?.minorityShare ?? 0,
    minorityLabel: winner?.minority?.label ?? null,
    majorityLabel: winner?.majority?.label ?? null,
  };
}
