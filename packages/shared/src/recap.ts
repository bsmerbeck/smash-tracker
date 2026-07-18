import { z } from 'zod';

/**
 * Phase 7 walkthrough amendment round 2 (07-10, 2026-07-17): one GAME within
 * a set's generation-time timeline — the character matchup and stage played,
 * so a recap can show "what did I play, on which stage, and did I win THAT
 * game" instead of only an aggregate set score. Stored ONLY inside
 * `recapSetSchema.games` (07-09's set-level `stages` array is left untouched
 * for backward compatibility with every pre-07-10 stored snapshot). Every
 * field is `.nullish()` — a game missing a fighter/stage selection (start.gg
 * sync gaps, manual-entry-adjacent edge cases) simply omits that one field
 * rather than failing the whole set's timeline.
 */
export const recapGameSchema = z.object({
  /** The tracked user's fighter id for this game. Omitted when unknown/unmapped. */
  fighterId: z.number().int().positive().nullish(),
  /** The opponent's fighter id for this game. Omitted when unknown/unmapped. */
  opponentFighterId: z.number().int().positive().nullish(),
  /** The stage NAME played, when known — stage id 0 ("no selection") is never stored here. */
  stageName: z.string().min(1).nullish(),
  /** Whether the tracked user won this individual game. Omitted when unknown. */
  win: z.boolean().nullish(),
});
export type RecapGame = z.infer<typeof recapGameSchema>;

/**
 * Phase 7 walkthrough amendment (07-09, 2026-07-17): one set of the
 * generation-time set timeline — round label, opponent, game score, and the
 * stages played — stored ONLY when the recap was generated with
 * `detail: 'full'` (see `recapSnapshotSchema.sets` below). Authored from
 * scratch (not a reprojection of `TournamentSet`) so the storage shape is
 * independent of `packages/shared/src/tournamentAggregation.ts`'s internal
 * fields. Opponent tag/placement/stages are PUBLIC BRACKET DATA (unlike a
 * VOD-review snapshot's opponent identity) — deliberate inclusion, per
 * 07-CONTEXT.md's Walkthrough Amendment; private notes/uid/matchIds are
 * never part of this shape.
 */
export const recapSetSchema = z.object({
  /** The set's round label — the source site's own text when known, else a positional "Set N" fallback (buildRecapSnapshot). */
  roundLabel: z.string().min(1),
  /** The human opponent's free-text tag; "Unknown opponent" when the source data never captured one. */
  opponentName: z.string().min(1),
  /** Omitted (not `null`) when the opponent's final event placement isn't knowable (parry.gg entries, or no matching standings row). */
  opponentPlacement: z.number().int().positive().nullish(),
  /** Games won by the tracked user in this set. */
  wins: z.number().int().nonnegative(),
  /** Games lost by the tracked user in this set. */
  losses: z.number().int().nonnegative(),
  /** Whether the tracked user won the set overall. */
  win: z.boolean(),
  /** Distinct stage NAMES played across the set's games, first-seen order; stage id 0 ("no selection") is never included. Omitted (not `[]`) when no game carried a real stage. */
  stages: z.array(z.string().min(1)).max(10).nullish(),
  /**
   * Walkthrough amendment round 2 (07-10): per-game character+stage detail
   * — one entry per game in the set, in game-number order. Omitted (not
   * `[]`) for a pre-07-10 stored snapshot (never backfilled) and for any set
   * whose games couldn't be enumerated. Capped at 10 (a realistic worst-case
   * "first to 10" set has at most 10 games — see `recapSetSchema.stages`'s
   * own identical cap for the same rationale).
   */
  games: z.array(recapGameSchema).max(10).nullish(),
});
export type RecapSet = z.infer<typeof recapSetSchema>;

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
  /**
   * Walkthrough amendment (07-09): which generation mode produced this
   * snapshot. Absent means `'summary'` — every recap created before this
   * plan, and the deliberate storage convention for a summary-only
   * generation going forward (mirrors `kind`'s own absent-means-review
   * convention). Only ever written as the literal `'full'`; `'summary'` is
   * never stored (conditional-spread — see `buildRecapSnapshot`).
   */
  detail: z.enum(['summary', 'full']).nullish(),
  /**
   * External event page on the source site (start.gg/parry.gg), public and
   * auth-wall-free. ONLY populated when trustworthily derivable from STORED
   * registry fields — start.gg entries build it from `eventSlug`/`slug`
   * (mirrors `apps/web`'s `buildEventStartggUrl`); parry.gg's public event-URL
   * shape is unverified (07-CONTEXT.md's Walkthrough Amendment: "do NOT
   * invent parry.gg URL shapes"), so parry.gg entries never carry this field.
   */
  tournamentUrl: z.string().url().nullish(),
  /**
   * The full chronological set timeline, stored ONLY when `detail === 'full'`
   * (never alongside `detail` absent/`'summary'` — a `'summary'` generation
   * never computes or stores this). Capped at 20 (recapSetSchema's own
   * array max) — `buildRecapSnapshot` keeps the MOST RECENT 20 sets when a
   * run has more (the bracket climax, not the earliest pool sets).
   */
  sets: z.array(recapSetSchema).max(20).nullish(),
});
export type RecapSnapshot = z.infer<typeof recapSnapshotSchema>;
