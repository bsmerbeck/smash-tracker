import { z } from 'zod';

/**
 * `parrygg.gg` integration (V8-A) — a second tournament-site integration
 * alongside start.gg. Unlike start.gg (OAuth, `oauth.ts`), parry.gg exposes
 * NO OAuth flow at all: the server holds a single API key
 * (`PARRYGG_API_KEY`), and linking a player's own account is done by
 * identity lookup + a bio-text verification code (see `apps/api/src/routes/
 * parrygg.ts`), analogous in spirit to a DNS TXT-record domain check.
 *
 * RTDB layout:
 * - `parryggLinks/{uid}`            -> parryggLinkRecordSchema
 * - `parryggUserIndex/{parryUserId}` -> uid (reverse index; enforces one
 *   smash-tracker account per parry.gg account)
 * - `parryggVerifications/{uid}`    -> { code, expiresAt } (10-min TTL)
 */
export const parryggLinkRecordSchema = z.object({
  /** parry.gg user id (UUID v7). */
  parryUserId: z.string().min(1),
  gamerTag: z.string().min(1),
  avatarUrl: z.string().optional(),
  /** True once the bio-text verification code has been confirmed. */
  verified: z.boolean(),
  /** Epoch ms when the account was linked. */
  linkedAt: z.number().int().nonnegative(),
  /** Epoch ms when verification completed, absent until then. */
  verifiedAt: z.number().int().nonnegative().optional(),
  /** Epoch ms of the last completed sync, absent before the first sync. */
  lastSyncAt: z.number().int().nonnegative().optional(),
});
export type ParryggLinkRecord = z.infer<typeof parryggLinkRecordSchema>;

/** GET /api/integrations/parrygg/status response. */
export const parryggStatusSchema = z.object({
  linked: z.boolean(),
  gamerTag: z.string().optional(),
  parryUserId: z.string().optional(),
  avatarUrl: z.string().optional(),
  verified: z.boolean().optional(),
  lastSyncAt: z.number().int().nonnegative().optional(),
  /** True while an unexpired verification code is outstanding. */
  verificationPending: z.boolean().optional(),
});
export type ParryggStatus = z.infer<typeof parryggStatusSchema>;

/** One candidate returned by GET /api/integrations/parrygg/search. */
export const parryggSearchResultSchema = z.object({
  id: z.string().min(1),
  gamerTag: z.string().min(1),
  sponsorName: z.string().optional(),
  locationCountry: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type ParryggSearchResult = z.infer<typeof parryggSearchResultSchema>;

/** GET /api/integrations/parrygg/search response — capped to 10 candidates. */
export const parryggSearchResultListSchema = z.array(parryggSearchResultSchema).max(10);
export type ParryggSearchResultList = z.infer<typeof parryggSearchResultListSchema>;

/** POST /api/integrations/parrygg/link request body. */
export const parryggLinkRequestSchema = z.object({
  parryUserId: z.string().min(1),
});
export type ParryggLinkRequest = z.infer<typeof parryggLinkRequestSchema>;

/** POST /api/integrations/parrygg/verify/start response — also returned on repeat calls while unexpired. */
export const parryggVerificationStartResponseSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type ParryggVerificationStartResponse = z.infer<
  typeof parryggVerificationStartResponseSchema
>;

/** POST /api/integrations/parrygg/verify/complete response. */
export const parryggVerificationCompleteResponseSchema = z.object({
  verified: z.literal(true),
  verifiedAt: z.number().int().nonnegative(),
});
export type ParryggVerificationCompleteResponse = z.infer<
  typeof parryggVerificationCompleteResponseSchema
>;

/**
 * POST /api/integrations/parrygg/sync response — import summary. Mirrors
 * `startggSyncSummarySchema`'s shape, with parry.gg-specific skip counters
 * in place of start.gg's (see apps/api/src/parrygg/sync.ts for what each
 * counts).
 */
export const parryggSyncSummarySchema = z.object({
  /** Completed, singles matches examined (SSBU only). */
  matches: z.number().int().nonnegative(),
  /** Games imported (created or refreshed). */
  imported: z.number().int().nonnegative(),
  /** Matches skipped: not in a completed state, or a 0-0 walkover. */
  dqOrIncomplete: z.number().int().nonnegative(),
  /** Matches skipped: `game` present but not Smash Ultimate. */
  otherGame: z.number().int().nonnegative(),
  /** Matches skipped: no `game` at all (can't identify the title). */
  unknownGame: z.number().int().nonnegative(),
  /** Matches skipped: a team entrant (usersList.length > 1) on either side — singles only for v1. */
  teamEntrants: z.number().int().nonnegative(),
  /** Games skipped because a character slug had no roster mapping. */
  unmappedCharacters: z.number().int().nonnegative(),
  /** Games whose stage slug didn't match the stage list (imported with the unknown sentinel). */
  unmappedStages: z.number().int().nonnegative(),
  /** Matches with no per-game detail — synthesized into one record from the slot scores instead. */
  setsWithoutGameData: z.number().int().nonnegative(),
});
export type ParryggSyncSummary = z.infer<typeof parryggSyncSummarySchema>;
