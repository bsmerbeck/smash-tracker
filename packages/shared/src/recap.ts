import { z } from 'zod';

/**
 * Phase 7 (Recap Cards & Share-Loop Analytics): `shareSnapshots/{shareId}`
 * storage shape for a `kind: 'recap'` share — a deterministic post-tournament
 * stats card, authored ONCE at share-creation time by `buildRecapSnapshot`
 * (apps/api/src/shares/buildRecapSnapshot.ts) from the caller's own
 * `tournamentEntries/{uid}/{entryKey}` + `matches/{uid}` — never re-derived
 * live afterward (mirrors `shareSnapshotSchema`'s SHARE-01 immutability
 * rule, see packages/shared/src/shares.ts). Every optional field is
 * `.nullish()` and every write uses the conditional-spread idiom, per the
 * same RTDB null-stripping rule `shares.ts`'s module doc establishes
 * (CONCERNS.md).
 *
 * Deliberately a SEPARATE object from `shareSnapshotSchema` (not merged into
 * it) — `RtdbService`'s recap read/write branches parse against this schema
 * directly, distinguishing a stored record by its own `kind: 'recap'`
 * literal before choosing which storage schema applies.
 */
export const recapSnapshotSchema = z.object({
  /** Owner uid — never surfaced in any public-facing response type. */
  uid: z.string(),
  /** Source tournament entry's routing key — private lifecycle reference only. */
  entryKey: z.string().min(1),
  /** Epoch ms the share was created — server-stamped. */
  createdAt: z.number().int().nonnegative(),
  kind: z.literal('recap'),
  /** Which site the source tournament entry came from. */
  source: z.enum(['startgg', 'parrygg']),
  tournamentName: z.string().min(1),
  /** Epoch ms — the entry's `firstSetAt`. */
  tournamentDate: z.number().int().nonnegative(),
  /** Omitted (not `null`) when the source entry has no placement. */
  placement: z.number().int().positive().nullish(),
  /** Omitted (not `null`) when the source entry has no seed. */
  seed: z.number().int().positive().nullish(),
  /** Omitted (not `null`) when the source entry has no entrant count. */
  numEntrants: z.number().int().positive().nullish(),
  setRecordWins: z.number().int().nonnegative(),
  setRecordLosses: z.number().int().nonnegative(),
  /**
   * The best-seeded opponent defeated (lowest `opponentSeed` among won
   * sets; tie -> the later set by `TournamentSet.time`). Omitted entirely
   * (not `null`) when zero sets were won, or no won set's opponent had a
   * known seed — never rendered as a fabricated/empty line.
   */
  notableWin: z
    .object({
      opponentName: z.string().min(1).nullish(),
      opponentSeed: z.number().int().positive(),
    })
    .nullish(),
  /** Distinct fighter ids the user played across the tournament, first-seen order. */
  characterFighterIds: z.array(z.number().int().positive()),
  /**
   * Count of VOD timestamp notes across the entry's matches — always
   * written, even when `0` (renderers omit the line; storage keeps the
   * number, same convention as `shareSnapshotSchema.reviewedMomentsCount`).
   */
  reviewedMomentsCount: z.number().int().nonnegative(),
  /** Opt-in only; absent unless the owner chose to show their display name. */
  ownerDisplayName: z.string().trim().max(60).nullish(),
});
export type RecapSnapshot = z.infer<typeof recapSnapshotSchema>;
