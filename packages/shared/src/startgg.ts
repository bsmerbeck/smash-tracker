import { z } from 'zod';

/**
 * `startggLinks/{uid}` — server-only record of a user's linked start.gg
 * account. Never exposed to clients directly (RTDB rules deny all client
 * access); the API returns the public subset via the status endpoint.
 */
export const startggLinkRecordSchema = z.object({
  /** start.gg user id (currentUser.id). */
  userId: z.number().int().positive(),
  /** start.gg player id (currentUser.player.id) — the key for set queries. */
  playerId: z.number().int().positive(),
  gamerTag: z.string().min(1),
  /** start.gg profile slug, e.g. "user/07dc2239". */
  slug: z.string().min(1),
  /** Epoch ms when the account was linked. */
  linkedAt: z.number().int().nonnegative(),
  /** Epoch ms of the last completed sync, absent before the first sync. */
  lastSyncAt: z.number().int().nonnegative().optional(),
});
export type StartggLinkRecord = z.infer<typeof startggLinkRecordSchema>;

/** GET /api/integrations/startgg/status response. */
export const startggStatusSchema = z.object({
  linked: z.boolean(),
  gamerTag: z.string().optional(),
  playerId: z.number().int().positive().optional(),
  slug: z.string().optional(),
  lastSyncAt: z.number().int().nonnegative().optional(),
});
export type StartggStatus = z.infer<typeof startggStatusSchema>;

/** POST /api/integrations/startgg/sync response — import summary. */
export const startggSyncSummarySchema = z.object({
  /** Sets examined (SSBU only). */
  sets: z.number().int().nonnegative(),
  /** Games imported (created or refreshed). */
  imported: z.number().int().nonnegative(),
  /** Sets carrying no per-game detail — nothing importable. */
  setsWithoutGames: z.number().int().nonnegative(),
  /** Games skipped because a character had no roster mapping (Random/Sora/...). */
  gamesUnmappedCharacter: z.number().int().nonnegative(),
  /** Games skipped because selections were missing/incomplete. */
  gamesMissingSelections: z.number().int().nonnegative(),
  /** Games whose stage didn't match the stage list (imported with the unknown sentinel). */
  gamesUnknownStage: z.number().int().nonnegative(),
  /** Sets skipped outright because start.gg reported them as a DQ (`displayScore === 'DQ'`). */
  dqSets: z.number().int().nonnegative(),
});
export type StartggSyncSummary = z.infer<typeof startggSyncSummarySchema>;

/** GET /api/integrations/startgg/authorize response. */
export const startggAuthorizeResponseSchema = z.object({
  url: z.string().min(1),
});

/**
 * One entrant's placement in `topStandings` (see `tournamentEntrySchema`).
 * Mirrors the shape of `event.standings.nodes` from start.gg's API — not
 * necessarily the tracked user; this is the public leaderboard context for
 * the event, capped to a handful of top finishers.
 */
export const eventStandingSchema = z.object({
  /** The entrant's placement in the event (1 = winner). */
  placement: z.number().int().positive(),
  /** Entrant display name as start.gg renders it (may include a sponsor prefix). */
  name: z.string().min(1),
  /** The player's gamer tag, when start.gg provides it. */
  gamerTag: z.string().optional(),
  /** The player's start.gg profile slug (e.g. "user/9fb774ae"), when start.gg provides it. */
  userSlug: z.string().optional(),
});
export type EventStanding = z.infer<typeof eventStandingSchema>;

/**
 * `tournamentEntries/{uid}/{eventId}` — one entry per start.gg event the
 * user has processed sets for, accumulated during sync. Server-only write;
 * exposed read-only via GET /api/tournaments. Optional fields are omitted
 * (not `undefined`) when start.gg doesn't provide them, per the RTDB
 * undefined-rejection rule matches already follow.
 */
export const tournamentEntrySchema = z.object({
  /** start.gg event id — the key this record is stored under (as a string). */
  eventId: z.number().int().positive(),
  /** Event name, e.g. "Ultimate Singles". */
  eventName: z.string().min(1),
  /** Tournament name, e.g. "The Big House 9", when start.gg provides one. */
  tournamentName: z.string().optional(),
  /** Total entrants in the event, when start.gg provides it. */
  numEntrants: z.number().int().positive().optional(),
  /** The user's seed in this event, when start.gg provides it. */
  seed: z.number().int().positive().optional(),
  /** The user's final placement in this event, when start.gg provides it. */
  placement: z.number().int().positive().optional(),
  /** Epoch ms of the earliest processed set for this event. */
  firstSetAt: z.number().int().nonnegative(),
  /** Epoch ms of the latest processed set for this event. */
  lastSetAt: z.number().int().nonnegative(),
  /** Count of non-DQ sets processed for this event. */
  setsPlayed: z.number().int().nonnegative(),
  /** Tournament slug (e.g. "tournament/the-box-juice-box-26"), fetched post-sync. */
  slug: z.string().optional(),
  /** Event slug (e.g. "tournament/the-box-juice-box-26/event/ultimate-singles"), fetched post-sync. */
  eventSlug: z.string().optional(),
  /** Top finishers of the event (capped, ~8), fetched post-sync. */
  topStandings: z.array(eventStandingSchema).max(8).optional(),
});
export type TournamentEntry = z.infer<typeof tournamentEntrySchema>;

/** GET /api/tournaments response — the user's tournament registry, newest first. */
export const tournamentEntryListSchema = z.array(tournamentEntrySchema);
export type TournamentEntryList = z.infer<typeof tournamentEntryListSchema>;
