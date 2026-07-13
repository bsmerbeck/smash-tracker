import type { Database } from 'firebase-admin/database';
import {
  DEFAULT_ELITE_THRESHOLD,
  gspReadingRecordSchema,
  gspSettingsSchema,
  matchRecordSchema,
  MAX_PLAYLISTS_PER_USER,
  opponentAliasMapSchema,
  opponentMapSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  playlistRecordSchema,
  stageFavoritesSchema,
  userSchema,
  type CreateGspReadingInput,
  type CreateMatchInput,
  type CreatePlaylistInput,
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
  type UpdateGspReadingInput,
  type UpdateMatchInput,
  type UpdatePlaylistInput,
  type UpsertGspSettingsInput,
  type UpsertOpponentNoteInput,
  type UpsertStageFavoritesInput,
  type User,
} from '@smash-tracker/shared';

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
    return Object.entries(raw).map(([id, value]) => ({
      id,
      ...matchRecordSchema.parse(value),
    }));
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
    const map = opponentMapSchema.parse(snapshot.val());
    return Object.keys(map);
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
}
