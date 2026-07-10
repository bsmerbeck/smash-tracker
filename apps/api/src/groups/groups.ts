import { randomInt } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  computeRatingHistory,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS_PER_USER,
  matchRecordSchema,
  type GroupLeaderboard,
  type GroupMemberRecord,
  type GroupRecord,
  type LeaderboardEntry,
  type Match,
} from '@smash-tracker/shared';

/**
 * V7-D: friend-group Glicko-2 leaderboards — data-access + leaderboard
 * computation layer over the RTDB paths documented in
 * `packages/shared/src/groups.ts`. Routes (`routes/groups.ts`) stay thin;
 * all multi-path writes and the leaderboard cache live here, mirroring how
 * `startgg/sync.ts` centralizes RTDB writes and `startgg/scout.ts`
 * centralizes the in-memory cache pattern.
 */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Generates a random `INVITE_CODE_LENGTH`-char code from `INVITE_CODE_ALPHABET` using CSPRNG. */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Resolves the display name captured server-side at create/join time: the
 * caller's linked start.gg gamer tag when available, else "Player" + the
 * last 4 chars of their uid. Never the caller's email.
 */
export async function resolveDisplayName(database: Database, uid: string): Promise<string> {
  const snapshot = await database.ref(`startggLinks/${uid}/gamerTag`).get();
  if (snapshot.exists()) {
    const gamerTag = snapshot.val();
    if (typeof gamerTag === 'string' && gamerTag.trim().length > 0) {
      return gamerTag;
    }
  }
  return `Player${uid.slice(-4)}`;
}

async function memberCount(database: Database, groupId: string): Promise<number> {
  const snapshot = await database.ref(`groupMembers/${groupId}`).get();
  if (!snapshot.exists()) {
    return 0;
  }
  return Object.keys(snapshot.val() as Record<string, unknown>).length;
}

/** Creates a group, making `uid` the owner and first member. Enforces the per-user group cap. */
export async function createGroup(
  database: Database,
  uid: string,
  name: string,
): Promise<GroupRecord> {
  const userGroupsSnapshot = await database.ref(`userGroups/${uid}`).get();
  const existingGroupCount = userGroupsSnapshot.exists()
    ? Object.keys(userGroupsSnapshot.val() as Record<string, unknown>).length
    : 0;
  if (existingGroupCount >= MAX_GROUPS_PER_USER) {
    throw new ForbiddenError(`You can belong to at most ${MAX_GROUPS_PER_USER} groups`);
  }

  const ref = database.ref('groups').push();
  const groupId = ref.key;
  if (!groupId) {
    throw new Error('Failed to generate a push key for the new group');
  }

  const inviteCode = generateInviteCode();
  const createdAt = Date.now();
  const displayName = await resolveDisplayName(database, uid);

  const updates: Record<string, unknown> = {
    [`groups/${groupId}`]: { name, ownerUid: uid, inviteCode, createdAt },
    [`groupMembers/${groupId}/${uid}`]: {
      displayName,
      joinedAt: createdAt,
    } satisfies GroupMemberRecord,
    [`userGroups/${uid}/${groupId}`]: true,
    [`groupInviteCodes/${inviteCode}`]: groupId,
  };
  await database.ref().update(updates);

  return { id: groupId, name, ownerUid: uid, inviteCode, createdAt, memberCount: 1 };
}

/** Looks up a group by its invite code and adds `uid` as a member (idempotent). Enforces group-size and per-user caps. */
export async function joinGroup(
  database: Database,
  uid: string,
  code: string,
): Promise<GroupRecord> {
  const codeSnapshot = await database.ref(`groupInviteCodes/${code}`).get();
  if (!codeSnapshot.exists()) {
    throw new NotFoundError('No group found for that invite code');
  }
  const groupId = codeSnapshot.val() as string;

  const groupSnapshot = await database.ref(`groups/${groupId}`).get();
  if (!groupSnapshot.exists()) {
    throw new NotFoundError('No group found for that invite code');
  }
  const group = groupSnapshot.val() as Omit<GroupRecord, 'id' | 'memberCount'>;

  const memberSnapshot = await database.ref(`groupMembers/${groupId}/${uid}`).get();
  const count = await memberCount(database, groupId);

  if (memberSnapshot.exists()) {
    // Already a member — idempotent, no writes needed.
    return { id: groupId, ...group, memberCount: count };
  }

  if (count >= MAX_GROUP_MEMBERS) {
    throw new ConflictError(`This group is full (max ${MAX_GROUP_MEMBERS} members)`);
  }

  const userGroupsSnapshot = await database.ref(`userGroups/${uid}`).get();
  const existingGroupCount = userGroupsSnapshot.exists()
    ? Object.keys(userGroupsSnapshot.val() as Record<string, unknown>).length
    : 0;
  if (existingGroupCount >= MAX_GROUPS_PER_USER) {
    throw new ForbiddenError(`You can belong to at most ${MAX_GROUPS_PER_USER} groups`);
  }

  const joinedAt = Date.now();
  const displayName = await resolveDisplayName(database, uid);

  const updates: Record<string, unknown> = {
    [`groupMembers/${groupId}/${uid}`]: { displayName, joinedAt } satisfies GroupMemberRecord,
    [`userGroups/${uid}/${groupId}`]: true,
  };
  await database.ref().update(updates);

  return { id: groupId, ...group, memberCount: count + 1 };
}

/** Lists the caller's groups (owner or member), with `memberCount` computed per group. */
export async function listGroups(database: Database, uid: string): Promise<GroupRecord[]> {
  const userGroupsSnapshot = await database.ref(`userGroups/${uid}`).get();
  if (!userGroupsSnapshot.exists()) {
    return [];
  }
  const groupIds = Object.keys(userGroupsSnapshot.val() as Record<string, unknown>);

  const groups = await Promise.all(
    groupIds.map(async (groupId) => {
      const snapshot = await database.ref(`groups/${groupId}`).get();
      if (!snapshot.exists()) {
        return null;
      }
      const group = snapshot.val() as Omit<GroupRecord, 'id' | 'memberCount'>;
      const count = await memberCount(database, groupId);
      return { id: groupId, ...group, memberCount: count };
    }),
  );

  return groups.filter((g): g is GroupRecord => g !== null);
}

/** Removes `uid` from a group. The owner cannot leave while other members remain. */
export async function leaveGroup(database: Database, uid: string, groupId: string): Promise<void> {
  const groupSnapshot = await database.ref(`groups/${groupId}`).get();
  if (!groupSnapshot.exists()) {
    throw new NotFoundError('Group not found');
  }
  const group = groupSnapshot.val() as Omit<GroupRecord, 'id' | 'memberCount'>;

  const memberSnapshot = await database.ref(`groupMembers/${groupId}/${uid}`).get();
  if (!memberSnapshot.exists()) {
    throw new NotFoundError('You are not a member of this group');
  }

  if (group.ownerUid === uid) {
    const count = await memberCount(database, groupId);
    if (count > 1) {
      throw new ConflictError(
        'Transfer ownership or remove other members before leaving — the owner cannot leave a group that still has other members',
      );
    }
  }

  const updates: Record<string, unknown> = {
    [`groupMembers/${groupId}/${uid}`]: null,
    [`userGroups/${uid}/${groupId}`]: null,
  };
  await database.ref().update(updates);
}

/** Deletes a group entirely (owner only): meta, memberships, back-references, and invite-code index. */
export async function deleteGroup(database: Database, uid: string, groupId: string): Promise<void> {
  const groupSnapshot = await database.ref(`groups/${groupId}`).get();
  if (!groupSnapshot.exists()) {
    throw new NotFoundError('Group not found');
  }
  const group = groupSnapshot.val() as Omit<GroupRecord, 'id' | 'memberCount'>;
  if (group.ownerUid !== uid) {
    throw new ForbiddenError('Only the group owner can delete this group');
  }

  const membersSnapshot = await database.ref(`groupMembers/${groupId}`).get();
  const memberUids = membersSnapshot.exists()
    ? Object.keys(membersSnapshot.val() as Record<string, unknown>)
    : [];

  const updates: Record<string, unknown> = {
    [`groups/${groupId}`]: null,
    [`groupMembers/${groupId}`]: null,
    [`groupInviteCodes/${group.inviteCode}`]: null,
  };
  for (const memberUid of memberUids) {
    updates[`userGroups/${memberUid}/${groupId}`] = null;
  }
  await database.ref().update(updates);
}

// ---------------------------------------------------------------------------
// Leaderboard computation + cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface LeaderboardCacheEntry {
  leaderboard: GroupLeaderboard;
  expiresAt: number;
}

/**
 * Tiny in-memory per-group TTL cache (~5 min), mirroring `startgg/scout.ts`'s
 * `ScoutCache` pattern: a group refresh (viewing the same leaderboard
 * repeatedly) shouldn't recompute every member's full Glicko rating history
 * from their match log on every request. Per-instance, not distributed — see
 * `ScoutCache`'s doc comment for why that's an acceptable tradeoff here.
 */
export class GroupLeaderboardCache {
  private readonly entries = new Map<string, LeaderboardCacheEntry>();

  constructor(
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(groupId: string): GroupLeaderboard | null {
    const entry = this.entries.get(groupId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(groupId);
      return null;
    }
    return entry.leaderboard;
  }

  set(groupId: string, leaderboard: GroupLeaderboard): void {
    this.entries.set(groupId, { leaderboard, expiresAt: this.now() + this.ttlMs });
  }

  /** Evicts a group's cached entry immediately (e.g. after membership changes). */
  invalidate(groupId: string): void {
    this.entries.delete(groupId);
  }

  get size(): number {
    return this.entries.size;
  }
}

async function loadMatches(database: Database, uid: string): Promise<Match[]> {
  const snapshot = await database.ref(`matches/${uid}`).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;
  // safeParse-and-skip (production-gap rule, mirrors RtdbService.listMatches):
  // one member's corrupt match record must never 500 the whole group
  // leaderboard — their rating is simply computed without the bad record.
  return Object.entries(raw).flatMap(([id, value]) => {
    const parsed = matchRecordSchema.safeParse(value);
    return parsed.success ? [{ id, ...parsed.data }] : [];
  });
}

/**
 * Builds one member's leaderboard entry from their full match history's
 * Glicko rating history: `rating`/`rd` from the latest period (or the
 * defaults if they have none), `games` as the sum of rated games across all
 * periods, `lastMatchAt` as their most recent match's timestamp.
 */
function toLeaderboardEntry(
  uid: string,
  displayName: string,
  matches: Match[],
  isYou: boolean,
): LeaderboardEntry {
  const history = computeRatingHistory(matches);
  const games = history.periods.reduce((sum, period) => sum + period.games, 0);
  const lastMatchAt = matches.reduce<number | null>(
    (latest, match) => (latest === null || match.time > latest ? match.time : latest),
    null,
  );

  return {
    uid,
    displayName,
    rating: history.current?.rating ?? 1500,
    rd: history.current?.rd ?? 350,
    games,
    lastMatchAt,
    isYou,
  };
}

/** 404s if `groupId` doesn't exist, else 403s unless `uid` is a member. */
export async function requireMember(
  database: Database,
  uid: string,
  groupId: string,
): Promise<void> {
  const groupSnapshot = await database.ref(`groups/${groupId}`).get();
  if (!groupSnapshot.exists()) {
    throw new NotFoundError('Group not found');
  }
  const memberSnapshot = await database.ref(`groupMembers/${groupId}/${uid}`).get();
  if (!memberSnapshot.exists()) {
    throw new ForbiddenError('You are not a member of this group');
  }
}

/**
 * Computes (or returns the cached) leaderboard for a group: every member's
 * Glicko rating derived from their own match history, sorted by rating
 * descending. Callers must have already verified group existence + caller
 * membership (see `requireMember`) before calling this.
 */
export async function getGroupLeaderboard(
  database: Database,
  cache: GroupLeaderboardCache,
  callerUid: string,
  groupId: string,
): Promise<GroupLeaderboard> {
  const cached = cache.get(groupId);
  if (cached) {
    return {
      group: cached.group,
      entries: cached.entries.map((entry) => ({ ...entry, isYou: entry.uid === callerUid })),
    };
  }

  const groupSnapshot = await database.ref(`groups/${groupId}`).get();
  if (!groupSnapshot.exists()) {
    throw new NotFoundError('Group not found');
  }
  const groupMeta = groupSnapshot.val() as Omit<GroupRecord, 'id' | 'memberCount'>;

  const membersSnapshot = await database.ref(`groupMembers/${groupId}`).get();
  const membersRaw = membersSnapshot.exists()
    ? (membersSnapshot.val() as Record<string, GroupMemberRecord>)
    : {};
  const memberUids = Object.keys(membersRaw);

  const entries = await Promise.all(
    memberUids.map(async (uid) => {
      const matches = await loadMatches(database, uid);
      // isYou is computed relative to the cache-store's own perspective
      // (always false here) and overridden per-caller on every read — the
      // cached payload itself is caller-agnostic.
      return toLeaderboardEntry(uid, membersRaw[uid]!.displayName, matches, false);
    }),
  );
  entries.sort((a, b) => b.rating - a.rating);

  const group: GroupRecord = { id: groupId, ...groupMeta, memberCount: memberUids.length };
  const leaderboard: GroupLeaderboard = { group, entries };

  cache.set(groupId, leaderboard);

  return {
    group,
    entries: entries.map((entry) => ({ ...entry, isYou: entry.uid === callerUid })),
  };
}
