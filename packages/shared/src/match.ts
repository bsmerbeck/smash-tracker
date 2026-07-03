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
 * POST /api/matches body. `time` is set server-side (mirrors legacy's use of
 * ServerValue.TIMESTAMP) so it is not accepted from the client. `map` is
 * required on create to match legacy's always-present mapDetails object
 * (defaulting to `{ id: 0, name: "no selection" }` client-side); callers
 * that don't have a stage should send that same sentinel.
 */
export const createMatchInputSchema = z.object({
  fighter_id: z.number().int().positive(),
  opponent_id: z.number().int().positive(),
  map: matchStageSchema,
  opponent: z.string().min(1),
  notes: z.string().default(''),
  matchType: matchTypeSchema,
  win: z.boolean(),
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
