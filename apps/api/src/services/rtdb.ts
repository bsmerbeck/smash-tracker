import type { Database } from 'firebase-admin/database';
import {
  matchRecordSchema,
  opponentAliasMapSchema,
  opponentMapSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  userSchema,
  type CreateMatchInput,
  type FighterSelectionInput,
  type Match,
  type MatchRecord,
  type OpponentAliasMap,
  type OpponentNote,
  type OpponentNoteMap,
  type UpdateMatchInput,
  type UpsertOpponentNoteInput,
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
      opponent: input.opponent,
      notes: input.notes,
      matchType: input.matchType,
      win: input.win,
      // RTDB rejects `undefined` values outright, so optional fields must
      // only be present on the record when the input actually provided
      // them (conditional spread) rather than being set to `undefined`.
      ...(input.stocksLeft !== undefined ? { stocksLeft: input.stocksLeft } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.tournamentName !== undefined ? { tournamentName: input.tournamentName } : {}),
    };

    const ref = this.database.ref(`matches/${uid}`).push();
    await ref.set(record);
    await this.addOpponent(uid, input.opponent);

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

    const record: MatchRecord = {
      fighter_id: input.fighter_id,
      opponent_id: input.opponent_id,
      time: Date.now(),
      map: input.map,
      opponent: input.opponent,
      notes: input.notes,
      matchType: input.matchType,
      win: input.win,
      // See createMatch — RTDB rejects `undefined` values, so these are
      // only included when the input actually set them.
      ...(input.stocksLeft !== undefined ? { stocksLeft: input.stocksLeft } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.tournamentName !== undefined ? { tournamentName: input.tournamentName } : {}),
    };

    await ref.set(record);
    await this.addOpponent(uid, input.opponent);

    return { id, ...record };
  }

  async deleteMatch(uid: string, id: string): Promise<void> {
    const ref = this.database.ref(`matches/${uid}/${id}`);
    const existing = await ref.get();
    if (!existing.exists()) {
      throw new NotFoundError(`Match ${id} not found`);
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
}
