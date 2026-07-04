import { z } from 'zod';
import { matchStageSchema } from './stage.js';

/**
 * `matchType` is a free-form-looking field that is in practice constrained
 * to a fixed set of radio options in legacy's MatchTypeSelect.js /
 * EditMatchForm's MatchTypeSelect.js. Older records may have an empty
 * string when unset (see MatchTable.js coalescing `m.matchType ? m.matchType
 * : ""`), so `""` is accepted alongside the real options for stored/read
 * shapes.
 */
export const matchTypeValues = [
  'none',
  'quickplay',
  'online-friendly',
  'online-tourney',
  'offline-friendly',
  'offline-tourney',
] as const;
export const matchTypeSchema = z.enum(matchTypeValues);
export type MatchType = z.infer<typeof matchTypeSchema>;

/**
 * `matches/{uid}/{pushKey}` — the stored shape, derived verbatim from
 * legacy AddMatchForm.js `onSaveMatchClick` / EditMatchForm.js
 * `onSaveMatchClick` (both `.set()` the full record — legacy never used
 * `.update()` on matches). Field names are exactly as legacy wrote them and
 * MUST NOT be renamed: production data already exists under these keys.
 *
 * ```js
 * matchRef.set({
 *   fighter_id: playerOne.id,
 *   opponent_id: playerTwo.id,
 *   time: firebase.database.ServerValue.TIMESTAMP,
 *   map: mapDetails, // { id, name }
 *   opponent: opponent,
 *   notes: notes,
 *   matchType: selectedType,
 *   win: result === "win",
 * });
 * ```
 *
 * Older records may be missing `map`, `matchType`, `opponent`, `notes`
 * entirely (legacy readers defensively coalesce these) — modeled here as
 * optional so reads of legacy data don't fail validation.
 */
export const matchRecordSchema = z.object({
  /** SpriteList id of the tracked user's own fighter for this match. */
  fighter_id: z.number().int().positive(),
  /** SpriteList id of the opponent's in-game fighter (character, not the human opponent). */
  opponent_id: z.number().int().positive(),
  /** Unix epoch milliseconds. Written server-side via ServerValue.TIMESTAMP. */
  time: z.number().int().nonnegative(),
  /** Stage the match was played on; `{ id: 0, ... }` means "no selection". */
  map: matchStageSchema.optional(),
  /** Free-text human opponent name, always lowercased by the legacy client. */
  opponent: z.string().optional(),
  /** Free-text notes, legacy soft-capped client-side at 100 chars (not enforced server-side). */
  notes: z.string().optional(),
  matchType: matchTypeSchema.or(z.literal('')).optional(),
  /** true = win, false = loss. */
  win: z.boolean(),
  /**
   * The winner's remaining stock count when the match ended (0-3 for a
   * standard 4-stock game). Optional — legacy data and matches where the
   * player didn't track it omit this entirely.
   */
  stocksLeft: z.number().int().min(0).max(3).optional(),
  /**
   * Where this match came from. Absent on manually-entered matches (all
   * legacy data); 'startgg' on records imported from start.gg tournament
   * sets. Set server-side by the sync service only — never accepted from
   * client input (see createMatchInputSchema).
   */
  source: z.literal('startgg').optional(),
  /**
   * Stable idempotency key for imported records, e.g. 'sgg:<setId>:g<n>'.
   * Doubles as the RTDB child key (prefixed) so re-syncs overwrite instead
   * of duplicating.
   */
  externalId: z.string().optional(),
  /** Bracket/event name for imported matches (e.g. "Ultimate Singles"). Server-set. */
  eventName: z.string().optional(),
  /** Tournament name for imported matches (e.g. "The Big House 9"). Server-set. */
  tournamentName: z.string().optional(),
  /**
   * start.gg's human-readable round label for the set this game belonged to
   * (e.g. "Losers Round 2", "Winners Semi-Final"). Server-set, imported
   * matches only.
   */
  roundText: z.string().optional(),
  /**
   * start.gg's `set.round` — a signed integer where negative values mean the
   * losers side of a double-elimination bracket (e.g. -2 = Losers Round 2).
   * Server-set, imported matches only.
   */
  bracketRound: z.number().int().optional(),
});
export type MatchRecord = z.infer<typeof matchRecordSchema>;

/**
 * A match record as returned by the API, with its RTDB push key surfaced as
 * `id` (legacy attached this as `key` client-side; the API calls it `id`).
 */
export const matchSchema = matchRecordSchema.extend({
  id: z.string().min(1),
});
export type Match = z.infer<typeof matchSchema>;

/**
 * `opponents/{uid}/{opponentName}` uses the name as the literal RTDB key
 * (see opponent.ts), so it can't contain the characters RTDB reserves for
 * paths (`.`, `#`, `$`, `[`, `]`, `/`) or ASCII control characters. Legacy's
 * `AddMatchForm.js`/`EditMatchForm.js` always lowercase the name client-side
 * before writing (`updateOpponent`); the API is the sole write path now, so
 * this schema normalizes (trim + lowercase) and validates server-side too —
 * it must not rely on every caller replicating that client-side behavior.
 */
const RTDB_RESERVED_KEY_CHARS = ['.', '#', '$', '[', ']', '/'];

function containsRtdbIllegalChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i);
    if (codePoint !== undefined && codePoint <= 0x1f) {
      return true;
    }
  }
  return RTDB_RESERVED_KEY_CHARS.some((char) => value.includes(char));
}

const opponentNameInputSchema = z
  .string()
  .trim()
  .min(1, 'Opponent name is required')
  .transform((value) => value.toLowerCase())
  .refine((value) => !containsRtdbIllegalChar(value), {
    message: 'Opponent name cannot contain . # $ [ ] / or control characters',
  });

/**
 * A trimmed, 1-80 char optional free-text name field (`eventName` /
 * `tournamentName` on manual entry). An empty/whitespace-only string — the
 * shape a blank, untouched form field submits as — transforms to
 * `undefined` so the key is omitted from the parsed result entirely, rather
 * than sending `''` through to RTDB (which rejects `undefined` values on
 * write, but would happily persist a meaningless empty string).
 */
const optionalNameInputSchema = z
  .string()
  .trim()
  .max(80, 'Limit 80 characters')
  .optional()
  .transform((value) => (value ? value : undefined))
  .optional();

/**
 * POST /api/matches body. `time` is set server-side (mirrors legacy's use of
 * ServerValue.TIMESTAMP) so it is not accepted from the client. `map` is
 * required on create to match legacy's always-present mapDetails object
 * (defaulting to `{ id: 0, name: "no selection" }` client-side); callers
 * that don't have a stage should send that same sentinel.
 *
 * `stocksLeft`/`eventName`/`tournamentName` are optional manual-entry
 * additions (set wizard + tournament hint fields) — `source`/`externalId`
 * remain server-set only (see `matchRecordSchema`) and are intentionally
 * NOT accepted here.
 */
export const createMatchInputSchema = z.object({
  fighter_id: z.number().int().positive(),
  opponent_id: z.number().int().positive(),
  map: matchStageSchema,
  opponent: opponentNameInputSchema,
  notes: z.string().default(''),
  matchType: matchTypeSchema,
  win: z.boolean(),
  stocksLeft: z.number().int().min(0).max(3).optional(),
  eventName: optionalNameInputSchema,
  tournamentName: optionalNameInputSchema,
});
export type CreateMatchInput = z.infer<typeof createMatchInputSchema>;

/**
 * PATCH /api/matches/:id body. Legacy's edit form always re-`.set()`s every
 * field (full overwrite), so the API accepts the same full set of fields as
 * create; PATCH semantics here mean "identify by id in the URL", not
 * "partial update" — full field set is still required to keep behavior
 * identical to legacy's edit form.
 */
export const updateMatchInputSchema = createMatchInputSchema;
export type UpdateMatchInput = z.infer<typeof updateMatchInputSchema>;
