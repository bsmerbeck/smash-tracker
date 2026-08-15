import { RESEARCH_ENRICHMENT_MAX_RAW_TEXT } from '@smash-tracker/shared';
import { clampUntrustedText } from './observationBounds.js';

/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): the shared
 * player-slot classifier every Liquipedia adapter routes a would-be
 * `players[].rawTag` value through before an observation is built.
 *
 * THE DEFECT THIS MODULE CLOSES: the production MkLeo apply aborted at the
 * write boundary because a legacy bracket page carried PRESENT-BUT-EMPTY
 * player parameters (`...p1=|...p2=|...`), which the adapters emitted
 * verbatim as `rawTag: ""` — rejected by the persistence schema's
 * `min(1)` bound only at the moment of the write. Classification therefore
 * happens HERE, at extraction time: a slot that is missing, empty,
 * whitespace-only, or a TBD/bye placeholder is UNUSABLE, and the adapter
 * must emit the observation as an explicit extraction failure WITHOUT
 * `players` — never a fabricated tag, never an empty one.
 *
 * Pure, no I/O, no clock — callable identically from every adapter and
 * from a unit test.
 */

/**
 * Bracket-slot placeholder markers observed on the smash wiki: `TBD` (an
 * undecided slot) and `Bye`/`BYE` (a bye slot). Compared case-insensitively
 * against the TRIMMED tag. Deliberately a small closed set — an unlisted
 * marker is a real (if odd) tag, and inventing broader heuristics would
 * risk discarding genuine player tags.
 */
const PLAYER_TAG_PLACEHOLDERS: ReadonlySet<string> = new Set(['tbd', 'bye']);

export type PlayerSlotUnusableReason = 'missing' | 'empty' | 'placeholder';

export type ClassifiedPlayerSlot =
  | { usable: true; tag: string }
  | { usable: false; reason: PlayerSlotUnusableReason; detail: string };

/**
 * Classifies one raw player parameter value. A usable slot returns the
 * TRIMMED tag, additionally clamped to the persistence schema's raw-text cap
 * so an overlength wiki value can never fail the schema's `max` bound at
 * the write boundary (same defect class as the empty tag, other direction).
 */
export function classifyPlayerTag(raw: string | undefined): ClassifiedPlayerSlot {
  if (raw === undefined) {
    return { usable: false, reason: 'missing', detail: 'player parameter is absent' };
  }
  const tag = raw.trim();
  if (!tag) {
    return {
      usable: false,
      reason: 'empty',
      detail: 'player parameter is present but empty or whitespace-only',
    };
  }
  if (PLAYER_TAG_PLACEHOLDERS.has(tag.toLowerCase())) {
    return {
      usable: false,
      reason: 'placeholder',
      detail: `player slot holds the placeholder "${tag}" (TBD/bye), not a real player`,
    };
  }
  return { usable: true, tag: clampUntrustedText(tag, RESEARCH_ENRICHMENT_MAX_RAW_TEXT) };
}
