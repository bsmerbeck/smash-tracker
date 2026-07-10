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

// ---------------------------------------------------------------------------
// V7-A: scout any start.gg player (server-aggregated public history)
// ---------------------------------------------------------------------------

/** Which tournament site a scouting query/individual event resolves against (V9-B Feature 4). Reused everywhere this app needs the same two-value enum — a query targets ONE site, and a single event always belongs to ONE site. */
export const scoutSourceSchema = z.enum(['startgg', 'parrygg']);
export type ScoutSource = z.infer<typeof scoutSourceSchema>;

/**
 * The site(s) a resolved scout IDENTITY draws from — the two-value
 * `scoutSourceSchema` plus `'combined'` (V13), used only where a scout can span
 * BOTH sites at once: a `ScoutReportData.player` merged from a start.gg AND a
 * parry.gg profile the user asserted are the same person. Deliberately a
 * SEPARATE enum from `scoutSourceSchema` so `'combined'` can never leak into a
 * request `source` or a per-event `source`, where it's meaningless.
 */
export const scoutIdentitySourceSchema = z.enum(['startgg', 'parrygg', 'combined']);
export type ScoutIdentitySource = z.infer<typeof scoutIdentitySourceSchema>;

/**
 * The identity resolved from the caller's scouting query — start.gg OR (V9-B
 * Feature 4) parry.gg. Designed additively so every pre-V9-B stored report
 * (numeric `id`, no `source`, no `parryUserId`) keeps parsing unchanged:
 *
 * - `source` is OPTIONAL; its absence means start.gg (the only source that
 *   ever existed before V9-B) — every consumer must treat `source ?? 'startgg'`
 *   as the effective source, never assume the field is present.
 * - `id` (the start.gg numeric player id) is now OPTIONAL rather than
 *   required, because a parry.gg identity has no such id at all — but is
 *   ALWAYS present for `source: 'startgg'` (enforced below via `.refine`,
 *   not by the field's own optionality, since old records may have `source`
 *   absent while still trivially satisfying "id present").
 * - `parryUserId` (parry.gg's UUID v7 user id) is optional and is the
 *   parry.gg equivalent key: present when `source === 'parrygg'` OR (V13)
 *   `source === 'combined'`.
 * - (V13) `source: 'combined'` is a scout merged from BOTH sites for one
 *   asserted-same person, so it carries BOTH `id` (+ `userSlug` when the
 *   start.gg side had one) AND `parryUserId`.
 *
 * The `.refine`s below are the single place that enforces "the id field(s)
 * present match `source`" — every other consumer can just read
 * `source ?? 'startgg'` and the matching id field without re-deriving this
 * invariant.
 */
export const scoutPlayerIdentitySchema = z
  .object({
    /** start.gg player id — the key used for the sets query. Present for start.gg (or absent, pre-V9-B) and combined identities. */
    id: z.number().int().positive().optional(),
    gamerTag: z.string().min(1),
    /** start.gg profile slug, e.g. "user/07dc2239", when start.gg provides one. */
    userSlug: z.string().optional(),
    /** Which site(s) resolved this identity. Absent means start.gg (every identity stored before V9-B); `'combined'` (V13) spans both. */
    source: scoutIdentitySourceSchema.optional(),
    /** parry.gg user id (UUID v7) — the key used for the matches query. Present for 'parrygg' and (V13) 'combined' identities. */
    parryUserId: z.string().min(1).optional(),
  })
  .refine(
    (identity) =>
      identity.source === 'parrygg' || identity.source === 'combined'
        ? Boolean(identity.parryUserId)
        : true,
    {
      message: 'parrygg and combined identities must carry parryUserId',
      path: ['parryUserId'],
    },
  )
  .refine((identity) => (identity.source !== 'parrygg' ? identity.id !== undefined : true), {
    message: 'startgg and combined identities must carry a numeric id',
    path: ['id'],
  });
export type ScoutPlayerIdentity = z.infer<typeof scoutPlayerIdentitySchema>;

/** True when `identity` resolves to a start.gg player (the default when `source` is absent — pre-V9-B convention). */
export function isStartggIdentity(
  identity: Pick<ScoutPlayerIdentity, 'source'>,
): identity is ScoutPlayerIdentity & { source?: 'startgg'; id: number } {
  return (identity.source ?? 'startgg') === 'startgg';
}

/** True when `identity` resolves to a parry.gg player (single-source, not combined). */
export function isParryggIdentity(
  identity: Pick<ScoutPlayerIdentity, 'source'>,
): identity is ScoutPlayerIdentity & { source: 'parrygg'; parryUserId: string } {
  return identity.source === 'parrygg';
}

/** True when `identity` (V13) spans BOTH sites — a scout merged from a start.gg AND a parry.gg profile. */
export function isCombinedIdentity(
  identity: Pick<ScoutPlayerIdentity, 'source'>,
): identity is ScoutPlayerIdentity & { source: 'combined'; id: number; parryUserId: string } {
  return identity.source === 'combined';
}

/**
 * Stable string key for a scouted identity — `"(source ?? 'startgg')" +
 * ":" + the matching id field`. The single place every consumer (the Scout
 * page's "is there already a stored report for this player" check, the AI
 * Reports library's per-player grouping) should use to compare identities,
 * rather than re-deriving `source ?? 'startgg'` and picking `id` vs.
 * `parryUserId` themselves. Falls back to a gamerTag-based key in the
 * (should-be-impossible, schema-enforced-against) case neither id is present,
 * so this never throws on a malformed record.
 */
export function scoutIdentityKey(identity: ScoutPlayerIdentity): string {
  // (V13) A combined identity is a distinct data scope from either single
  // source, so it gets its own key composing BOTH ids — a combined report and
  // a start.gg-only report for the same player intentionally don't collide.
  if (isCombinedIdentity(identity)) {
    return `combined:startgg=${identity.id}:parrygg=${identity.parryUserId}`;
  }
  if (isParryggIdentity(identity)) {
    return `parrygg:${identity.parryUserId}`;
  }
  if (identity.id !== undefined) {
    return `startgg:${identity.id}`;
  }
  return `unknown:${identity.gamerTag}`;
}

/**
 * One character the scouted player has used, from THEIR perspective (their
 * pick, not their opponent's). `fighterId: 0` groups every game whose
 * start.gg character had no roster mapping (Random Character, unreleased
 * fighters, etc.) — same "unknown sentinel" convention as match records'
 * stage id.
 */
export const scoutCharacterUsageSchema = z.object({
  fighterId: z.number().int().nonnegative(),
  games: z.number().int().positive(),
  wins: z.number().int().nonnegative(),
});
export type ScoutCharacterUsage = z.infer<typeof scoutCharacterUsageSchema>;

/** The scouted player's results on one stage, from THEIR perspective. */
export const scoutStageUsageSchema = z.object({
  stageId: z.number().int().nonnegative(),
  games: z.number().int().positive(),
  wins: z.number().int().nonnegative(),
});
export type ScoutStageUsage = z.infer<typeof scoutStageUsageSchema>;

/**
 * One recent event the scouted player competed in (most recent activity
 * first). `slug`/`source` (V9-B Feature 2) are OPTIONAL and additive: reports
 * stored before this field existed have neither, and every consumer must
 * tolerate that (no deep link rendered — see `ScoutRecentEventsCard`).
 * `source` currently only appears when `slug` does (start.gg events only, so
 * far); parry.gg events are deliberately left plain-text for now — see the
 * code comment on `ScoutRecentEventsCard`'s render branch for why.
 */
export const scoutRecentEventSchema = z.object({
  eventName: z.string().min(1),
  tournamentName: z.string().optional(),
  placement: z.number().int().positive().optional(),
  numEntrants: z.number().int().positive().optional(),
  /** Epoch ms of the most recent completed set sampled for this event. */
  lastSetAt: z.number().int().nonnegative(),
  /**
   * Site-specific event identifier used to build a deep link, e.g. a
   * start.gg event slug ("tournament/the-big-house-9/event/ultimate-singles")
   * or (in principle) a parry.gg tournament/event slug pair joined the same
   * way. Absent for events sampled before V9-B, or when the source site
   * doesn't provide one.
   */
  slug: z.string().optional(),
  /** Which site `slug` resolves against; absent means start.gg (pre-V9-B convention — every event with a slug was start.gg-sourced). */
  source: scoutSourceSchema.optional(),
});
export type ScoutRecentEvent = z.infer<typeof scoutRecentEventSchema>;

/** One opponent the scouted player has faced most often in the sampled sets. */
export const scoutCommonOpponentSchema = z.object({
  gamerTag: z.string().min(1),
  sets: z.number().int().positive(),
});
export type ScoutCommonOpponent = z.infer<typeof scoutCommonOpponentSchema>;

/**
 * V9-D: one individual game from the sampled sets, entirely from the
 * scouted player's own perspective — enough to adapt into a client-side
 * `Match[]` (see apps/web's `FullAnalysisSection`) and run the SAME stats
 * engine (`apps/web/src/lib/stats.ts`) Fighter Analysis uses, for the
 * scouted player instead of the tracked user.
 *
 * OPTIONAL and additive on `scoutReportDataSchema`: every report generated
 * before V9-D (and every stored AI report, which never embedded the full
 * scout payload's `games` in the first place) has no such field at all, so
 * every consumer must render a "no per-game data" empty state rather than
 * assume presence.
 *
 * Games whose character couldn't be mapped to this app's roster are
 * SKIPPED here (never emitted with a fighterId of 0) — unlike
 * `scoutCharacterUsageSchema`'s aggregate rows, an unmapped-character game
 * would pollute the client stats engine's per-character breakdowns (e.g.
 * "their best stage on their top character") with games that aren't
 * actually attributable to a real character.
 */
export const scoutGameSchema = z.object({
  /** Epoch ms this game was played (set-level `completedAt`/`endedAt`, duplicated per game — same convention as match records' server-set event fields). */
  time: z.number().int().nonnegative(),
  win: z.boolean(),
  /** The scouted player's own character (mapped sprite id) for this game. */
  fighterId: z.number().int().nonnegative(),
  /** The opponent's character (mapped sprite id) for this game; `0` when unmapped (unlike `fighterId`, the opponent's character isn't the scouted player's own stats subject, so this follows the usual "unknown sentinel" convention instead of being skipped). */
  opponentFighterId: z.number().int().nonnegative(),
  /** This app's stage id, when the played stage resolved to one. */
  stageId: z.number().int().nonnegative().optional(),
  /** The stage's display name, when known. */
  stageName: z.string().optional(),
  /** The human opponent's gamer tag for this set. */
  opponentTag: z.string().min(1),
  /** The event name this set belonged to, when known. */
  eventName: z.string().optional(),
});
export type ScoutGame = z.infer<typeof scoutGameSchema>;

/**
 * POST /api/scout response — a server-aggregated scouting summary for ANY
 * start.gg player (not just linked accounts), built entirely from public
 * data reachable via the server's own API token. Every field below is from
 * the scouted player's own perspective (their characters, their stage
 * results, their opponents) — this is "what does their public history look
 * like", not a head-to-head against the caller.
 */
export const scoutReportDataSchema = z.object({
  player: scoutPlayerIdentitySchema,
  /** Count of SSBU sets sampled to build this report (capped, see scout.ts). */
  sampledSets: z.number().int().nonnegative(),
  /** Count of SSBU games sampled (>= sampledSets; a set is usually several games). */
  sampledGames: z.number().int().nonnegative(),
  /** Their most-played characters, most games first. */
  characters: z.array(scoutCharacterUsageSchema),
  /** Stages they've played on, most games first. */
  stages: z.array(scoutStageUsageSchema),
  /** Their most recent events, most recent first (capped to 10). */
  recentEvents: z.array(scoutRecentEventSchema).max(10),
  /** Opponents they've faced most often in the sample, most sets first (capped to 10). */
  commonOpponents: z.array(scoutCommonOpponentSchema).max(10),
  /**
   * V9-D: per-game records from the sampled sets, for the web "Full
   * analysis" section. OPTIONAL — see `scoutGameSchema`'s doc for the
   * back-compat rule every consumer must follow.
   */
  games: z.array(scoutGameSchema).optional(),
});
export type ScoutReportData = z.infer<typeof scoutReportDataSchema>;

/**
 * POST /api/scout request body — a profile URL, bare slug/tag, or numeric
 * player id. `source` (V9-B Feature 4) picks which site resolves a BARE
 * (non-URL) query; it defaults to `'startgg'` for back-compat with pre-V9-B
 * clients that never sent it. A pasted URL always auto-detects its own site
 * (start.gg vs. parry.gg) and overrides `source` — see `parseScoutInput`.
 *
 * (V13) `combineWith` is an OPTIONAL second lookup on the OTHER site: when
 * present, the server scouts BOTH `{query, source}` and `combineWith`, then
 * merges the two `ScoutReportData`s (see `mergeScoutReports`) into one combined
 * scout — the mechanism behind "combine start.gg + parry.gg" scouting. Absent
 * for every single-source query (the default, unchanged behavior).
 */
export const combineWithLookupSchema = z.object({
  query: z.string().min(1),
  source: scoutSourceSchema,
});
export type CombineWithLookup = z.infer<typeof combineWithLookupSchema>;

export const scoutQuerySchema = z.object({
  query: z.string().min(1),
  source: scoutSourceSchema.optional(),
  combineWith: combineWithLookupSchema.optional(),
});
export type ScoutQuery = z.infer<typeof scoutQuerySchema>;
