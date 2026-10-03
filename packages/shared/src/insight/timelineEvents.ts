import type { KnownTierWord, TierBasis } from '../tournamentTier.js';

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
