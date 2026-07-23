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
  /**
   * SETFEAT-02: which form of the stage was played — its normal layout, or
   * (for stages that support it) Battlefield/Omega form. User-set at entry
   * time on both the single-game form and the set wizard; consumed by no
   * analytics/display code this phase (deferred per 18-CONTEXT.md). Optional
   * and MUST be omitted (never `undefined`) when unset — RTDB rejects an
   * `undefined` value on write, so callers building this object follow the
   * same conditional-spread convention as every other optional field on
   * `matchRecordSchema` (see CONCERNS.md).
   */
  form: z.enum(['normal', 'battlefield', 'omega']).optional(),
});
export type MatchStage = z.infer<typeof matchStageSchema>;
