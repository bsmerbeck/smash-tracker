import { z } from 'zod';

/**
 * RTDB data model — derived from legacy/src (see per-domain files in this
 * package for exact write-site provenance). Summary:
 *
 * - `users/{uid}`                              -> { email }
 * - `primaryFighters/{uid}`                    -> number[] (fighter ids)
 * - `secondaryFighters/{uid}`                  -> number[] (fighter ids)
 * - `matches/{uid}/{pushKey}`                  -> MatchRecord (see match.ts)
 * - `opponents/{uid}/{opponentName}`           -> true (set-membership map)
 *
 * Field names are preserved exactly as legacy wrote them (e.g. `fighter_id`,
 * `opponent_id`, snake_case) because production data already exists under
 * these keys. See packages/shared/README.md for the full writeup.
 */

export const healthCheckSchema = z.object({
  status: z.literal('ok'),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export * from './fighter.js';
export * from './stage.js';
export * from './user.js';
export * from './match.js';
export * from './opponent.js';
export * from './error.js';
export * from './startgg.js';
export * from './scoutMerge.js';
export * from './parrygg.js';
export * from './fighterData.js';
export * from './stageData.js';
export * from './stageFavorites.js';
export * from './reports.js';
export * from './glicko.js';
export * from './groups.js';
export * from './billing.js';
export * from './meta.js';
export * from './matchupAdvisor.js';
export * from './gsp.js';
export * from './gspReading.js';
export * from './gspMmr.js';
export * from './gspTiers.js';
export * from './gspLive.js';
export * from './playlist.js';
export * from './shares.js';
export * from './tournamentAggregation.js';
export * from './recap.js';
