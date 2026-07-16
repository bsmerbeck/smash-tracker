import type { Database } from 'firebase-admin/database';
import {
  DEFAULT_ELITE_THRESHOLD,
  gspReadingRecordSchema,
  gspSettingsSchema,
  matchRecordSchema,
  MAX_PLAYLISTS_PER_USER,
  MAX_SHARES_PER_USER,
  opponentAliasMapSchema,
  opponentMapSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  playlistRecordSchema,
  publicShareSnapshotSchema,
  shareSnapshotSchema,
  shareTokenSchema,
  stageFavoritesSchema,
  userSchema,
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
} from '@smash-tracker/shared';
import { buildShareSnapshot } from '../shares/buildShareSnapshot.js';
import { generateShareToken } from '../shares/token.js';

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

  async upsertUser(uid: string, user: User): Promise<void> {
    await this.database.ref(`users/${uid}`).set(user);
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
      ...(input.vodTimestamps !== undefined ? { vodTimestamps: input.vodTimestamps } : {}),
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
      // opponent/vodUrl/vodTimestamps/vodStartSeconds/gsp/tags from the input
      // is how a caller clears them, since this is a full overwrite
      // (`.set()`, not a partial patch).
      ...(input.opponent !== undefined ? { opponent: input.opponent } : {}),
      ...(input.stocksLeft !== undefined ? { stocksLeft: input.stocksLeft } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.tournamentName !== undefined ? { tournamentName: input.tournamentName } : {}),
      ...(input.vodUrl !== undefined ? { vodUrl: input.vodUrl } : {}),
      ...(input.vodTimestamps !== undefined ? { vodTimestamps: input.vodTimestamps } : {}),
      ...(input.vodStartSeconds !== undefined ? { vodStartSeconds: input.vodStartSeconds } : {}),
      ...(input.gsp !== undefined ? { gsp: input.gsp } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      // Server-set provenance survives the overwrite — the full-overwrite
      // rebuild used to strip these, breaking source badges after a VOD edit.
      ...(current.source !== undefined ? { source: current.source } : {}),
      ...(current.externalId !== undefined ? { externalId: current.externalId } : {}),
    };

    await ref.set(record);
    if (input.opponent !== undefined) {
      await this.addOpponent(uid, input.opponent);
    }

    return { id, ...record };
  }

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
    await ref.remove();
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
   * Counts the caller's ACTIVE (non-revoked) shares by joining
   * `sharesByUser/{uid}` -> `shareTokens/{token}` and filtering on
   * `revokedAt == null` — mirrors `listSharesForUser`'s per-record
   * safeParse-and-skip so a missing/corrupt token record never inflates the
   * count or throws. Used by `createShare`'s `MAX_SHARES_PER_USER` check
   * (review CR-01); revoked shares stay in the index for history (SHARE-04)
   * but must never count toward the active cap.
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
        return parsedToken.success && parsedToken.data.revokedAt == null;
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

    const matchSnapshot = await this.database.ref(`matches/${uid}/${input.matchId}`).get();
    if (!matchSnapshot.exists()) {
      throw new NotFoundError(`Match ${input.matchId} not found`);
    }
    const match = matchRecordSchema.parse(matchSnapshot.val());
    if (!match.vodUrl) {
      throw new ValidationError('This match has no VOD to share');
    }

    const shareRef = this.database.ref('shareSnapshots').push();
    const shareId = shareRef.key;
    if (!shareId) {
      throw new Error('Failed to generate a push key for the new share');
    }

    const snapshot: ShareSnapshot = buildShareSnapshot(
      uid,
      input.matchId,
      match,
      input.redaction,
      input.ownerDisplayName,
    );
    await shareRef.set(shareSnapshotSchema.parse(snapshot));

    const token = generateShareToken();
    const tokenRecord: ShareToken = {
      shareId,
      ownerUid: uid,
      permissions: 'view',
      createdAt: Date.now(),
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

        const parsedSnapshot = shareSnapshotSchema.safeParse(snapshotSnapshot.val());
        const parsedToken = shareTokenSchema.safeParse(tokenSnapshot.val());
        if (!parsedSnapshot.success || !parsedToken.success) {
          return null;
        }
        const snapshot = parsedSnapshot.data;
        const token = parsedToken.data;

        return {
          shareId,
          matchId: snapshot.matchId,
          permissions: token.permissions,
          createdAt: snapshot.createdAt,
          redaction: snapshot.redaction,
          status: token.revokedAt ? 'revoked' : 'active',
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
   * Hard-deletes a REVOKED share: removes the token, the snapshot, and the
   * owner-index entry in one atomic root-level multi-path update. Active
   * shares must be revoked first (409) — deletion is a list-hygiene action,
   * never a substitute for the one-way revoke transition.
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
    const tokenRecord = tokenSnapshot.val() as { revokedAt?: number | null };
    if (tokenRecord.revokedAt == null) {
      throw new ConflictError('Revoke the share before deleting it');
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

    const snapshotSnapshot = await this.database
      .ref(`shareSnapshots/${parsedToken.data.shareId}`)
      .get();
    if (!snapshotSnapshot.exists()) {
      return null;
    }
    const parsedSnapshot = shareSnapshotSchema.safeParse(snapshotSnapshot.val());
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
}
