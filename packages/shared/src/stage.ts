import { z } from 'zod';

/**
 * Reference data for a single stage, derived from
 * legacy/src/components/Stages/StageList.js.
 */
export const stageSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
  url: z.string(),
});
export type Stage = z.infer<typeof stageSchema>;

/**
 * The `map` field embedded in a match record is a reduced projection of a
 * Stage (id + name only, no url) — see AddMatchForm.js `onSaveMatchClick`:
 * `mapDetails = { id: stage.id, name: stage.name }`. `id: 0` with
 * `name: "no selection"` (create) or `name: "unknown"` (edit) represents "no
 * stage chosen".
 */
export const matchStageSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
});
export type MatchStage = z.infer<typeof matchStageSchema>;
