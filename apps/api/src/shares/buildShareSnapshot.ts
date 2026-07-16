import type { MatchRecord, ShareSnapshot } from '@smash-tracker/shared';

/** The three owner-chosen redaction toggles from `createShareInputSchema`. */
export interface ShareRedactionToggles {
  includeNotes: boolean;
  includeTags: boolean;
  showDisplayName: boolean;
}

/**
 * Builds a `ShareSnapshot` from the CURRENT state of `match` — called once,
 * at share-creation time, never again (SHARE-01: later edits to the source
 * match must never affect an issued link). The caller (RtdbService) is
 * responsible for validating `match.vodUrl` exists before calling this (a
 * VOD-less match isn't shareable) — this function assumes it's present.
 *
 * Every optional field uses the conditional-spread idiom: an excluded field
 * is an OMITTED key, never `null` or `[]` (CONCERNS.md RTDB null-stripping
 * rule; matches the existing `vodTimestamps`/`tags` convention on
 * `MatchRecord`). `redaction` and `reviewedMomentsCount` are always written
 * in full, regardless of which toggles were chosen.
 */
export function buildShareSnapshot(
  uid: string,
  matchId: string,
  match: MatchRecord,
  redaction: ShareRedactionToggles,
  ownerDisplayName?: string,
): ShareSnapshot {
  const vodTimestamps = match.vodTimestamps ?? [];

  return {
    uid,
    matchId,
    createdAt: Date.now(),
    result: match.win ? 'win' : 'loss',
    fighterId: match.fighter_id,
    opponentFighterId: match.opponent_id,
    ...(match.map ? { stage: match.map } : {}),
    matchDate: match.time,
    // Caller guarantees match.vodUrl is present before calling this.
    vodUrl: match.vodUrl as string,
    ...(match.vodStartSeconds !== undefined ? { vodStartSeconds: match.vodStartSeconds } : {}),
    reviewedMomentsCount: vodTimestamps.length,
    ...(redaction.includeNotes && vodTimestamps.length > 0
      ? {
          timestamps: vodTimestamps.map(({ seconds, note, tags }) => ({
            seconds,
            note,
            ...(tags && tags.length > 0 ? { tags } : {}),
          })),
        }
      : {}),
    ...(redaction.includeTags && match.tags && match.tags.length > 0 ? { tags: match.tags } : {}),
    ...(redaction.showDisplayName && ownerDisplayName ? { ownerDisplayName } : {}),
    redaction: {
      includedNotes: redaction.includeNotes,
      includedTags: redaction.includeTags,
      // Effective value ("was a name actually included"), not the raw
      // toggle — a signed-in user with no displayName set still has the
      // toggle at `true`, but no ownerDisplayName field is ever written
      // above; this must agree with that, or the manage-list "Name" chip
      // (ShareRow.tsx) lies about what was shared (review WR-01).
      showDisplayName: Boolean(redaction.showDisplayName && ownerDisplayName),
    },
  };
}
