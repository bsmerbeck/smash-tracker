import { z } from 'zod';

/**
 * V17 (community request): a standalone GSP reading — "set my GSP to X right
 * now" — with NO match attached, stored under `gspReadings/{uid}/{pushKey}`.
 *
 * Why it exists: GSP inflates between sessions (the model's rising ceiling
 * means a rested character's number jumps on the first match of a new
 * session), and players also eat matches under silly custom rulesets they
 * don't want polluting their stats. Without a way to re-baseline, the next
 * REAL match's delta absorbs all of that drift and corrupts the average
 * gain/loss numbers. A calibration reading resets the baseline: the step
 * INTO it is ignored by the stats (see `toSteps` in gsp.ts), while the step
 * OUT of it to the next match is a clean, attributable delta.
 *
 * Like GSP on matches, readings are PER FIGHTER (`fighter_id` matches the
 * match schema's naming).
 */
export const gspReadingRecordSchema = z.object({
  fighter_id: z.number().int().positive(),
  /** The GSP shown in-game at the moment of the reading. */
  gsp: z.number().int().min(0),
  /** Epoch ms the reading was taken — server-stamped on create. */
  time: z.number(),
});
export type GspReadingRecord = z.infer<typeof gspReadingRecordSchema>;

/** A reading with its RTDB push key, as returned by the API. */
export const gspReadingSchema = gspReadingRecordSchema.extend({
  id: z.string(),
});
export type GspReading = z.infer<typeof gspReadingSchema>;

/** POST /api/gsp-readings body — `time` is server-stamped (same convention as match create). */
export const createGspReadingInputSchema = gspReadingRecordSchema.omit({ time: true });
export type CreateGspReadingInput = z.infer<typeof createGspReadingInputSchema>;

/**
 * PATCH /api/gsp-readings/:id body — only the value is correctable (a
 * flubbed digit); `time` keeps the original moment, mirroring updateMatch's
 * "editing corrects a record, it doesn't re-date it" rule, and the fighter
 * is fixed (a reading for the wrong fighter is a delete + re-create).
 */
export const updateGspReadingInputSchema = z.object({
  gsp: z.number().int().min(0),
});
export type UpdateGspReadingInput = z.infer<typeof updateGspReadingInputSchema>;
