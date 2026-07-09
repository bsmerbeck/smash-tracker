import { z } from 'zod';
import { StageList, stagesById } from './stageData.js';

/**
 * `stageFavorites/{uid}` — the user's favorited stages, pinned to the top of
 * every stage picker so the handful of stages they actually play on (e.g.
 * Small Battlefield / Battlefield / the generic hazardless forms for Elite
 * Smash grinders) don't have to be scrolled to on every match log.
 *
 * `stageIds` preserves the order the user favorited them in — that order is
 * what pickers render, so it doubles as a user-chosen priority order.
 * `.default([])` matters for reads: RTDB silently drops empty arrays on
 * write, so a user who removed their last favorite reads back as
 * `{ updatedAt }` with no `stageIds` key at all.
 */
export const stageFavoritesSchema = z.object({
  /** Favorited stage ids in user-chosen (insertion) order. */
  stageIds: z.array(z.number().int().positive()).default([]),
  /** Epoch ms this was last saved — server-stamped, same convention as `gspSettingsSchema`. */
  updatedAt: z.number(),
});
export type StageFavorites = z.infer<typeof stageFavoritesSchema>;

/**
 * PUT /api/stage-favorites body — the full replacement list (`updatedAt` is
 * server-stamped). Ids must be real stages from `StageList`; the id-0
 * "no selection" sentinel is not favoritable (it's already pinned first in
 * every picker). Duplicates are tolerated and deduped server-side
 * (first-occurrence-wins) rather than rejected.
 */
export const upsertStageFavoritesInputSchema = z.object({
  stageIds: z
    .array(z.number().int().positive())
    .max(StageList.length, 'Too many favorites')
    .refine((ids) => ids.every((id) => stagesById.has(id)), {
      message: 'Unknown stage id',
    }),
});
export type UpsertStageFavoritesInput = z.infer<typeof upsertStageFavoritesInputSchema>;
