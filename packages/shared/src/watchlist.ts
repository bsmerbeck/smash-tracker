import { z } from 'zod';
import type { Match } from './match.js';
import { opponentNameInputSchema } from './opponent.js';
import { resolveOpponentIdentities } from './evidence/opponentEvidence.js';
import { stageBucketId } from './evidence/predicate.js';
import type { InsightScope } from './insight/types.js';

/**
 * Phase 39.2 (T-02): the watchlist — the opponents, fighter matchups and stages a
 * player asked the app to keep an eye on. This module is the pure contract:
 * the item model, its deterministic RTDB-safe key, the wire schemas and the
 * `InsightScope` each item reads its form through. It carries no clock, no
 * storage and no route; `apps/api` (plan 39.2-05) owns the tree.
 *
 * Stored shape (`watchlist/{subjectId}/{itemKey}`): a KEYED MAP, never an
 * array. RTDB strips `null` members inside arrays on write and reads back a
 * sparse/short array (the production incident this codebase documents), so a
 * positional list cannot round-trip; a map whose keys start with a letter can
 * never be coerced into an array either (`ruleset.ts`'s `stageIdKey` idiom).
 * The wire response is a plain array of `{ itemKey, item }` — an array is fine
 * on the wire, it is only the STORED tree that must stay a map.
 */

/** T-02: at most this many tracked items per subject (also the digest snapshot's key cap). */
export const WATCHLIST_MAX_ITEMS = 25;

/** The three things a player can track, in the order the Track toggles appear. */
export const WATCHLIST_ITEM_KINDS = ['opponent', 'matchup', 'stage'] as const;
export type WatchlistItemKind = (typeof WATCHLIST_ITEM_KINDS)[number];

/** T-39.2-09: `note` is capped; it has no UI in this phase. */
const WATCHLIST_NOTE_MAX_LENGTH = 280;

/** An opponent tag is a free-text RTDB key segment elsewhere; the watchlist bounds it so a key stays short. */
const WATCHLIST_OPPONENT_TAG_MAX_LENGTH = 80;

/** Generous ceiling on a whole itemKey (`opponent:` + the longest tag). */
const WATCHLIST_ITEM_KEY_MAX_LENGTH = 100;

/**
 * Every key `buildWatchlistItemKey` can produce. The kind prefix is a letter
 * run, so the map can never be coerced into an array; the opponent segment
 * excludes the six characters RTDB reserves in a path (`. # $ [ ] /`).
 * Control characters cannot be excluded in a regex literal without tripping
 * `no-control-regex`, so `watchlistItemKeySchema` refines them separately.
 */
export const WATCHLIST_ITEM_KEY_PATTERN = /^(?:opponent:[^.#$[\]/]+|matchup:\d+-\d+|stage:\d+)$/;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The persisted/wire key of one tracked item, validated (pattern, length, no control character). */
export const watchlistItemKeySchema = z
  .string()
  .max(WATCHLIST_ITEM_KEY_MAX_LENGTH)
  .regex(WATCHLIST_ITEM_KEY_PATTERN, 'invalid watchlist item key')
  .refine((key) => !hasControlCharacter(key), {
    message: 'watchlist item key has a control character',
  });

/** An opponent ref is the canonical tag: the SAME normalisation and illegal-character refusal `opponentNameInputSchema` applies, plus a length bound. */
const watchlistOpponentRefSchema = opponentNameInputSchema.refine(
  (tag) => tag.length <= WATCHLIST_OPPONENT_TAG_MAX_LENGTH,
  { message: 'Opponent name is limited to 80 characters' },
);

const watchlistMatchupRefSchema = z.object({
  fighterId: z.number().int().positive(),
  vsFighterId: z.number().int().positive(),
});

/** A stage ref is a real stage id; the id-0 "no selection" sentinel is not trackable. */
const watchlistStageRefSchema = z.number().int().positive();

/**
 * `watchlist/{subjectId}/{itemKey}` — the STORED item. `note` is `.nullish()`
 * (never `.optional()`/`.nullable()` alone — the `260725-juj` outage shape);
 * every writer conditional-spreads it so an absent note is omitted, never
 * written as `null`.
 */
export const watchlistItemStoredSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opponent'),
    ref: watchlistOpponentRefSchema,
    createdAt: z.number().int().nonnegative(),
    note: z.string().max(WATCHLIST_NOTE_MAX_LENGTH).nullish(),
  }),
  z.object({
    kind: z.literal('matchup'),
    ref: watchlistMatchupRefSchema,
    createdAt: z.number().int().nonnegative(),
    note: z.string().max(WATCHLIST_NOTE_MAX_LENGTH).nullish(),
  }),
  z.object({
    kind: z.literal('stage'),
    ref: watchlistStageRefSchema,
    createdAt: z.number().int().nonnegative(),
    note: z.string().max(WATCHLIST_NOTE_MAX_LENGTH).nullish(),
  }),
]);
export type WatchlistItem = z.infer<typeof watchlistItemStoredSchema>;

/**
 * PUT body for tracking one item. The client sends `kind` and `ref` only:
 * `createdAt` is server-stamped and `itemKey` is derived server-side from this
 * validated body (unknown keys are stripped), so a client can never choose a
 * storage key. A per-item body (never a whole-list replace) means there is no
 * body built from an unresolved read.
 */
export const watchlistTrackInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opponent'), ref: watchlistOpponentRefSchema }),
  z.object({ kind: z.literal('matchup'), ref: watchlistMatchupRefSchema }),
  z.object({ kind: z.literal('stage'), ref: watchlistStageRefSchema }),
]);
export type WatchlistTrackInput = z.infer<typeof watchlistTrackInputSchema>;

/**
 * The deterministic storage key for an item: `opponent:<tag>`,
 * `matchup:<fighterId>-<vsFighterId>` or `stage:<stageId>`. Derived only from
 * a schema-validated ref, so it always matches `WATCHLIST_ITEM_KEY_PATTERN`.
 */
export function buildWatchlistItemKey(input: WatchlistTrackInput): string {
  switch (input.kind) {
    case 'opponent':
      return `opponent:${input.ref}`;
    case 'matchup':
      return `matchup:${input.ref.fighterId}-${input.ref.vsFighterId}`;
    case 'stage':
      return `stage:${input.ref}`;
  }
}

/** GET /api/watchlist response: an array on the wire; the stored tree stays a keyed map. */
export const watchlistResponseSchema = z.object({
  items: z.array(z.object({ itemKey: watchlistItemKeySchema, item: watchlistItemStoredSchema })),
});
export type WatchlistResponse = z.infer<typeof watchlistResponseSchema>;

/** PUT /api/watchlist/items response. */
export const watchlistTrackResponseSchema = z.object({
  itemKey: watchlistItemKeySchema,
  item: watchlistItemStoredSchema,
});
export type WatchlistTrackResponse = z.infer<typeof watchlistTrackResponseSchema>;

/**
 * The `InsightScope` an item's form is read through — the scope the digest's
 * `formNow` read and the Tracked row share. Each `filter` selects exactly what
 * the page hosting that item's Track toggle selects:
 * - opponent: the opponent hub's technique — `resolveOpponentIdentities` over
 *   the matches with the alias map, keeping matches whose resolved identity
 *   is the tag's (`OpponentHubPage.tsx`); `opponentAliases` are the alias
 *   names that fold into this canonical tag.
 * - matchup: the Matchups pairing filter, `fighter_id === f && opponent_id === v`.
 * - stage: the stage detail page's bucket, `stageBucketId(match) === stageId`
 *   (an absent `map` is the unknown-stage bucket, never a tracked stage).
 * Plan 39.2-11 adds the web-side equality test against the pages' own filters.
 */
export function trackedItemScope(
  item: WatchlistItem,
  options?: { opponentAliases?: readonly string[] },
): InsightScope {
  switch (item.kind) {
    case 'opponent': {
      const tag = item.ref;
      const aliases = options?.opponentAliases ?? [];
      return {
        kind: 'player',
        key: `player:${tag}`,
        axes: { opponent: tag },
        filter: (matches: Match[]): Match[] => {
          const aliasMap: Record<string, string> = {};
          for (const alias of aliases) {
            const normalized = alias.trim().toLowerCase();
            if (normalized.length > 0 && normalized !== tag) {
              aliasMap[normalized] = tag;
            }
          }
          const resolve = resolveOpponentIdentities(matches, aliasMap);
          const target = resolve({ opponent: tag });
          return matches.filter((match) => resolve(match) === target);
        },
      };
    }
    case 'matchup': {
      const { fighterId, vsFighterId } = item.ref;
      return {
        kind: 'character',
        key: `matchup:${fighterId}-${vsFighterId}`,
        axes: { fighter: fighterId, vs: vsFighterId },
        filter: (matches: Match[]): Match[] =>
          matches.filter(
            (match) => match.fighter_id === fighterId && match.opponent_id === vsFighterId,
          ),
      };
    }
    case 'stage': {
      const stageId = item.ref;
      return {
        kind: 'stage',
        key: `stage:${stageId}`,
        axes: { stage: stageId },
        filter: (matches: Match[]): Match[] =>
          matches.filter((match) => stageBucketId(match) === stageId),
      };
    }
  }
}
