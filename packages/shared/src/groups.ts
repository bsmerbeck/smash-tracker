import { z } from 'zod';

/**
 * V7-D: friend-group Glicko-2 leaderboards — the app's FIRST multi-tenant
 * feature (data visible BETWEEN users). RTDB layout (server-only writes,
 * multi-path `.update()` per mutation, mirroring `startgg/sync.ts`):
 *
 * - `groups/{groupId}`                -> { name, ownerUid, inviteCode, createdAt }
 * - `groupMembers/{groupId}/{uid}`    -> { displayName, joinedAt }
 * - `userGroups/{uid}/{groupId}`      -> true (membership index, for "my groups")
 * - `groupInviteCodes/{code}`         -> groupId (join lookup)
 *
 * SECURITY: a leaderboard reveals about each member ONLY display name,
 * rating, RD, games counted, and last-match date — never email, match
 * history, opponents, characters, or stages. See `leaderboardEntrySchema`.
 */

/** 8-char invite code alphabet: A-Z2-9 minus visually-ambiguous characters (0, 1, I, O). */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;

/** Max groups a single user may belong to (owner or member). */
export const MAX_GROUPS_PER_USER = 10;
/** Max members in a single group (including the owner). */
export const MAX_GROUP_MEMBERS = 20;

/** `groups/{groupId}` — group metadata. `memberCount` is computed at read time from `groupMembers/{groupId}`, never stored. */
export const groupRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  ownerUid: z.string().min(1),
  /** 8-char code from `INVITE_CODE_ALPHABET`, the only way to join. */
  inviteCode: z.string().min(1),
  /** Epoch ms when the group was created. */
  createdAt: z.number().int().nonnegative(),
  /** Computed at read time — number of rows under `groupMembers/{groupId}`. */
  memberCount: z.number().int().nonnegative(),
});
export type GroupRecord = z.infer<typeof groupRecordSchema>;

/**
 * `groupMembers/{groupId}/{uid}` — a member's public-to-the-group identity.
 * `displayName` is captured server-side at create/join time (never the
 * caller's email) and never changes retroactively for past reads.
 */
export const groupMemberRecordSchema = z.object({
  displayName: z.string().min(1),
  /** Epoch ms when this member joined (or created) the group. */
  joinedAt: z.number().int().nonnegative(),
});
export type GroupMemberRecord = z.infer<typeof groupMemberRecordSchema>;

/**
 * One row of a group leaderboard. Deliberately minimal — this is the ONLY
 * shape of one user ever exposed to another user in this app. `uid` is
 * included because the client needs a stable row key and to compute
 * `isYou`, but no other uid-derived identifier (email, links, history) ever
 * rides along with it.
 */
export const leaderboardEntrySchema = z.object({
  uid: z.string().min(1),
  displayName: z.string().min(1),
  /** Rounded display rating (Glicko-2 scale, ~1500-centered). */
  rating: z.number().int(),
  /** Rounded display rating deviation. */
  rd: z.number().int(),
  /** Rated matches counted toward this entry (sum of session games in the rating history). */
  games: z.number().int().nonnegative(),
  /** Epoch ms of the member's most recent match, or null if they have none. */
  lastMatchAt: z.number().int().nonnegative().nullable(),
  /** True for the row belonging to the caller — lets the UI highlight it without comparing uids client-side. */
  isYou: z.boolean(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

/** GET /api/groups/:id/leaderboard response. */
export const groupLeaderboardSchema = z.object({
  group: groupRecordSchema,
  /** Sorted by rating descending. */
  entries: z.array(leaderboardEntrySchema),
});
export type GroupLeaderboard = z.infer<typeof groupLeaderboardSchema>;

/** POST /api/groups request body. */
export const createGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(40),
});
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

/** POST /api/groups/join request body. */
export const joinGroupRequestSchema = z.object({
  code: z.string().trim().min(1),
});
export type JoinGroupRequest = z.infer<typeof joinGroupRequestSchema>;

/** GET /api/groups response — the caller's groups. */
export const groupListSchema = z.array(groupRecordSchema);
export type GroupList = z.infer<typeof groupListSchema>;
