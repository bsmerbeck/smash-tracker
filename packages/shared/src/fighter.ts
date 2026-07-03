import { z } from 'zod';

/**
 * Reference data for a single fighter (character), derived from
 * legacy/src/components/Sprites/SpriteList.js. `id` is a small positive
 * integer that is stored directly in match records (`fighter_id`,
 * `opponent_id`) and in the `primaryFighters` / `secondaryFighters` arrays,
 * so these ids MUST remain stable.
 */
export const fighterSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  url: z.string(),
});
export type Fighter = z.infer<typeof fighterSchema>;

/**
 * `primaryFighters/{uid}` and `secondaryFighters/{uid}` are each stored as a
 * flat array of fighter ids (see legacy PrimarySelect.js / SecondarySelect.js
 * `.set(_spriteIds)` calls, which overwrite the whole array).
 */
export const fighterIdListSchema = z.array(z.number().int().positive());
export type FighterIdList = z.infer<typeof fighterIdListSchema>;

/**
 * Shape of a user's fighter selections as stored/returned by the API:
 * GET/PUT /api/users/me/fighters.
 */
export const fighterSelectionSchema = z.object({
  primary: fighterIdListSchema,
  secondary: fighterIdListSchema,
});
export type FighterSelection = z.infer<typeof fighterSelectionSchema>;

/**
 * PUT /api/users/me/fighters body. Same shape as the stored selection;
 * either array may be omitted to leave that half unchanged is NOT supported
 * by legacy semantics (both selects always `.set()` the full array), so both
 * fields are required here to match legacy overwrite behavior.
 */
export const fighterSelectionInputSchema = fighterSelectionSchema;
export type FighterSelectionInput = z.infer<typeof fighterSelectionInputSchema>;
