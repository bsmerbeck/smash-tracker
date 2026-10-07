import { TIER_LEVEL, type KnownTierWord, type TierBasis } from '../tournamentTier.js';

/**
 * UI-SPEC §7.9 (marker) / DD-41-09 / B2: the contract of the career-timeline event diamonds — each
 * marker is a view of a resolved tier entry (`key` = `entryKey`), never a second event identity.
 * Interface-first (plan 41-01): final exported types and bound constants only; plan 41-04 adds
 * `selectTimelineEventMarkers` to this same file.
 */

/** At most this many diamonds are drawn on the timeline; the rest live in Recent events. */
export const TIMELINE_EVENT_MARKER_MAX = 40;

export interface TimelineEventCandidate {
  /** The resolved tier entry's `entryKey`. */
  key: string;
  label: string;
  atMs: number;
  wins: number;
  losses: number;
  tier: KnownTierWord;
  basis: TierBasis;
  /** `TIER_LEVEL[tier]`. */
  level: number;
  entrants: number | null;
  /** The rating after the event, or null when no rating is plotted at that time. */
  ratingAfter: number | null;
}

export interface TimelineEventSelection {
  /** Ascending `atMs`. */
  markers: TimelineEventCandidate[];
  shown: number;
  total: number;
}

export interface SelectTimelineEventMarkersOptions {
  /** Inclusive minimum `TIER_LEVEL` a candidate needs to be marked. */
  minLevel: number;
  /** Defaults to `TIMELINE_EVENT_MARKER_MAX`. */
  max?: number;
}

/**
 * DD-41-09 / B2: the diamonds one timeline draws. Keeps candidates whose `level` reaches `minLevel`;
 * when more than `max` qualify, every supermajor is kept first (the most recent ones if they alone
 * exceed `max`) and the remaining room is filled with the most recent of the rest. Pure — returns
 * ascending `atMs`, how many are `shown` and how many `total` qualified.
 */
export function selectTimelineEventMarkers(
  candidates: readonly TimelineEventCandidate[],
  options: SelectTimelineEventMarkersOptions,
): TimelineEventSelection {
  const max = options.max ?? TIMELINE_EVENT_MARKER_MAX;
  const qualifying = candidates.filter((candidate) => candidate.level >= options.minLevel);
  const total = qualifying.length;
  const byRecency = (a: TimelineEventCandidate, b: TimelineEventCandidate) =>
    b.atMs - a.atMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  let kept: TimelineEventCandidate[];
  if (total <= max) {
    kept = qualifying;
  } else {
    const top = qualifying.filter((candidate) => candidate.level === TIER_LEVEL.supermajor);
    const rest = qualifying.filter((candidate) => candidate.level !== TIER_LEVEL.supermajor);
    kept = [...top].sort(byRecency).slice(0, max);
    kept = [...kept, ...[...rest].sort(byRecency).slice(0, Math.max(0, max - kept.length))];
  }
  const markers = [...kept].sort(
    (a, b) => a.atMs - b.atMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { markers, shown: markers.length, total };
}
