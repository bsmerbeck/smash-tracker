import type { InsightMark } from './types.js';

/**
 * Plan 39.1-40 (sketch 002-C, D-13, DD-12, UI-SPEC §7.10): the two card-mark
 * payloads the Trends reads rail draws — SessionFatigue's three game-number
 * buckets and LastEventRecap's set strip — plus validating readers. A mark is
 * display context only: it never changes a verdict, a state or a counted
 * set. Readers never trust a payload's shape (it is typed `unknown` on
 * `InsightMark`): any other kind, a missing mark or a malformed payload reads
 * as `null`, and the card then draws no mark.
 */

/** One game-number bucket: games `fromGame`..`toGame` (1-based, inclusive) of a session; `toGame` null = open-ended. */
export interface SessionBucket {
  fromGame: number;
  toGame: number | null;
  wins: number;
  losses: number;
  total: number;
}

export interface SessionBucketsMark {
  kind: 'sessionBuckets';
  data: { buckets: SessionBucket[] };
}

/** One set of an event, in set order. `opponentName` is null when no game named the opponent. */
export interface SetStripEntry {
  setId: string;
  won: boolean;
  opponentName: string | null;
  gamesWon: number;
  gamesLost: number;
}

export interface SetStripMark {
  kind: 'setStrip';
  data: { sets: SetStripEntry[] };
}

/** SessionFatigue always draws exactly three buckets (1-10, 11-20, 21+). */
const SESSION_BUCKET_COUNT = 3;

export function buildSessionBucketsMark(buckets: SessionBucket[]): SessionBucketsMark {
  return { kind: 'sessionBuckets', data: { buckets: buckets.map((bucket) => ({ ...bucket })) } };
}

export function buildSetStripMark(sets: SetStripEntry[]): SetStripMark {
  return { kind: 'setStrip', data: { sets: sets.map((set) => ({ ...set })) } };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readBucket(value: unknown): SessionBucket | null {
  if (!isRecord(value)) return null;
  const { fromGame, toGame, wins, losses, total } = value;
  if (!isCount(fromGame) || !(toGame === null || isCount(toGame))) return null;
  if (!isCount(wins) || !isCount(losses) || !isCount(total)) return null;
  if (wins + losses !== total) return null;
  return { fromGame, toGame, wins, losses, total };
}

function readSet(value: unknown): SetStripEntry | null {
  if (!isRecord(value)) return null;
  const { setId, won, opponentName, gamesWon, gamesLost } = value;
  if (typeof setId !== 'string' || typeof won !== 'boolean') return null;
  if (!(opponentName === null || typeof opponentName === 'string')) return null;
  if (!isCount(gamesWon) || !isCount(gamesLost)) return null;
  return { setId, won, opponentName, gamesWon, gamesLost };
}

/** The three buckets of a well-formed `sessionBuckets` mark, else null. */
export function readSessionBucketsMark(
  mark: InsightMark | undefined,
): SessionBucketsMark['data'] | null {
  if (!mark || mark.kind !== 'sessionBuckets' || !isRecord(mark.data)) return null;
  const raw = mark.data.buckets;
  if (!Array.isArray(raw) || raw.length !== SESSION_BUCKET_COUNT) return null;
  const buckets: SessionBucket[] = [];
  for (const entry of raw) {
    const bucket = readBucket(entry);
    if (bucket === null) return null;
    buckets.push(bucket);
  }
  return { buckets };
}

/** The sets of a well-formed, non-empty `setStrip` mark, else null. */
export function readSetStripMark(mark: InsightMark | undefined): SetStripMark['data'] | null {
  if (!mark || mark.kind !== 'setStrip' || !isRecord(mark.data)) return null;
  const raw = mark.data.sets;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sets: SetStripEntry[] = [];
  for (const entry of raw) {
    const set = readSet(entry);
    if (set === null) return null;
    sets.push(set);
  }
  return { sets };
}
