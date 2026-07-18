import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  DEFAULT_ELITE_THRESHOLD,
  gspReadingRecordSchema,
  gspSettingsSchema,
  matchRecordSchema,
  MAX_PLAYLISTS_PER_USER,
  MAX_SHARES_PER_USER,
  normalizeVodTimestampsNode,
  opponentAliasMapSchema,
  opponentMapSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  playlistRecordSchema,
  publicShareSnapshotSchema,
  recapSnapshotSchema,
  shareSnapshotSchema,
  shareTokenSchema,
  stageFavoritesSchema,
  tournamentEntrySchema,
  userSchema,
  vodTimestampSchema,
  type CoachAttribution,
  type CreateGspReadingInput,
  type CreateMatchInput,
  type CreatePlaylistInput,
  type CreateShareInput,
  type FighterSelectionInput,
  type GspReading,
  type GspReadingRecord,
  type GspSettings,
  type StageFavorites,
  type Match,
  type MatchRecord,
  type OpponentAliasMap,
  type OpponentNote,
  type OpponentNoteMap,
  type Playlist,
  type PlaylistRecord,
  type PublicShareSnapshot,
  type RecapSnapshot,
  type ShareCreatedResponse,
  type ShareSnapshot,
  type ShareSummary,
  type ShareToken,
  type UpdateGspReadingInput,
  type UpdateMatchInput,
  type UpdatePlaylistInput,
  type UpsertGspSettingsInput,
  type UpsertOpponentNoteInput,
  type UpsertStageFavoritesInput,
  type User,
  type VodTimestamp,
} from '@smash-tracker/shared';
import { buildRecapSnapshot } from '../shares/buildRecapSnapshot.js';
import { buildShareSnapshot } from '../shares/buildShareSnapshot.js';
import { generateShareToken } from '../shares/token.js';

/**
 * POST/PATCH body shape for the owner (and, via the optional `coach` param,
 * coach) note-write endpoints — exactly `vodTimestampSchema`'s inferred
 * type, never hand-rolled (RESEARCH Pitfall 5: this schema is the single
 * source of truth for the 200-char/5-tag caps).
 */
export type VodTimestampInput = z.infer<typeof vodTimestampSchema>;

/**
 * Shape of a real share bearer token: `generateShareToken` emits 43 chars of
 * base64url (`randomBytes(32).toString('base64url')`); the 20–128 bounds
 * leave headroom without admitting short-junk probes. Checked in
 * `getShareByToken` BEFORE any RTDB read — firebase-admin's `ref()` throws
 * synchronously for paths containing `.`, `#`, `$`, `[`, or `]`, so an
 * unguarded crafted token (e.g. `/s/foo.bar`, `/s/og.png`) would 500 every
 * anonymous route instead of collapsing to the identical unknown-token
 * outcome (404 / generic shell / static fallback).
 */
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Shape of a real tournament-registry entryKey — same crafted-path trap as
 * `SHARE_TOKEN_SHAPE` above, applied to `createShare`'s recap branch (review
 * WR-01): firebase-admin's `ref()` throws synchronously for `.`, `#`, `$`,
 * `[`, `]`, and a `/` would silently read a NESTED child instead of an
 * entry. The two registry writers can never produce those characters
 * (start.gg keys are `String(eventId)`; parry.gg keys are stripped through
 * `RTDB_ILLEGAL` in parrygg/sync.ts's `deriveParryggEntryKey`), so this
 * denylist exactly mirrors the derivation: any key a sync wrote passes, any
 * crafted path-breaking probe collapses to the same 404 an absent entry
 * gets — never a 500.
 */
// eslint-disable-next-line no-control-regex -- control chars are exactly what RTDB keys forbid
const ENTRY_KEY_SHAPE = /^[^.#$[\]/\u0000-\u001f\u007f]{1,200}$/;

/**
 * Shape guard for a caller-supplied matchId before it reaches a `ref()`
 * path (review WR-07): reuses the ENTRY_KEY_SHAPE denylist (RTDB-illegal
 * `.` `#` `$` `[` `]` — a synchronous firebase-admin throw, i.e. a 500 —
 * plus `/`, which would silently address a NESTED child of the caller's own
 * subtree, control chars, and DEL). Any real push key passes; a crafted id
 * must collapse to the same not-found outcome an absent match gets.
 */
function isPathSafeMatchId(matchId: string): boolean {
  return ENTRY_KEY_SHAPE.test(matchId);
}

/** Edit-tier share links expire 30 days after creation (Phase 8, COACH-01/02). */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The single, canonical message every coach-path `NotFoundError` carries —
 * unknown token, revoked, expired, wrong tier, missing note, and
 * "note isn't yours" ALL surface identically (T-08-13's no-oracle rule,
 * RESEARCH A3). The route layer additionally collapses the whole 404 body,
 * but keeping the message uniform here means even a future caller that
 * lets the global handler render `error.message` leaks nothing.
 */
const SHARE_UNAVAILABLE_MESSAGE = 'This share is no longer available';

/**
 * Shared note cap across every writer (owner + coach, Phase 8) — mirrors
 * `vodTimestampEntrySchema`'s `.max(20)` read-side cap, enforced here
 * write-side by the `createNote` transaction on the parent node (T-08-05).
 */
const MAX_VOD_TIMESTAMPS_PER_MATCH = 20;

/**
 * Review WR-08: the three note transactions (`createNote`,
 * `writeNoteUpdate`, `removeNote`) rebuild the whole `vodTimestamps` node
 * from `normalizeVodTimestampsNode`'s output — which (post-CR-02) SKIPS any
 * entry that fails `vodTimestampEntrySchema`. Rebuilding from only the
 * parsed entries would silently and PERMANENTLY delete every unparseable
 * sibling as a side effect of an unrelated note create/edit/delete — the
 * exact recoverability this codebase's string-typed-`time` incident relied
 * on (that corruption was repaired BY HAND from the still-present raw
 * data). This collector returns those siblings so the rebuild can carry
 * them through OPAQUELY: the raw value verbatim, under its original key
 * (keyed shape) or a fresh push key (legacy-array shape, whose indices
 * were never real RTDB keys — the same one-time migration the parsed
 * entries get). Legacy `null` holes (RTDB array-coercion artifacts, not
 * data) are the one exception: dropped, exactly as RTDB itself strips
 * null children on write. Reads still skip these entries (CR-02's
 * normalizer is unchanged) — they persist only to stay hand-repairable.
 * Callers count them toward the shared 20-note cap (they ARE notes, just
 * corrupt — counting them closes a would-be cap bypass via corruption).
 */
function collectOpaqueVodTimestampEntries(
  raw: unknown,
  parsedIds: ReadonlySet<string>,
  mintKey: () => string,
): Array<[string, unknown]> {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((element, index): Array<[string, unknown]> => {
      if (parsedIds.has(`legacy-${index}`) || element === null || element === undefined) {
        return [];
      }
      return [[mintKey(), element]];
    });
  }
  return Object.entries(raw as Record<string, unknown>).filter(([key]) => !parsedIds.has(key));
}

/**
 * Write-time counterpart of the normalizer's read-time skip warning
 * (review WR-08): one warn per committed note write that carried opaque
 * (unparseable) entries through the rebuild — keys only, never contents.
 */
function warnOpaqueNoteCarry(context: string, keys: readonly string[]): void {
  if (keys.length > 0) {
    console.warn(
      `RtdbService.${context}: carried ${keys.length} unparseable vodTimestamps entr${
        keys.length === 1 ? 'y' : 'ies'
      } through the rebuild opaquely: ${keys.join(', ')}`,
    );
  }
}

/**
 * Walkthrough amendment (FB-04, coach display-name uniqueness): a plain
 * string transform, never a fuzzy-match library (RESEARCH Don't Hand-Roll) —
 * trims, collapses inner whitespace to a single space, and case-folds, so
 * "Sam", "sam", and "Sam  Jones"/"Sam Jones" collide as intended while
 * distinct names never accidentally match.
 */
function normalizeCoachName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown for a 400-worthy alias write: self-merge (alias === canonical after resolution). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown for a 409-worthy write: the record exists but its state forbids this operation (e.g. editing/deleting a synced match). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Thrown for a 403-worthy write: the caller is at/over a per-user cap (e.g. the 50-playlist limit). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * True when `input` would change a field that start.gg/parry.gg sync owns on
 * a synced match record. Sync re-writes game facts idempotently (keyed
 * `sgg-...`/`pgg-...`), so user edits to them would either drift from the
 * source of truth or be silently overwritten by the next sync. User-owned
 * annotations — `notes`, `vodUrl`, `vodTimestamps`, `gsp` — are NOT compared
 * here: those never come from sync and stay editable on any match.
 * Comparisons normalize the same way the web's payload builders do
 * (`?? ''` strings, `?? 'none'` matchType, map sentinel) so a carry-through
 * payload built from the record itself never reads as a change.
 */
function changesSyncOwnedFields(existing: MatchRecord, input: UpdateMatchInput): boolean {
  return (
    existing.fighter_id !== input.fighter_id ||
    existing.opponent_id !== input.opponent_id ||
    (existing.map?.id ?? 0) !== input.map.id ||
    (existing.map?.name ?? 'no selection') !== input.map.name ||
    (existing.opponent ?? '') !== (input.opponent ?? '') ||
    (existing.matchType ?? 'none') !== input.matchType ||
    existing.win !== input.win ||
    existing.stocksLeft !== input.stocksLeft ||
    (existing.eventName ?? '') !== (input.eventName ?? '') ||
    (existing.tournamentName ?? '') !== (input.tournamentName ?? '')
  );
}

/**
 * Thin data-access layer over the RTDB paths derived from legacy (see
 * packages/shared/README.md for provenance). Keeps route handlers free of
 * raw `database.ref(...)` calls and centralizes the exact path shapes.
 */
export class RtdbService {
  constructor(private readonly database: Database) {}

  // ---- users/{uid} ----------------------------------------------------

  /**
   * Idempotent upsert, called on every sign-in provisioning (not just
   * signup). Phase 7 (Recap Cards & Share-Loop Analytics): `referralToken`
   * is the share-page route TOKEN the client stamped in localStorage (the
   * public snapshot deliberately exposes no shareId — redaction-by-shape),
   * so it is resolved server-side (review CR-01) via `shareTokens/{token}`
   * to the durable shareId before anything is persisted: the stored
   * `referredByShareId` survives share-token rotation and never scatters a
   * live bearer credential into a third party's user node. A malformed or
   * unknown token silently drops the field — provisioning must never fail
   * on a bad referral. A REVOKED share still attributes (revocation kills
   * viewing, not the fact the visit happened), which is why `revokedAt` is
   * deliberately not checked here.
   *
   * Write-once, first-touch (FUNNEL-02) is enforced with an RTDB
   * TRANSACTION on the single `referredByShareId` child (review WR-05): the
   * update function aborts (returns `undefined`) when a value already
   * exists, so two concurrent provisioning calls (two tabs finishing
   * sign-in, or sign-in racing a token-refresh re-provision) can never
   * overwrite — or erase — each other's attribution. Every write here is
   * scoped to the exact child it owns (`email`, `referredByShareId`); this
   * method never `set()`s the whole `users/{uid}` node, so fields written
   * by other features survive re-provisioning. Never writes `null`
   * (CONCERNS.md).
   */
  async upsertUser(uid: string, input: { email: string; referralToken?: string }): Promise<void> {
    await this.database.ref(`users/${uid}/email`).set(input.email);

    if (!input.referralToken) {
      return;
    }
    const referredByShareId = await this.resolveReferralShareId(input.referralToken);
    if (!referredByShareId) {
      return;
    }
    await this.database
      .ref(`users/${uid}/referredByShareId`)
      .transaction((current) => (current == null ? referredByShareId : undefined));
  }

  /**
   * Resolves a client-stamped share-page TOKEN to its durable shareId, or
   * `undefined` when it can't be resolved (malformed shape, unknown token,
   * corrupt token record). Guarded by `SHARE_TOKEN_SHAPE` BEFORE any RTDB
   * read — same crafted-path 500 trap `getShareByToken` documents.
   * Deliberately ignores `revokedAt`: a revoked share still attributes.
   */
  private async resolveReferralShareId(token: string | undefined): Promise<string | undefined> {
    if (!token || !SHARE_TOKEN_SHAPE.test(token)) {
      return undefined;
    }
    const tokenSnapshot = await this.database.ref(`shareTokens/${token}`).get();
    if (!tokenSnapshot.exists()) {
      return undefined;
    }
    const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
    return parsedToken.success ? parsedToken.data.shareId : undefined;
  }

  async getUser(uid: string): Promise<User | null> {
    const snapshot = await this.database.ref(`users/${uid}`).get();
    if (!snapshot.exists()) {
      return null;
    }
    return userSchema.parse(snapshot.val());
  }

  // ---- primaryFighters/{uid}, secondaryFighters/{uid} ------------------

  async getFighterSelection(uid: string): Promise<{ primary: number[]; secondary: number[] }> {
    const [primarySnap, secondarySnap] = await Promise.all([
      this.database.ref(`primaryFighters/${uid}`).get(),
      this.database.ref(`secondaryFighters/${uid}`).get(),
    ]);

    return {
      primary: primarySnap.exists() ? (primarySnap.val() as number[]) : [],
      secondary: secondarySnap.exists() ? (secondarySnap.val() as number[]) : [],
    };
  }

  async setFighterSelection(uid: string, selection: FighterSelectionInput): Promise<void> {
    await Promise.all([
      this.database.ref(`primaryFighters/${uid}`).set(selection.primary),
      this.database.ref(`secondaryFighters/${uid}`).set(selection.secondary),
    ]);
  }

  // ---- matches/{uid}/{pushKey} ------------------------------------------

  async listMatches(uid: string): Promise<Match[]> {
    const snapshot = await this.database.ref(`matches/${uid}`).get();
    if (!snapshot.exists()) {
      return [];
    }

    const raw = snapshot.val() as Record<string, unknown>;
    // safeParse-and-skip (production-gap rule, mirrors listGspReadings): one
    // corrupt record must never 500 the whole list — a single string-typed
    // `time` took down GET /api/matches for an affected user for days.
    // Skips log the record id + failing field paths (never values, never uid)
    // so corrupt data stays discoverable in Cloud Run logs.
    return Object.entries(raw).flatMap(([id, value]) => {
      const parsed = matchRecordSchema.safeParse(value);
      if (!parsed.success) {
        console.warn(
          `listMatches: skipping corrupt match record ${id}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
            .join('; ')}`,
        );
        return [];
      }
      return [{ id, ...parsed.data }];
    });
  }

  async createMatch(uid: string, input: CreateMatchInput): Promise<Match> {
    const record: MatchRecord = {
      fighter_id: input.fighter_id,
      opponent_id: input.opponent_id,
      time: Date.now(),
      map: input.map,
      notes: input.notes,
      matchType: input.matchType,
      win: input.win,
      // RTDB rejects `undefined` values outright, so optional fields must
      // only be present on the record when the input actually provided
      // them (conditional spread) rather than being set to `undefined`.
      // `opponent` is optional too: online quickplay (GSP) matches have no
      // named opponent.
      ...(input.opponent !== undefined ? { opponent: input.opponent } : {}),
      ...(input.stocksLeft !== undefined ? { stocksLeft: input.stocksLeft } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.tournamentName !== undefined ? { tournamentName: input.tournamentName } : {}),
      ...(input.vodUrl !== undefined ? { vodUrl: input.vodUrl } : {}),
      // Phase 8: `vodTimestamps` is no longer part of `CreateMatchInput`
      // (08-01 dropped it) — a newly-created match never has notes on
      // create; they're added afterward via `createNote`.
      ...(input.vodStartSeconds !== undefined ? { vodStartSeconds: input.vodStartSeconds } : {}),
      ...(input.gsp !== undefined ? { gsp: input.gsp } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };

    const ref = this.database.ref(`matches/${uid}`).push();
    await ref.set(record);
    if (input.opponent !== undefined) {
      await this.addOpponent(uid, input.opponent);
    }

    const id = ref.key;
    if (!id) {
      throw new Error('Failed to generate a push key for the new match');
    }

    return { id, ...record };
  }

  async updateMatch(uid: string, id: string, input: UpdateMatchInput): Promise<Match> {
    const ref = this.database.ref(`matches/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Match ${id} not found`);
    }
    const current = matchRecordSchema.parse(existing.val());
    // Phase 8: the RAW (pre-normalizer) `vodTimestamps` node, read straight
    // off `existing.val()` rather than through `current` above. This
    // distinction matters: `matchRecordSchema`'s `vodTimestamps` field is a
    // `z.preprocess` that ALWAYS reshapes the node into a flat, id-bearing
    // array (see `normalizeVodTimestampsNode`) — carrying THAT parsed
    // shape through would silently flatten a keyed push-key subtree into a
    // plain array on every unrelated match-fact PATCH, destroying the real
    // push keys the note-cap transaction (`createNote`/`updateNote`/
    // `deleteNote` below) relies on as note ids. The raw node must be
    // carried through OPAQUELY — whatever shape it's currently in (legacy
    // array, keyed object, or absent) — never reshaped by this path.
    const rawVodTimestamps = (existing.val() as Record<string, unknown> | null)?.vodTimestamps;

    // Synced matches: sync owns the game facts (idempotent re-writes would
    // clobber user edits anyway) — only the user-annotation fields may
    // change. 409 mirrors the UI, which hides Edit for synced rows but keeps
    // VOD notes (which PATCH here with every game fact carried through).
    if (current.source && changesSyncOwnedFields(current, input)) {
      throw new ConflictError(
        `Match ${id} is synced from ${current.source}; its game data is managed by sync`,
      );
    }

    const record: MatchRecord = {
      fighter_id: input.fighter_id,
      opponent_id: input.opponent_id,
      // Editing corrects a record, it doesn't re-date it: `time` keeps the
      // original value (stamping Date.now() here re-ordered edited matches
      // to "now", corrupting the GSP series / form curve / trends, all of
      // which key on time).
      time: current.time,
      map: input.map,
      notes: input.notes,
      matchType: input.matchType,
      win: input.win,
      // See createMatch — RTDB rejects `undefined` values, so these are
      // only included when the input actually set them. Omitting
      // opponent/vodUrl/vodStartSeconds/gsp/tags from the input is how a
      // caller clears them, since this is a full overwrite (`.set()`, not a
      // partial patch).
      ...(input.opponent !== undefined ? { opponent: input.opponent } : {}),
      ...(input.stocksLeft !== undefined ? { stocksLeft: input.stocksLeft } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.tournamentName !== undefined ? { tournamentName: input.tournamentName } : {}),
      ...(input.vodUrl !== undefined ? { vodUrl: input.vodUrl } : {}),
      ...(input.vodStartSeconds !== undefined ? { vodStartSeconds: input.vodStartSeconds } : {}),
      ...(input.gsp !== undefined ? { gsp: input.gsp } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      // Server-set provenance survives the overwrite — the full-overwrite
      // rebuild used to strip these, breaking source badges after a VOD edit.
      ...(current.source !== undefined ? { source: current.source } : {}),
      ...(current.externalId !== undefined ? { externalId: current.externalId } : {}),
      // Phase 8 (Coaching Edit Sessions): `vodTimestamps` is no longer
      // accepted on `UpdateMatchInput` at all (08-01 dropped it from
      // `updateMatchInputSchema`), so this is now an UNCONDITIONAL carry of
      // the RAW node — never from `input`, and never through the
      // schema-normalizing `current` (see `rawVodTimestamps` above). This is
      // the migration's crux (RESEARCH Pitfall 1): a match-fact PATCH (e.g.
      // correcting the opponent/stage/result) must never stomp the note
      // subtree, whatever shape it's currently stored in (legacy array or
      // keyed push-key object — this carries either through opaquely).
      // Notes are written exclusively via `createNote`/`updateNote`/
      // `deleteNote` below, and deliberately cleared only via
      // `clearVodAndNotes` (never by omission on this path).
      ...(rawVodTimestamps !== undefined
        ? { vodTimestamps: rawVodTimestamps as MatchRecord['vodTimestamps'] }
        : {}),
    };

    await ref.set(record);
    if (input.opponent !== undefined) {
      await this.addOpponent(uid, input.opponent);
    }

    // The RESPONSE, unlike the stored `record` above, always carries the
    // NORMALIZED (id-bearing, sorted) `vodTimestamps` shape — every reader
    // of a `Match` (this API's callers, `matchSchema`'s response
    // serialization) expects that shape regardless of the raw storage
    // representation. `current.vodTimestamps` (from the schema-parsed
    // record fetched above) already IS that normalized shape.
    return {
      id,
      ...record,
      ...(current.vodTimestamps !== undefined ? { vodTimestamps: current.vodTimestamps } : {}),
    };
  }

  /**
   * Walkthrough amendment (FB-05, VOD-removal share cascade): resolves
   * every ACTIVE review-kind share for `(uid, matchId)` to its bearer
   * token, via the SAME two-hop join `listSharesForUser` already proves
   * (`sharesByUser/{uid}` -> `shareSnapshots/{shareId}` -> `shareTokens/
   * {token}`). Deliberately reads `matchId` from the SNAPSHOT, never the
   * token record — `shareTokenSchema` has no `matchId` field at all
   * (RESEARCH's correction to CONTEXT.md); reading the wrong node would
   * silently resolve zero shares instead of erroring. A recap share
   * (`kind: 'recap'`, no `matchId`) or a share for a different match is
   * skipped, same as an already-revoked one — only genuinely ACTIVE
   * review shares for THIS match are returned.
   */
  private async resolveActiveReviewShareTokens(uid: string, matchId: string): Promise<string[]> {
    const indexSnapshot = await this.database.ref(`sharesByUser/${uid}`).get();
    if (!indexSnapshot.exists()) {
      return [];
    }
    const index = indexSnapshot.val() as Record<string, unknown>;

    const results = await Promise.all(
      Object.entries(index).map(async ([shareId, tokenValue]): Promise<string | null> => {
        if (typeof tokenValue !== 'string') {
          return null;
        }
        const [snapshotSnapshot, tokenSnapshot] = await Promise.all([
          this.database.ref(`shareSnapshots/${shareId}`).get(),
          this.database.ref(`shareTokens/${tokenValue}`).get(),
        ]);
        if (!snapshotSnapshot.exists() || !tokenSnapshot.exists()) {
          return null;
        }
        const rawSnapshot = snapshotSnapshot.val();
        // A recap snapshot carries no matchId at all — skip before parsing
        // against shareSnapshotSchema (which would fail on it anyway).
        if ((rawSnapshot as { kind?: unknown } | null)?.kind === 'recap') {
          return null;
        }
        const parsedSnapshot = shareSnapshotSchema.safeParse(rawSnapshot);
        if (!parsedSnapshot.success || parsedSnapshot.data.matchId !== matchId) {
          return null;
        }
        const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
        if (!parsedToken.success || parsedToken.data.revokedAt != null) {
          // Already inactive (or corrupt) — never re-stamped, never actioned.
          return null;
        }
        return tokenValue;
      }),
    );
    return results.filter((t): t is string => t !== null);
  }

  /**
   * The one legitimate "remove VOD" intent (MatchTable's "remove VOD"
   * action, wired in a later 08-0x plan): blanks `vodUrl`/`vodStartSeconds`
   * and drops the `vodTimestamps` node in the same write. Now that omitting
   * `vodTimestamps` from an `updateMatch` payload means "preserve" (see
   * above), this explicit method is the ONLY way to clear notes — no
   * implicit-omission path exists anymore (RESEARCH Pitfall 2).
   *
   * Walkthrough amendment (FB-05): folds a soft-revoke of every ACTIVE
   * review share for this match into the SAME root-level multi-path update
   * as the VOD-clearing write — a coach never retains write access to a
   * match whose VOD the owner believes is gone (T-09-08). Recap shares are
   * untouched; an already-revoked share is left unchanged.
   */
  async clearVodAndNotes(uid: string, id: string): Promise<Match> {
    // Review WR-07: crafted ids must 404 like an absent match, never reach
    // ref() (synchronous throw -> 500) or address a nested child.
    if (!isPathSafeMatchId(id)) {
      throw new NotFoundError('Match not found');
    }
    const ref = this.database.ref(`matches/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Match ${id} not found`);
    }
    const current = matchRecordSchema.parse(existing.val());

    // Rebuild every OTHER field explicitly (rather than spread-then-delete)
    // so `vodUrl`/`vodStartSeconds`/`vodTimestamps` are guaranteed absent
    // from the written record, not just unset on a local variable.
    const record: MatchRecord = {
      fighter_id: current.fighter_id,
      opponent_id: current.opponent_id,
      time: current.time,
      map: current.map,
      notes: current.notes,
      matchType: current.matchType,
      win: current.win,
      ...(current.opponent !== undefined ? { opponent: current.opponent } : {}),
      ...(current.stocksLeft !== undefined ? { stocksLeft: current.stocksLeft } : {}),
      ...(current.eventName !== undefined ? { eventName: current.eventName } : {}),
      ...(current.tournamentName !== undefined ? { tournamentName: current.tournamentName } : {}),
      ...(current.gsp !== undefined ? { gsp: current.gsp } : {}),
      ...(current.tags !== undefined ? { tags: current.tags } : {}),
      ...(current.source !== undefined ? { source: current.source } : {}),
      ...(current.externalId !== undefined ? { externalId: current.externalId } : {}),
    };

    const activeTokens = await this.resolveActiveReviewShareTokens(uid, id);
    const revokedAt = Date.now();
    await this.database.ref().update({
      [`matches/${uid}/${id}`]: record,
      ...Object.fromEntries(
        activeTokens.map((token) => [`shareTokens/${token}/revokedAt`, revokedAt]),
      ),
    });
    return { id, ...record };
  }

  /**
   * Walkthrough amendment (FB-05): same cascade as `clearVodAndNotes`
   * above, folded into the SAME root-level multi-path update as the match
   * removal — a deleted match's share links die atomically with it.
   */
  async deleteMatch(uid: string, id: string): Promise<void> {
    const ref = this.database.ref(`matches/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Match ${id} not found`);
    }
    const current = matchRecordSchema.parse(existing.val());
    // Deleting a synced match is futile (the next sync re-creates it under
    // the same idempotent key) — refuse instead of pretending it worked.
    if (current.source) {
      throw new ConflictError(
        `Match ${id} is synced from ${current.source}; unlink or re-sync to manage it`,
      );
    }
    const activeTokens = await this.resolveActiveReviewShareTokens(uid, id);
    const revokedAt = Date.now();
    await this.database.ref().update({
      [`matches/${uid}/${id}`]: null,
      ...Object.fromEntries(
        activeTokens.map((token) => [`shareTokens/${token}/revokedAt`, revokedAt]),
      ),
    });
  }

  // ---- matches/{uid}/{matchId}/vodTimestamps/{pushKey} -------------------
  // Phase 8 (Coaching Edit Sessions): notes are now created/edited/deleted
  // through these dedicated keyed-subtree helpers instead of the match-fact
  // PATCH path. All three run their write inside a `.transaction()` on the
  // PARENT node (`vodTimestamps`, not a single-child `.set()`), because the
  // 20-note cap is shared and concurrent — an owner write and a (future,
  // 08-03) coach write must never both slip past the cap by racing two
  // separate `.get()`-then-`.set()` sequences. This is the SAME shared
  // write path 08-03's coach helpers extend via the optional `coach` param.

  /**
   * Creates a note under `matches/{uid}/{matchId}/vodTimestamps/{pushKey}`.
   * `coach`, when supplied, stamps coach attribution on the new note (the
   * seam 08-03's coach-facing write extends — the owner path never passes
   * it). Migrates a legacy dense-array node to the keyed-object shape in
   * the same transaction on first post-deploy write: every existing entry
   * keeps its real RTDB key when already keyed, or is assigned a FRESH push
   * key when it was a legacy array element (whose `id` — synthesized by
   * `normalizeVodTimestampsNode` as `legacy-<index>` — was never a real
   * RTDB key). Throws `NotFoundError` if the match doesn't exist, and
   * `ForbiddenError` if the match is already at the shared 20-note cap
   * (T-08-05) — the transaction aborts (returns `undefined`) without
   * writing in that case, matching `upsertUser`'s referral-transaction
   * abort convention. Unparseable sibling entries are carried through the
   * rebuild opaquely and COUNT toward the cap (review WR-08 — see
   * `collectOpaqueVodTimestampEntries`).
   *
   * Walkthrough amendment (FB-04, coach display-name uniqueness): `coach`
   * attribution — a DIFFERENT session already using the same normalized
   * name on this match, OR a name colliding with `ownerDisplayName` (passed
   * only by `createCoachNote`, never the owner path) — aborts the
   * transaction with `nameConflict` set, mirroring `capExceeded`'s
   * abort-without-writing convention; the caller throws `ConflictError`.
   * The decision is recomputed fresh every transaction invocation (CR-01
   * discipline — see `writeNoteUpdate`'s "Reset per run" comment) by
   * reading `entries` computed on THAT run, never a value memoized across
   * runs.
   */
  async createNote(
    uid: string,
    matchId: string,
    input: VodTimestampInput,
    coach?: CoachAttribution,
    ownerDisplayName?: string,
  ): Promise<VodTimestamp> {
    // Review WR-07: crafted ids must 404 like an absent match, never reach
    // ref() (synchronous throw -> 500) or address a nested child. The coach
    // path's matchId is server-resolved (a real push key) and passes.
    if (!isPathSafeMatchId(matchId)) {
      throw new NotFoundError('Match not found');
    }
    const matchSnapshot = await this.database.ref(`matches/${uid}/${matchId}`).get();
    if (!matchSnapshot.exists()) {
      throw new NotFoundError(`Match ${matchId} not found`);
    }

    const notesRef = this.database.ref(`matches/${uid}/${matchId}/vodTimestamps`);
    const newNoteId = notesRef.push().key;
    if (!newNoteId) {
      throw new Error('Failed to generate a push key for the new note');
    }

    const newEntryRecord: Omit<VodTimestamp, 'id'> = {
      seconds: input.seconds,
      note: input.note,
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(coach !== undefined ? { coach } : {}),
    };

    let capExceeded = false;
    let nameConflict = false;
    let carriedOpaqueKeys: string[] = [];
    const result = await notesRef.transaction((raw) => {
      // Reset per run (review CR-01): a value captured during a DISCARDED
      // (hash-mismatch) run must never leak into the final outcome — only
      // the run whose return value actually commits may report success.
      carriedOpaqueKeys = [];
      nameConflict = false;
      const entries = normalizeVodTimestampsNode(raw);
      // Review WR-08: unparseable siblings ride through the rebuild
      // verbatim instead of being silently destroyed, and count toward the
      // shared cap (see collectOpaqueVodTimestampEntries).
      const opaque = collectOpaqueVodTimestampEntries(
        raw,
        new Set(entries.map((entry) => entry.id)),
        () => notesRef.push().key!,
      );
      if (entries.length + opaque.length >= MAX_VOD_TIMESTAMPS_PER_MATCH) {
        capExceeded = true;
        return undefined;
      }

      if (coach !== undefined) {
        const normalizedNew = normalizeCoachName(coach.displayName);
        if (ownerDisplayName != null && normalizeCoachName(ownerDisplayName) === normalizedNew) {
          nameConflict = true;
          return undefined;
        }
        const collidesWithOtherSession = entries.some(
          (entry) =>
            entry.coach != null &&
            entry.coach.sessionId !== coach.sessionId &&
            normalizeCoachName(entry.coach.displayName) === normalizedNew,
        );
        if (collidesWithOtherSession) {
          nameConflict = true;
          return undefined;
        }
      }

      const nextNode: Record<string, unknown> = {};
      for (const { id: entryId, ...rest } of entries) {
        // A real keyed-subtree entry's id IS its RTDB key already; a
        // legacy array element's id was synthesized as `legacy-<index>` by
        // the normalizer and was never a real key — mint a fresh one now.
        const key = entryId.startsWith('legacy-') ? notesRef.push().key! : entryId;
        nextNode[key] = rest;
      }
      for (const [key, value] of opaque) {
        nextNode[key] = value;
        carriedOpaqueKeys.push(key);
      }
      nextNode[newNoteId] = newEntryRecord;
      return nextNode;
    });
    if (result.committed) {
      warnOpaqueNoteCarry('createNote', carriedOpaqueKeys);
    }

    if (capExceeded) {
      throw new ForbiddenError(
        `Match ${matchId} already has ${MAX_VOD_TIMESTAMPS_PER_MATCH} notes`,
      );
    }

    if (nameConflict) {
      // Static, private-data-free message (FB-04): never echoes the
      // submitted name or matchId — this is a deliberately narrow, reviewed
      // exception to the anonymous coach surface's no-oracle 404 discipline
      // (it can only ever be reached AFTER resolveEditSession succeeded).
      throw new ConflictError('That name is already taken on this review');
    }

    return { id: newNoteId, ...newEntryRecord };
  }

  /**
   * The single note-EDIT transaction both the owner path (`updateNote`) and
   * the coach path (`updateCoachNote`) run through — one implementation of
   * the parent-node transaction, two `computeNext` policies. When
   * `requireCoachSessionId` is set, the target note must carry a `coach`
   * sub-object whose `sessionId` matches — a mismatch, an OWNER note (no
   * `coach` at all), and a genuinely missing note all abort identically
   * (return `null`), so "not yours" and "doesn't exist" are
   * indistinguishable (T-08-09, RESEARCH A3). Returns `null` for
   * not-found/not-yours; the callers translate to their own NotFoundError.
   */
  private async writeNoteUpdate(
    uid: string,
    matchId: string,
    noteId: string,
    computeNext: (current: Omit<VodTimestamp, 'id'>) => Omit<VodTimestamp, 'id'>,
    requireCoachSessionId?: string,
  ): Promise<VodTimestamp | null> {
    // Review WR-07: crafted ids collapse to this method's not-found signal.
    if (!isPathSafeMatchId(matchId)) {
      return null;
    }
    const matchSnapshot = await this.database.ref(`matches/${uid}/${matchId}`).get();
    if (!matchSnapshot.exists()) {
      return null;
    }

    const notesRef = this.database.ref(`matches/${uid}/${matchId}/vodTimestamps`);
    let updated: VodTimestamp | undefined;
    let carriedOpaqueKeys: string[] = [];

    const result = await notesRef.transaction((raw) => {
      // Reset per run (review CR-01): a value captured during a DISCARDED
      // (hash-mismatch) run must never leak into the final outcome — only
      // the run whose return value actually commits may report success.
      updated = undefined;
      carriedOpaqueKeys = [];
      if (raw === null || raw === undefined) {
        // Real RTDB runs this function against the SDK's LOCAL CACHE first
        // — on a listener-less server process that is `null` even when
        // server data exists (`get()`'s temporary registration is removed
        // once it resolves). Returning `undefined` here would abort the
        // transaction PERMANENTLY — there is no retry with server data —
        // 404ing every note edit against real RTDB (review CR-01).
        // Returning the input unchanged instead forces the SDK's hash
        // compare: it either commits a no-op (node truly empty — `updated`
        // stays unset, callers 404 correctly) or fails and re-runs this
        // function with the real server value.
        return raw;
      }
      const entries = normalizeVodTimestampsNode(raw);
      const target = entries.find((entry) => entry.id === noteId);
      if (!target) {
        // Verified-missing (non-null node, no matching note) — abort is
        // correct here (mirrors upsertUser's referral-transaction abort).
        return undefined;
      }
      if (
        requireCoachSessionId !== undefined &&
        target.coach?.sessionId !== requireCoachSessionId
      ) {
        // Ownership guard INSIDE the transaction (no check-then-write
        // race): not the caller's note — abort without writing.
        return undefined;
      }

      const nextNode: Record<string, unknown> = {};
      for (const { id: entryId, ...rest } of entries) {
        // Same migration createNote applies (review WR-06): a `legacy-*` id
        // was synthesized by the normalizer for a dense-array element and
        // was NEVER a real RTDB key — persisting it would store a lying
        // key shape that a later createNote silently re-keys wholesale.
        // Mint a fresh push key now instead, so any write to a legacy node
        // fully migrates it exactly once and ids are stable thereafter.
        const key = entryId.startsWith('legacy-') ? notesRef.push().key! : entryId;
        if (entryId === noteId) {
          const nextEntry = computeNext(rest);
          nextNode[key] = nextEntry;
          // The updated note reports its POST-migration id — the client
          // invalidates and refetches after every write, so a stale
          // `legacy-*` id never survives the migration.
          updated = { id: key, ...nextEntry };
        } else {
          nextNode[key] = rest;
        }
      }
      // Review WR-08: carry unparseable siblings through verbatim — a
      // corrupt entry must survive an unrelated note edit, never be
      // silently destroyed by the normalized rebuild.
      for (const [key, value] of collectOpaqueVodTimestampEntries(
        raw,
        new Set(entries.map((entry) => entry.id)),
        () => notesRef.push().key!,
      )) {
        nextNode[key] = value;
        carriedOpaqueKeys.push(key);
      }
      return nextNode;
    });

    // Success is derived from the COMMITTED transaction result, never from
    // a closure flag alone (review CR-01's secondary defect): an aborted
    // transaction returns null even if some discarded run found the target.
    if (!result.committed) {
      return null;
    }
    warnOpaqueNoteCarry('writeNoteUpdate', carriedOpaqueKeys);
    return updated ?? null;
  }

  /**
   * The single note-DELETE transaction both `deleteNote` (owner) and
   * `deleteCoachNote` run through — same ownership-guard-inside-the-
   * transaction discipline as `writeNoteUpdate` above. Returns `false` for
   * not-found/not-yours (callers translate to NotFoundError).
   */
  private async removeNote(
    uid: string,
    matchId: string,
    noteId: string,
    requireCoachSessionId?: string,
  ): Promise<boolean> {
    // Review WR-07: crafted ids collapse to this method's not-found signal.
    if (!isPathSafeMatchId(matchId)) {
      return false;
    }
    const matchSnapshot = await this.database.ref(`matches/${uid}/${matchId}`).get();
    if (!matchSnapshot.exists()) {
      return false;
    }

    const notesRef = this.database.ref(`matches/${uid}/${matchId}/vodTimestamps`);
    let found = false;
    let carriedOpaqueKeys: string[] = [];

    const result = await notesRef.transaction((raw) => {
      // Reset per run — see writeNoteUpdate's identical comment (CR-01).
      found = false;
      carriedOpaqueKeys = [];
      if (raw === null || raw === undefined) {
        // Unknown local cache — never abort here; force the SDK's
        // server-verified retry (or a harmless no-op commit when the node
        // is truly empty). See writeNoteUpdate's comment (review CR-01).
        return raw;
      }
      const entries = normalizeVodTimestampsNode(raw);
      const target = entries.find((entry) => entry.id === noteId);
      if (!target) {
        // Verified-missing — abort, nothing to write.
        return undefined;
      }
      if (
        requireCoachSessionId !== undefined &&
        target.coach?.sessionId !== requireCoachSessionId
      ) {
        return undefined;
      }
      found = true;

      const nextNode: Record<string, unknown> = {};
      for (const { id: entryId, ...rest } of entries) {
        if (entryId !== noteId) {
          // Re-key legacy entries with real push keys — see
          // writeNoteUpdate's identical migration comment (review WR-06).
          const key = entryId.startsWith('legacy-') ? notesRef.push().key! : entryId;
          nextNode[key] = rest;
        }
      }
      // Review WR-08: carry unparseable siblings through verbatim — a
      // corrupt entry must survive an unrelated note delete. (The target
      // itself is always a PARSED entry — `entries.find` above — so it can
      // never reappear here: parsedIds includes it.)
      for (const [key, value] of collectOpaqueVodTimestampEntries(
        raw,
        new Set(entries.map((entry) => entry.id)),
        () => notesRef.push().key!,
      )) {
        nextNode[key] = value;
        carriedOpaqueKeys.push(key);
      }
      // Deleting the last remaining note must remove the `vodTimestamps`
      // node entirely (`null`), not leave a stray empty object behind —
      // matches real RTDB's null-removes-the-key semantics and this
      // codebase's "absent key, not empty container" convention. Preserved
      // opaque keys count as children here (review WR-08): deleting the
      // last VALID note keeps the node alive when a corrupt sibling
      // remains.
      return Object.keys(nextNode).length === 0 ? null : nextNode;
    });

    if (result.committed) {
      warnOpaqueNoteCarry('removeNote', carriedOpaqueKeys);
    }
    // Derive success from the committed result AND the final run's flag —
    // never a stale flag from a discarded run (review CR-01).
    return result.committed && found;
  }

  /**
   * Edits an existing note's `seconds`/`note`/`tags` in place — `coach`
   * attribution (if any) is left untouched (only 08-03's coach path ever
   * sets it, and only on create). The owner path may edit ANY note on an
   * owned match (no own-note-only restriction — owner moderation).
   */
  async updateNote(
    uid: string,
    matchId: string,
    noteId: string,
    input: VodTimestampInput,
  ): Promise<VodTimestamp> {
    const updated = await this.writeNoteUpdate(uid, matchId, noteId, (current) => ({
      seconds: input.seconds,
      note: input.note,
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(current.coach != null ? { coach: current.coach } : {}),
    }));
    if (!updated) {
      throw new NotFoundError(`Note ${noteId} not found on match ${matchId}`);
    }
    return updated;
  }

  /**
   * Deletes a note (owner moderation — deletes coach-authored notes too).
   */
  async deleteNote(uid: string, matchId: string, noteId: string): Promise<void> {
    const removed = await this.removeNote(uid, matchId, noteId);
    if (!removed) {
      throw new NotFoundError(`Note ${noteId} not found on match ${matchId}`);
    }
  }

  // ---- opponents/{uid}/{name} --------------------------------------------

  async listOpponents(uid: string): Promise<string[]> {
    const snapshot = await this.database.ref(`opponents/${uid}`).get();
    if (!snapshot.exists()) {
      return [];
    }
    // safeParse-and-skip (production-gap rule): a corrupt node (Cloud Run
    // logs showed one user's node stored as a bare boolean) or a corrupt
    // entry value must never 500 the whole list.
    const raw: unknown = snapshot.val();
    if (raw === null || typeof raw !== 'object') {
      console.warn(
        `listOpponents: skipping corrupt opponents node (expected record, got ${typeof raw})`,
      );
      return [];
    }
    const parsed = opponentMapSchema.safeParse(raw);
    if (parsed.success) {
      return Object.keys(parsed.data);
    }
    // Salvage entry-wise: an opponent name is the key; keep every key whose
    // value is the canonical `true`, skip (and log) anything else.
    const entries = Object.entries(raw as Record<string, unknown>);
    const skipped = entries.filter(([, value]) => value !== true).length;
    if (skipped > 0) {
      console.warn(
        `listOpponents: skipping ${skipped} corrupt opponent entr${skipped === 1 ? 'y' : 'ies'}`,
      );
    }
    return entries.filter(([, value]) => value === true).map(([name]) => name);
  }

  private async addOpponent(uid: string, name: string): Promise<void> {
    await this.database.ref(`opponents/${uid}/${name}`).set(true);
  }

  // ---- opponentAliases/{uid}/{alias} -------------------------------------

  async listOpponentAliases(uid: string): Promise<OpponentAliasMap> {
    const snapshot = await this.database.ref(`opponentAliases/${uid}`).get();
    if (!snapshot.exists()) {
      return {};
    }
    return opponentAliasMapSchema.parse(snapshot.val());
  }

  /**
   * Writes `alias -> canonical`. To keep the map flat (no chains, so every
   * value is always itself a terminal/non-aliased name), the requested
   * `canonical` is first resolved through the existing map — if `canonical`
   * is itself currently an alias for some other name, the alias is pointed
   * at that final name instead. After resolution, `alias === canonical`
   * (a self-merge) is rejected with `ValidationError` (maps to 400).
   *
   * Note this does NOT re-point other aliases that already targeted `alias`
   * itself (i.e. if `alias` was previously used as someone's canonical
   * value) — per the locked design, resolution happens at write time on the
   * new edge only; a name being merged away while other aliases still point
   * at it is expected to be rare and is surfaced via the "Merged names" UI
   * card so the user can review before merging further.
   */
  async setOpponentAlias(uid: string, alias: string, canonical: string): Promise<OpponentAliasMap> {
    const map = await this.listOpponentAliases(uid);
    const resolved = this.resolveCanonical(map, canonical);

    if (alias === resolved) {
      throw new ValidationError('An opponent cannot be merged into itself');
    }

    const next = { ...map, [alias]: resolved };
    await this.database.ref(`opponentAliases/${uid}/${alias}`).set(resolved);
    return next;
  }

  async deleteOpponentAlias(uid: string, alias: string): Promise<void> {
    const ref = this.database.ref(`opponentAliases/${uid}/${alias}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Alias ${alias} not found`);
    }
    await ref.remove();
  }

  /** Follows `map` from `name` until reaching a name that isn't itself an alias key. */
  private resolveCanonical(map: OpponentAliasMap, name: string): string {
    const seen = new Set<string>();
    let current = name;
    while (Object.prototype.hasOwnProperty.call(map, current) && !seen.has(current)) {
      seen.add(current);
      current = map[current]!;
    }
    return current;
  }

  // ---- opponentNotes/{uid}/{canonicalName} -------------------------------

  async listOpponentNotes(uid: string): Promise<OpponentNoteMap> {
    const snapshot = await this.database.ref(`opponentNotes/${uid}`).get();
    if (!snapshot.exists()) {
      return {};
    }
    return opponentNoteMapSchema.parse(snapshot.val());
  }

  /**
   * Writes (fully replaces) the note for `name`, stamping `updatedAt` with
   * the current server time — the client never dictates "now" (same
   * convention as `createMatch`/`updateMatch`'s `time` field).
   */
  async setOpponentNote(
    uid: string,
    name: string,
    input: UpsertOpponentNoteInput,
  ): Promise<OpponentNote> {
    const note: OpponentNote = {
      updatedAt: Date.now(),
      // RTDB rejects `undefined` values outright, so optional fields must
      // only be present when actually provided (same pattern as
      // createMatch's optional fields).
      ...(input.habits !== undefined ? { habits: input.habits } : {}),
      ...(input.banThese !== undefined ? { banThese: input.banThese } : {}),
      ...(input.watchFor !== undefined ? { watchFor: input.watchFor } : {}),
    };
    await this.database.ref(`opponentNotes/${uid}/${name}`).set(opponentNoteSchema.parse(note));
    return note;
  }

  async deleteOpponentNote(uid: string, name: string): Promise<void> {
    const ref = this.database.ref(`opponentNotes/${uid}/${name}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Note for ${name} not found`);
    }
    await ref.remove();
  }

  // ---- gspSettings/{uid} --------------------------------------------------

  /**
   * Returns the user's saved GSP settings, or a synthesized default
   * (`DEFAULT_ELITE_THRESHOLD`, `updatedAt: 0`) when they haven't saved any
   * yet — chosen over a 404 so every caller (web hook included) can treat
   * "no settings saved" and "settings saved" uniformly instead of branching
   * on response status; `updatedAt: 0` lets the UI still detect "never
   * actually saved" if it needs to (a real save always produces `Date.now()`,
   * which is enormously larger).
   */
  async getGspSettings(uid: string): Promise<GspSettings> {
    const snapshot = await this.database.ref(`gspSettings/${uid}`).get();
    if (!snapshot.exists()) {
      return { eliteThreshold: DEFAULT_ELITE_THRESHOLD, updatedAt: 0 };
    }
    return gspSettingsSchema.parse(snapshot.val());
  }

  /** Writes (fully replaces) the user's GSP settings, stamping `updatedAt` server-side (same convention as `setOpponentNote`). */
  async setGspSettings(uid: string, input: UpsertGspSettingsInput): Promise<GspSettings> {
    const settings: GspSettings = {
      eliteThreshold: input.eliteThreshold,
      updatedAt: Date.now(),
    };
    await this.database.ref(`gspSettings/${uid}`).set(gspSettingsSchema.parse(settings));
    return settings;
  }

  // ---- gspReadings/{uid}/{pushKey} ----------------------------------------

  /**
   * V17: standalone "set GSP without a match" calibration readings (see
   * packages/shared/src/gspReading.ts for why they exist). List follows the
   * safeParse-and-skip rule from the production-gap checklist — one corrupt
   * record must never 500 the whole list.
   */
  async listGspReadings(uid: string): Promise<GspReading[]> {
    const snapshot = await this.database.ref(`gspReadings/${uid}`).get();
    if (!snapshot.exists()) {
      return [];
    }

    const raw = snapshot.val() as Record<string, unknown>;
    return Object.entries(raw).flatMap(([id, value]) => {
      const parsed = gspReadingRecordSchema.safeParse(value);
      return parsed.success ? [{ id, ...parsed.data }] : [];
    });
  }

  /** Creates a calibration reading, stamping `time` server-side (same convention as `createMatch`). */
  async createGspReading(uid: string, input: CreateGspReadingInput): Promise<GspReading> {
    const record: GspReadingRecord = {
      fighter_id: input.fighter_id,
      gsp: input.gsp,
      time: Date.now(),
    };

    const ref = this.database.ref(`gspReadings/${uid}`).push();
    await ref.set(record);

    const id = ref.key;
    if (!id) {
      throw new Error('Failed to generate a push key for the new GSP reading');
    }

    return { id, ...record };
  }

  /**
   * Corrects a reading's GSP value. `time` and `fighter_id` are immutable —
   * editing corrects a flubbed digit, it doesn't re-date or re-home the
   * reading (mirrors `updateMatch`'s time rule).
   */
  async updateGspReading(
    uid: string,
    id: string,
    input: UpdateGspReadingInput,
  ): Promise<GspReading> {
    const ref = this.database.ref(`gspReadings/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`GSP reading ${id} not found`);
    }
    const current = gspReadingRecordSchema.parse(existing.val());

    const record: GspReadingRecord = { ...current, gsp: input.gsp };
    await ref.set(record);
    return { id, ...record };
  }

  async deleteGspReading(uid: string, id: string): Promise<void> {
    const ref = this.database.ref(`gspReadings/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`GSP reading ${id} not found`);
    }
    await ref.remove();
  }

  // ---- stageFavorites/{uid} -----------------------------------------------

  /**
   * Returns the user's favorited stage ids, synthesizing an empty default
   * (`stageIds: [], updatedAt: 0`) when they've never saved any — same
   * no-404 convention as `getGspSettings`. The schema's `stageIds` default
   * also covers the record RTDB leaves behind after the last favorite is
   * removed (RTDB drops empty arrays on write, so only `updatedAt` survives).
   */
  async getStageFavorites(uid: string): Promise<StageFavorites> {
    const snapshot = await this.database.ref(`stageFavorites/${uid}`).get();
    if (!snapshot.exists()) {
      return { stageIds: [], updatedAt: 0 };
    }
    return stageFavoritesSchema.parse(snapshot.val());
  }

  /**
   * Writes (fully replaces) the user's favorite-stage list, deduping ids
   * (first-occurrence-wins, preserving the user's chosen order) and stamping
   * `updatedAt` server-side.
   */
  async setStageFavorites(uid: string, input: UpsertStageFavoritesInput): Promise<StageFavorites> {
    const favorites: StageFavorites = {
      stageIds: [...new Set(input.stageIds)],
      updatedAt: Date.now(),
    };
    await this.database.ref(`stageFavorites/${uid}`).set(stageFavoritesSchema.parse(favorites));
    return favorites;
  }

  // ---- playlists/{uid}/{pushKey} -------------------------------------------

  /**
   * VOD Manager overhaul: user-curated ordered collections of match ids (see
   * packages/shared/src/playlist.ts for the data-model rationale). List
   * follows the safeParse-and-skip rule from the production-gap checklist —
   * one corrupt record must never 500 the whole list (mirrors
   * `listGspReadings`).
   */
  async listPlaylists(uid: string): Promise<Playlist[]> {
    const snapshot = await this.database.ref(`playlists/${uid}`).get();
    if (!snapshot.exists()) {
      return [];
    }

    const raw = snapshot.val() as Record<string, unknown>;
    return Object.entries(raw).flatMap(([id, value]) => {
      const parsed = playlistRecordSchema.safeParse(value);
      return parsed.success ? [{ id, ...parsed.data }] : [];
    });
  }

  /**
   * Creates a playlist, stamping `createdAt` server-side and starting with
   * no matches. Enforces `MAX_PLAYLISTS_PER_USER` (unbounded per-user growth
   * is a DoS vector — see the plan's threat model T-04-04).
   */
  async createPlaylist(uid: string, input: CreatePlaylistInput): Promise<Playlist> {
    const existingSnapshot = await this.database.ref(`playlists/${uid}`).get();
    const existingCount = existingSnapshot.exists()
      ? Object.keys(existingSnapshot.val() as Record<string, unknown>).length
      : 0;
    if (existingCount >= MAX_PLAYLISTS_PER_USER) {
      throw new ForbiddenError(`You can create at most ${MAX_PLAYLISTS_PER_USER} playlists`);
    }

    const record: PlaylistRecord = {
      name: input.name,
      createdAt: Date.now(),
      matchIds: [],
    };

    const ref = this.database.ref(`playlists/${uid}`).push();
    await ref.set(record);

    const id = ref.key;
    if (!id) {
      throw new Error('Failed to generate a push key for the new playlist');
    }

    return { id, ...record };
  }

  /**
   * Updates a playlist's name and/or matchIds. Merges against the current
   * record first (conditional-spread) so a rename-only or reorder-only call
   * never wipes the field the caller omitted — RTDB's `.set()` is a full
   * overwrite, and `undefined` values are rejected outright, so a naive
   * `{ ...input }` write would drop whichever field wasn't sent.
   */
  async updatePlaylist(uid: string, id: string, input: UpdatePlaylistInput): Promise<Playlist> {
    const ref = this.database.ref(`playlists/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Playlist ${id} not found`);
    }
    const current = playlistRecordSchema.parse(existing.val());

    const record: PlaylistRecord = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.matchIds !== undefined ? { matchIds: input.matchIds } : {}),
    };

    await ref.set(playlistRecordSchema.parse(record));
    return { id, ...record };
  }

  async deletePlaylist(uid: string, id: string): Promise<void> {
    const ref = this.database.ref(`playlists/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Playlist ${id} not found`);
    }
    await ref.remove();
  }

  // ---- shares: shareSnapshots/{shareId} + shareTokens/{token} + sharesByUser/{uid}/{shareId} ----

  /**
   * True when an edit-tier token's `expiresAt` has elapsed — expired is
   * treated like revoked everywhere: dead on every anonymous path, excluded
   * from the active-share cap, and labeled distinctly in the manage list
   * (review WR-05). View-tier tokens never carry `expiresAt`.
   */
  private static isTokenExpired(token: ShareToken): boolean {
    return token.expiresAt != null && token.expiresAt < Date.now();
  }

  /**
   * Counts the caller's ACTIVE (non-revoked, non-EXPIRED) shares by joining
   * `sharesByUser/{uid}` -> `shareTokens/{token}` and filtering on
   * `revokedAt == null` plus an unelapsed `expiresAt` — mirrors
   * `listSharesForUser`'s per-record safeParse-and-skip so a missing/corrupt
   * token record never inflates the count or throws. Used by `createShare`'s
   * `MAX_SHARES_PER_USER` check (review CR-01); revoked shares stay in the
   * index for history (SHARE-04) but must never count toward the active cap,
   * and neither must dead 30-day coaching links (review WR-05) — otherwise
   * expired shares would permanently consume cap slots that only a manual
   * revoke could free.
   */
  private async countActiveShares(uid: string): Promise<number> {
    const indexSnapshot = await this.database.ref(`sharesByUser/${uid}`).get();
    if (!indexSnapshot.exists()) {
      return 0;
    }
    const index = indexSnapshot.val() as Record<string, unknown>;

    const activeFlags = await Promise.all(
      Object.values(index).map(async (tokenValue): Promise<boolean> => {
        if (typeof tokenValue !== 'string') {
          return false;
        }
        const tokenSnapshot = await this.database.ref(`shareTokens/${tokenValue}`).get();
        if (!tokenSnapshot.exists()) {
          return false;
        }
        const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
        return (
          parsedToken.success &&
          parsedToken.data.revokedAt == null &&
          !RtdbService.isTokenExpired(parsedToken.data)
        );
      }),
    );

    return activeFlags.filter(Boolean).length;
  }

  /**
   * Creates a redacted snapshot COPY of `matches/{uid}/{input.matchId}` at
   * THIS moment — never re-read live afterward (SHARE-01). Enforces
   * `MAX_SHARES_PER_USER` on the count of ACTIVE (non-revoked) shares only —
   * mirrors the join `listSharesForUser` already does (resolve each
   * `sharesByUser/{uid}` entry's token record, safeParse-and-skip a
   * missing/corrupt one) so a user who revokes old links can always create
   * new ones, matching both this cap's own intent and the "revoke frees up
   * room" UI copy (review CR-01). Ownership is enforced by path shape:
   * `matches/{uid}/{matchId}` is scoped to the caller's own uid, never a
   * body-supplied one (T-05-04).
   *
   * NOTE (review WR-03, accepted): this is a read-then-write cap check —
   * two concurrent `createShare` calls for the same uid could both read the
   * same pre-increment active count and both pass. Same non-atomic pattern
   * already present in `createPlaylist`'s cap check; not worth a
   * transactional redesign for a solo-user-scoped, 100-share cap. Left as a
   * documented, accepted race rather than silently unaddressed.
   *
   * `sharesByUser/{uid}/{shareId}` stores the ISSUED TOKEN (not a bare
   * `true`): this doubles as both the owner index (existence + the token
   * lookup the cap-check join needs) and the shareId->token lookup
   * `listSharesForUser`/`revokeShare` need, without a second global-scope
   * index or an `orderByChild` RTDB rule (`database.rules.json` stays
   * deny-all/unchanged this phase — T-05-07 accept disposition).
   *
   * Phase 7: branches on `input.kind`. The 'recap' branch reads
   * `tournamentEntries/${uid}/${input.entryKey}` — ownership enforced by
   * PATH SHAPE, uid always from the auth context, never the body
   * (T-05-04/T-07-03-01) — plus the caller's FULL `matches/${uid}` list
   * (aggregation needs every match, unlike a single-match review share),
   * and calls `buildRecapSnapshot` instead of `buildShareSnapshot`. Both
   * branches still share the same cap check, push-keyed
   * `shareSnapshots/{shareId}`, `shareTokens/{token}`, and
   * `sharesByUser/{uid}/{shareId}` write tail.
   */
  async createShare(
    uid: string,
    input: CreateShareInput,
    webBaseUrl: string,
  ): Promise<ShareCreatedResponse> {
    const activeCount = await this.countActiveShares(uid);
    if (activeCount >= MAX_SHARES_PER_USER) {
      throw new ForbiddenError(`You can create at most ${MAX_SHARES_PER_USER} shares`);
    }

    let storedSnapshot: ShareSnapshot | RecapSnapshot;

    if (input.kind === 'recap') {
      // entryKey is guaranteed present by createShareInputSchema's refine.
      const entryKey = input.entryKey!;
      // Shape-check BEFORE any RTDB path interpolation (review WR-01): a
      // crafted key with `.`/`#`/`$`/`[`/`]` would make `ref()` throw
      // synchronously (500), and one with `/` would read a NESTED child of a
      // real entry. Both collapse to the same 404 an absent entry produces.
      if (!ENTRY_KEY_SHAPE.test(entryKey)) {
        throw new NotFoundError(`Tournament entry ${entryKey} not found`);
      }
      const entrySnapshot = await this.database.ref(`tournamentEntries/${uid}/${entryKey}`).get();
      if (!entrySnapshot.exists()) {
        throw new NotFoundError(`Tournament entry ${entryKey} not found`);
      }
      // Stamp entryKey from the path segment we just read BY (never trust a
      // stored/legacy value) — mirrors GET /api/tournaments' own convention.
      // safeParse -> 404 (review WR-01): a corrupt stored entry must produce
      // the same not-found outcome as an absent one, never a 500.
      const parsedEntry = tournamentEntrySchema.safeParse({
        ...(entrySnapshot.val() as object),
        entryKey,
      });
      if (!parsedEntry.success) {
        throw new NotFoundError(`Tournament entry ${entryKey} not found`);
      }
      const entry = parsedEntry.data;
      const matches = await this.listMatches(uid);
      // Walkthrough amendment (07-09): absent `detail` defaults to 'full'
      // (the new recommended default) — deliberately applied HERE, not as a
      // zod `.default()` on the input schema, so every existing 'review'
      // caller (which never sends `detail`) keeps compiling unchanged.
      storedSnapshot = buildRecapSnapshot(
        uid,
        entry,
        matches,
        input.ownerDisplayName,
        input.detail ?? 'full',
      );
    } else {
      // 'review' (default) — matchId/redaction guaranteed present by
      // createShareInputSchema's refine.
      const matchId = input.matchId!;
      const redaction = input.redaction!;

      const matchSnapshot = await this.database.ref(`matches/${uid}/${matchId}`).get();
      if (!matchSnapshot.exists()) {
        throw new NotFoundError(`Match ${matchId} not found`);
      }
      const match = matchRecordSchema.parse(matchSnapshot.val());
      if (!match.vodUrl) {
        throw new ValidationError('This match has no VOD to share');
      }

      storedSnapshot = buildShareSnapshot(uid, matchId, match, redaction, input.ownerDisplayName);
    }

    const shareRef = this.database.ref('shareSnapshots').push();
    const shareId = shareRef.key;
    if (!shareId) {
      throw new Error('Failed to generate a push key for the new share');
    }
    await shareRef.set(
      input.kind === 'recap'
        ? recapSnapshotSchema.parse(storedSnapshot)
        : shareSnapshotSchema.parse(storedSnapshot),
    );

    const token = generateShareToken();
    // Phase 8 (Coaching Edit Sessions): `permissions` comes from the
    // validated input (defaulted to 'view' by createShareInputSchema for
    // every pre-Phase-8 caller) instead of being hardcoded. Edit-tier links
    // additionally get a 30-day `expiresAt` — view-tier links never get one
    // (omit the key entirely rather than writing `null`, per the RTDB
    // null-stripping convention in CONCERNS.md).
    const tokenRecord: ShareToken = {
      shareId,
      ownerUid: uid,
      permissions: input.permissions,
      createdAt: Date.now(),
      ...(input.permissions === 'edit' ? { expiresAt: Date.now() + THIRTY_DAYS_MS } : {}),
    };
    await this.database.ref(`shareTokens/${token}`).set(shareTokenSchema.parse(tokenRecord));
    await this.database.ref(`sharesByUser/${uid}/${shareId}`).set(token);

    return { shareId, token, url: `${webBaseUrl}/s/${token}` };
  }

  /**
   * Lists the caller's shares (active + revoked, SHARE-05). Joins
   * `sharesByUser/{uid}/{shareId}` -> `shareSnapshots/{shareId}` +
   * `shareTokens/{token}` per record; a missing or corrupt record at either
   * hop is skipped (safeParse-and-skip), never breaking the whole list —
   * mirrors `listPlaylists`'s per-record error isolation.
   *
   * Phase 7: branches the per-row shape on the stored snapshot's `kind` —
   * a recap row carries `tournamentName`/`placement`; a vod-review row is
   * unchanged. The raw record is checked for `kind === 'recap'` BEFORE
   * choosing which storage schema to `safeParse` against (recapSnapshotSchema
   * vs. shareSnapshotSchema), since a vod-review record predates `kind`
   * entirely and has no such field to disambiguate on its own.
   */
  async listSharesForUser(uid: string, webBaseUrl: string): Promise<ShareSummary[]> {
    const indexSnapshot = await this.database.ref(`sharesByUser/${uid}`).get();
    if (!indexSnapshot.exists()) {
      return [];
    }
    const index = indexSnapshot.val() as Record<string, unknown>;

    const rows = await Promise.all(
      Object.entries(index).map(async ([shareId, tokenValue]): Promise<ShareSummary | null> => {
        if (typeof tokenValue !== 'string') {
          return null;
        }

        const [snapshotSnapshot, tokenSnapshot] = await Promise.all([
          this.database.ref(`shareSnapshots/${shareId}`).get(),
          this.database.ref(`shareTokens/${tokenValue}`).get(),
        ]);
        if (!snapshotSnapshot.exists() || !tokenSnapshot.exists()) {
          return null;
        }

        const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
        if (!parsedToken.success) {
          return null;
        }
        const token = parsedToken.data;
        const rawSnapshot = snapshotSnapshot.val();

        if ((rawSnapshot as { kind?: unknown } | null)?.kind === 'recap') {
          const parsedRecap = recapSnapshotSchema.safeParse(rawSnapshot);
          if (!parsedRecap.success) {
            return null;
          }
          const recap = parsedRecap.data;

          return {
            shareId,
            permissions: token.permissions,
            createdAt: recap.createdAt,
            kind: 'recap',
            // Review WR-05: an elapsed expiresAt surfaces as 'expired'
            // (revocation wins when both apply — it was an explicit action).
            status: token.revokedAt
              ? 'revoked'
              : RtdbService.isTokenExpired(token)
                ? 'expired'
                : 'active',
            ...(token.revokedAt !== undefined && token.revokedAt !== null
              ? { revokedAt: token.revokedAt }
              : {}),
            url: `${webBaseUrl}/s/${tokenValue}`,
            tournamentName: recap.tournamentName,
            ...(recap.placement != null ? { placement: recap.placement } : {}),
          };
        }

        const parsedSnapshot = shareSnapshotSchema.safeParse(rawSnapshot);
        if (!parsedSnapshot.success) {
          return null;
        }
        const snapshot = parsedSnapshot.data;

        return {
          shareId,
          matchId: snapshot.matchId,
          permissions: token.permissions,
          createdAt: snapshot.createdAt,
          redaction: snapshot.redaction,
          // Review WR-05: see the recap branch's status comment above.
          status: token.revokedAt
            ? 'revoked'
            : RtdbService.isTokenExpired(token)
              ? 'expired'
              : 'active',
          ...(token.revokedAt !== undefined && token.revokedAt !== null
            ? { revokedAt: token.revokedAt }
            : {}),
          url: `${webBaseUrl}/s/${tokenValue}`,
          result: snapshot.result,
          fighterId: snapshot.fighterId,
          opponentFighterId: snapshot.opponentFighterId,
          ...(snapshot.stage ? { stage: snapshot.stage } : {}),
        };
      }),
    );

    return rows.filter((row): row is ShareSummary => row !== null);
  }

  /**
   * Soft-revokes a share by setting `revokedAt` on its token record — NEVER
   * `ref.remove()` (the locked "no hard delete" decision; the manage list
   * keeps revoked history, SHARE-04). Scoped to `uid` via
   * `sharesByUser/{uid}/{shareId}`'s existence, exactly like
   * `deletePlaylist` scopes via `playlists/{uid}/{id}` — 404s for a missing
   * OR foreign share, never leaking which case it was.
   */
  async revokeShare(uid: string, shareId: string): Promise<void> {
    const indexRef = this.database.ref(`sharesByUser/${uid}/${shareId}`);
    const indexSnapshot = await indexRef.get();
    if (!indexSnapshot.exists() || typeof indexSnapshot.val() !== 'string') {
      throw new NotFoundError(`Share ${shareId} not found`);
    }
    const token = indexSnapshot.val() as string;

    const tokenRef = this.database.ref(`shareTokens/${token}`);
    const tokenSnapshot = await tokenRef.get();
    if (!tokenSnapshot.exists()) {
      throw new NotFoundError(`Share ${shareId} not found`);
    }

    await tokenRef.update({ revokedAt: Date.now() });
  }

  /**
   * Hard-deletes a share — ACTIVE or revoked — removing the token, the
   * snapshot, and the owner-index entry in one atomic root-level multi-path
   * update. Walkthrough amendment (FB-03, My Shares management overhaul):
   * removing `shareTokens/{token}` directly kills all anonymous access to
   * an active share atomically, so deletion no longer requires a separate
   * revoke-first step (overrides the earlier Phase 5 "no hard delete
   * without revoke first" decision, per explicit owner feedback) —
   * deletion is now a single owner action, not a two-step confirm chain.
   */
  async deleteShare(uid: string, shareId: string): Promise<void> {
    const indexRef = this.database.ref(`sharesByUser/${uid}/${shareId}`);
    const indexSnapshot = await indexRef.get();
    if (!indexSnapshot.exists() || typeof indexSnapshot.val() !== 'string') {
      throw new NotFoundError(`Share ${shareId} not found`);
    }
    const token = indexSnapshot.val() as string;

    const tokenSnapshot = await this.database.ref(`shareTokens/${token}`).get();
    if (!tokenSnapshot.exists()) {
      throw new NotFoundError(`Share ${shareId} not found`);
    }

    // Root-level multi-path update: null values delete keys atomically.
    // Server-only write path — never expressible through client RTDB rules.
    await this.database.ref().update({
      [`shareTokens/${token}`]: null,
      [`shareSnapshots/${shareId}`]: null,
      [`sharesByUser/${uid}/${shareId}`]: null,
    });
  }

  /**
   * Walkthrough amendment (FB-03, My Shares management overhaul): batch
   * revoke or delete up to `MAX_SHARES_PER_USER` shares in ONE round-trip
   * and ONE atomic root-level multi-path update — never N calls to
   * `revokeShare`/`deleteShare` per id (RESEARCH Pitfall 6). Resolves every
   * requested shareId in parallel via the SAME two-hop join
   * `listSharesForUser`/`revokeShare`/`deleteShare` use
   * (`sharesByUser/{uid}/{shareId}` -> token -> `shareTokens/{token}`),
   * scoped to `uid` ONLY — a shareId with no index entry under the
   * caller's uid (missing OR owned by someone else) is unresolved and
   * skipped, never actioned or reported as an error (T-09-03).
   *
   * - `'revoke'`: actionable = resolved AND not already revoked (an
   *   already-revoked or foreign/missing id is skipped, never re-stamped
   *   or errored).
   * - `'delete'`: actionable = resolved, regardless of revoked state —
   *   inherits `deleteShare`'s own active-deletable relaxation above (only
   *   a missing/foreign id is skipped).
   *
   * Never throws for a skipped id; returns `{ processed, skipped }`
   * counts instead. Performs no write at all when the actionable set is
   * empty.
   */
  async bulkUpdateShares(
    uid: string,
    action: 'revoke' | 'delete',
    shareIds: string[],
  ): Promise<{ processed: number; skipped: number }> {
    const resolved = await Promise.all(
      shareIds.map(async (shareId) => {
        // Review WR-02 (guard-before-ref discipline, WR-07): a crafted or
        // corrupt shareId containing an RTDB-illegal character (`.#$[]`,
        // controls) would make ref() throw synchronously inside this map
        // callback, rejecting the whole Promise.all and 500ing the route —
        // skip it instead, honoring the skip-not-fail contract above.
        if (!ENTRY_KEY_SHAPE.test(shareId)) {
          return null;
        }
        const indexSnapshot = await this.database.ref(`sharesByUser/${uid}/${shareId}`).get();
        const tokenValue = indexSnapshot.val();
        if (!indexSnapshot.exists() || typeof tokenValue !== 'string') {
          return null;
        }
        const tokenSnapshot = await this.database.ref(`shareTokens/${tokenValue}`).get();
        if (!tokenSnapshot.exists()) {
          return null;
        }
        const tokenRecord = tokenSnapshot.val() as { revokedAt?: number | null };
        return { shareId, token: tokenValue, revokedAt: tokenRecord.revokedAt };
      }),
    );

    const actionable = resolved.filter(
      (
        entry,
      ): entry is { shareId: string; token: string; revokedAt: number | null | undefined } => {
        if (entry === null) {
          return false;
        }
        return action === 'revoke' ? entry.revokedAt == null : true;
      },
    );

    const updates: Record<string, unknown> = {};
    for (const entry of actionable) {
      if (action === 'revoke') {
        updates[`shareTokens/${entry.token}/revokedAt`] = Date.now();
      } else {
        updates[`shareTokens/${entry.token}`] = null;
        updates[`shareSnapshots/${entry.shareId}`] = null;
        updates[`sharesByUser/${uid}/${entry.shareId}`] = null;
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.database.ref().update(updates);
    }

    return { processed: actionable.length, skipped: shareIds.length - actionable.length };
  }

  /**
   * Phase 6 (Anonymous Share Experience & Discord Unfurls): resolves a
   * bearer `token` to the redacted, uid/matchId-free public snapshot
   * anonymous callers (the JSON endpoint, the OG meta/image pipeline) are
   * allowed to see. Two-hop join, mirroring `listSharesForUser`'s shape:
   * `shareTokens/{token}` (revocation check) -> `shareSnapshots/{shareId}`.
   *
   * Returns `null` — never throws — for: an unknown token, a
   * corrupt/unparseable token or snapshot record, a MALFORMED token (any
   * character outside the base64url alphabet `generateShareToken` emits —
   * checked BEFORE any RTDB read, since firebase-admin's `ref()` throws
   * synchronously on `.`/`#`/`$`/`[`/`]` and a crafted `/s/foo.bar` probe
   * must collapse to the same null/404 as an unknown token, never a 500
   * charset oracle), AND a revoked token (`revokedAt` set). Unknown,
   * malformed, and revoked are deliberately indistinguishable from this
   * method's return type alone (VIEW-05's no-oracle rule) — callers map
   * `null` to an identical 404.
   *
   * `revokedAt` is re-checked against RTDB on EVERY call — this method's
   * result must never be cached (RESEARCH.md Pitfall 4): a cached "active"
   * result would break the "revocation takes effect immediately" guarantee.
   *
   * Never reads `matches/{uid}` — only `shareTokens/` and `shareSnapshots/`
   * (T-06-01: the anonymous path must never reach a user's private match
   * tree).
   *
   * Phase 7: branches on the STORED snapshot's `kind` before choosing which
   * of the two storage schemas (`recapSnapshotSchema`/`shareSnapshotSchema`)
   * applies, then authors its own public snapshot object literal from
   * scratch either way (redaction-by-shape — never spreads the stored
   * record, T-07-03-02).
   */
  async getShareByToken(token: string): Promise<PublicShareSnapshot | null> {
    if (!SHARE_TOKEN_SHAPE.test(token)) {
      return null;
    }
    const tokenSnapshot = await this.database.ref(`shareTokens/${token}`).get();
    if (!tokenSnapshot.exists()) {
      return null;
    }
    const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
    if (!parsedToken.success) {
      return null;
    }
    if (parsedToken.data.revokedAt != null) {
      return null;
    }
    // Phase 8 (Coaching Edit Sessions): an elapsed `expiresAt` (stamped only
    // on edit-tier tokens) is treated IDENTICALLY to revoked — re-checked
    // against RTDB on every call, never cached, no distinguishing oracle.
    if (parsedToken.data.expiresAt != null && parsedToken.data.expiresAt < Date.now()) {
      return null;
    }

    const snapshotSnapshot = await this.database
      .ref(`shareSnapshots/${parsedToken.data.shareId}`)
      .get();
    if (!snapshotSnapshot.exists()) {
      return null;
    }
    const rawSnapshot = snapshotSnapshot.val();

    if ((rawSnapshot as { kind?: unknown } | null)?.kind === 'recap') {
      const parsedRecap = recapSnapshotSchema.safeParse(rawSnapshot);
      if (!parsedRecap.success) {
        return null;
      }
      const recap = parsedRecap.data;

      const publicRecapSnapshot: PublicShareSnapshot = {
        createdAt: recap.createdAt,
        kind: 'recap',
        recapSource: recap.source,
        tournamentName: recap.tournamentName,
        tournamentDate: recap.tournamentDate,
        ...(recap.placement != null ? { placement: recap.placement } : {}),
        ...(recap.seed != null ? { seed: recap.seed } : {}),
        ...(recap.numEntrants != null ? { numEntrants: recap.numEntrants } : {}),
        setRecordWins: recap.setRecordWins,
        setRecordLosses: recap.setRecordLosses,
        ...(recap.notableWin
          ? {
              ...(recap.notableWin.opponentName
                ? { notableWinOpponentName: recap.notableWin.opponentName }
                : {}),
              notableWinOpponentSeed: recap.notableWin.opponentSeed,
            }
          : {}),
        characterFighterIds: recap.characterFighterIds,
        reviewedMomentsCount: recap.reviewedMomentsCount,
        ...(recap.ownerDisplayName ? { ownerDisplayName: recap.ownerDisplayName } : {}),
        // Walkthrough amendment (07-09): detail/tournamentUrl/sets pass
        // through verbatim — already redaction-safe by construction
        // (buildRecapSnapshot only ever stores public bracket data here).
        ...(recap.detail === 'full' ? { detail: 'full' as const } : {}),
        ...(recap.tournamentUrl ? { tournamentUrl: recap.tournamentUrl } : {}),
        ...(recap.sets && recap.sets.length > 0 ? { sets: recap.sets } : {}),
      };

      return publicShareSnapshotSchema.parse(publicRecapSnapshot);
    }

    const parsedSnapshot = shareSnapshotSchema.safeParse(rawSnapshot);
    if (!parsedSnapshot.success) {
      return null;
    }
    const snapshot = parsedSnapshot.data;

    const publicSnapshot: PublicShareSnapshot = {
      createdAt: snapshot.createdAt,
      result: snapshot.result,
      fighterId: snapshot.fighterId,
      opponentFighterId: snapshot.opponentFighterId,
      ...(snapshot.stage ? { stage: snapshot.stage } : {}),
      matchDate: snapshot.matchDate,
      vodUrl: snapshot.vodUrl,
      ...(snapshot.vodStartSeconds != null ? { vodStartSeconds: snapshot.vodStartSeconds } : {}),
      reviewedMomentsCount: snapshot.reviewedMomentsCount,
      ...(snapshot.timestamps ? { timestamps: snapshot.timestamps } : {}),
      ...(snapshot.tags ? { tags: snapshot.tags } : {}),
      ...(snapshot.ownerDisplayName ? { ownerDisplayName: snapshot.ownerDisplayName } : {}),
      redaction: snapshot.redaction,
    };

    return publicShareSnapshotSchema.parse(publicSnapshot);
  }

  // ---- Phase 8 Plan 3: coach edit sessions (anonymous, token-scoped) -----

  /**
   * Resolves an edit-tier bearer token to its owner/match target, or `null`
   * on ANY failure — malformed shape, unknown token, corrupt record,
   * revoked, EXPIRED, or wrong tier (view/recap). All failure modes are
   * deliberately indistinguishable (T-08-13). Called FRESH by every coach
   * read AND write — never cache the result (T-08-12: a revoked/expired
   * token's in-flight write must die on this re-check).
   *
   * This is the gate on the ONE deliberate exception to "anonymous requests
   * never touch `matches/{uid}`" (T-08-08): the owner uid and match id come
   * exclusively from the server-stored token/snapshot records — never from
   * anything the caller supplied beyond the bearer token itself.
   */
  private async resolveEditSession(
    token: string,
  ): Promise<{ tokenRecord: ShareToken; snapshot: ShareSnapshot } | null> {
    if (!SHARE_TOKEN_SHAPE.test(token)) {
      return null;
    }
    const tokenSnapshot = await this.database.ref(`shareTokens/${token}`).get();
    if (!tokenSnapshot.exists()) {
      return null;
    }
    const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
    if (!parsedToken.success) {
      return null;
    }
    if (parsedToken.data.revokedAt != null) {
      return null;
    }
    if (parsedToken.data.expiresAt != null && parsedToken.data.expiresAt < Date.now()) {
      return null;
    }
    if (parsedToken.data.permissions !== 'edit') {
      return null;
    }

    const snapshotSnapshot = await this.database
      .ref(`shareSnapshots/${parsedToken.data.shareId}`)
      .get();
    if (!snapshotSnapshot.exists()) {
      return null;
    }
    // A recap snapshot can never be edit-tier (createShareInputSchema's
    // refine), and would fail this parse anyway — same null outcome.
    const parsedSnapshot = shareSnapshotSchema.safeParse(snapshotSnapshot.val());
    if (!parsedSnapshot.success) {
      return null;
    }

    return { tokenRecord: parsedToken.data, snapshot: parsedSnapshot.data };
  }

  /**
   * The edit-session read (COACH-03): resolves an edit-tier token to a LIVE
   * redacted recompute of the source match — never the frozen
   * `shareSnapshots/{shareId}` copy `getShareByToken` serves. The share's
   * STORED redaction config still applies (the toggles chosen at share
   * time), re-applied field-by-field to live data: a fresh
   * `PublicShareSnapshot`-shaped object is authored from scratch — the raw
   * match record is never spread (redaction-by-shape, T-08-10).
   *
   * Redaction carve-out (resolved research Open Question 1): the
   * `includedNotes` toggle governs the OWNER's notes only — coach-authored
   * notes (any session) are ALWAYS included, so a coach always sees their
   * own contributions mid-session. Every included note carries its `id`,
   * (when coach-authored) a display-name-only `coach` attribution, and a
   * server-computed `own` flag so the client can render edit/delete
   * affordances for exactly the caller's own notes.
   *
   * `callerSessionId` (review WR-02) is the REQUESTING coach's sessionId,
   * sent as a query param on the session read. Stored `coach.sessionId`
   * values are NEVER serialized into the response — they are the secret the
   * write-path ownership guard checks, so publishing them to every
   * edit-token holder would make that guard spoofable with data this very
   * endpoint hands out. Instead each note gets `own: true` iff its stored
   * sessionId matches the caller's claim; a wrong/absent claim only
   * mis-renders the caller's OWN affordances (writes still re-verify the
   * real sessionId inside the transaction).
   *
   * Returns `null` — never throws — for every token failure
   * (`resolveEditSession` above), a deleted source match, a corrupt match
   * record, and a match whose VOD was removed since sharing (nothing left
   * to coach against). All collapse to the caller's identical 404.
   */
  async getEditSessionByToken(
    token: string,
    callerSessionId?: string,
  ): Promise<PublicShareSnapshot | null> {
    const resolved = await this.resolveEditSession(token);
    if (!resolved) {
      return null;
    }
    const { tokenRecord, snapshot } = resolved;

    const matchSnapshot = await this.database
      .ref(`matches/${tokenRecord.ownerUid}/${snapshot.matchId}`)
      .get();
    if (!matchSnapshot.exists()) {
      return null;
    }
    const parsedMatch = matchRecordSchema.safeParse(matchSnapshot.val());
    if (!parsedMatch.success) {
      return null;
    }
    const match = parsedMatch.data;
    if (!match.vodUrl) {
      return null;
    }

    // `matchRecordSchema`'s dual-read preprocess already normalized the
    // stored node (either shape) into an id-bearing, seconds-sorted array.
    const liveNotes = match.vodTimestamps ?? [];
    const visibleTimestamps = liveNotes
      .filter((entry) => entry.coach != null || snapshot.redaction.includedNotes)
      .map((entry) => ({
        seconds: entry.seconds,
        note: entry.note,
        ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
        id: entry.id,
        // Display name ONLY — the stored sessionId never leaves the server
        // (review WR-02); own-ness travels as the computed flag below.
        ...(entry.coach != null ? { coach: { displayName: entry.coach.displayName } } : {}),
        ...(entry.coach != null &&
        callerSessionId !== undefined &&
        entry.coach.sessionId === callerSessionId
          ? { own: true }
          : {}),
      }));

    const session: PublicShareSnapshot = {
      createdAt: snapshot.createdAt,
      permissions: 'edit',
      result: match.win ? 'win' : 'loss',
      fighterId: match.fighter_id,
      opponentFighterId: match.opponent_id,
      ...(match.map ? { stage: match.map } : {}),
      matchDate: match.time,
      vodUrl: match.vodUrl,
      ...(match.vodStartSeconds !== undefined ? { vodStartSeconds: match.vodStartSeconds } : {}),
      // Aggregate over ALL live notes (redacted ones included) — mirrors
      // buildShareSnapshot's redaction-surviving count semantics.
      reviewedMomentsCount: liveNotes.length,
      ...(visibleTimestamps.length > 0 ? { timestamps: visibleTimestamps } : {}),
      ...(snapshot.redaction.includedTags && match.tags && match.tags.length > 0
        ? { tags: match.tags }
        : {}),
      ...(snapshot.ownerDisplayName ? { ownerDisplayName: snapshot.ownerDisplayName } : {}),
      redaction: snapshot.redaction,
    };

    return publicShareSnapshotSchema.parse(session);
  }

  /**
   * Coach note create (COACH-02): resolves the token fresh (revoked AND
   * expired re-checked on this very call), then funnels into `createNote`'s
   * shared capped transaction with the coach attribution stamped on. Cap
   * rejection bubbles as `ForbiddenError` (the route maps it to 403 — a
   * valid-token holder gets a real cap message, not a fake 404).
   *
   * Walkthrough amendment (FB-04): passes the share's `ownerDisplayName`
   * through to `createNote` so the owner's own shared name is also
   * protected against impersonation — a colliding coach name throws
   * `ConflictError` (the route maps it to a static-message 409).
   */
  async createCoachNote(
    token: string,
    sessionId: string,
    displayName: string,
    input: VodTimestampInput,
  ): Promise<VodTimestamp> {
    const resolved = await this.resolveEditSession(token);
    if (!resolved) {
      throw new NotFoundError(SHARE_UNAVAILABLE_MESSAGE);
    }
    return this.createNote(
      resolved.tokenRecord.ownerUid,
      resolved.snapshot.matchId,
      input,
      { sessionId, displayName },
      resolved.snapshot.ownerDisplayName ?? undefined,
    );
  }

  /**
   * Coach note edit (COACH-02/04): session-scoped — the ownership guard
   * runs INSIDE `writeNoteUpdate`'s transaction, and a mismatch (someone
   * else's note, an owner note, or a note that doesn't exist) throws the
   * same `NotFoundError` as a dead token. PATCH semantics: absent fields
   * preserve the existing values (unlike the owner PATCH, whose body always
   * carries the full note).
   */
  async updateCoachNote(
    token: string,
    sessionId: string,
    noteId: string,
    input: Partial<VodTimestampInput>,
  ): Promise<VodTimestamp> {
    const resolved = await this.resolveEditSession(token);
    if (!resolved) {
      throw new NotFoundError(SHARE_UNAVAILABLE_MESSAGE);
    }
    const updated = await this.writeNoteUpdate(
      resolved.tokenRecord.ownerUid,
      resolved.snapshot.matchId,
      noteId,
      (current) => ({
        seconds: input.seconds ?? current.seconds,
        note: input.note ?? current.note,
        ...(input.tags !== undefined
          ? input.tags.length > 0
            ? { tags: input.tags }
            : {}
          : current.tags && current.tags.length > 0
            ? { tags: current.tags }
            : {}),
        ...(current.coach != null ? { coach: current.coach } : {}),
      }),
      sessionId,
    );
    if (!updated) {
      throw new NotFoundError(SHARE_UNAVAILABLE_MESSAGE);
    }
    return updated;
  }

  /**
   * Coach note delete (COACH-02/04): same session-scoped,
   * guard-inside-the-transaction discipline as `updateCoachNote`.
   */
  async deleteCoachNote(token: string, sessionId: string, noteId: string): Promise<void> {
    const resolved = await this.resolveEditSession(token);
    if (!resolved) {
      throw new NotFoundError(SHARE_UNAVAILABLE_MESSAGE);
    }
    const removed = await this.removeNote(
      resolved.tokenRecord.ownerUid,
      resolved.snapshot.matchId,
      noteId,
      sessionId,
    );
    if (!removed) {
      throw new NotFoundError(SHARE_UNAVAILABLE_MESSAGE);
    }
  }
}
