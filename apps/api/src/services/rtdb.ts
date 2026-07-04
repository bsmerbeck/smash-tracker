import type { Database } from 'firebase-admin/database';
import {
  matchRecordSchema,
  opponentMapSchema,
  userSchema,
  type CreateMatchInput,
  type FighterSelectionInput,
  type Match,
  type MatchRecord,
  type UpdateMatchInput,
  type User,
} from '@smash-tracker/shared';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
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
}
