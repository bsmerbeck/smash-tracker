import { getFighterById } from '@/data/sprites';
import { subjectSegment } from '@/lib/subjectQueryKey';

/**
 * Phase 35 (Player-True Defaults & Persistence, D-05): per-(uid, subject)
 * remembered fighter/opponent/min-stage-matches selection, device-local.
 * Cloned from `vodPrefs.ts`'s parse/read/persist triplet discipline
 * verbatim — a `typeof window` guard, try/catch around every storage call,
 * a silent catch with a one-line comment, never rethrow, never log.
 */
export const ANALYTICS_SELECTION_KEY_PREFIX = 'smash-tracker.analyticsSelection';

/**
 * D-11: the converged min-matches-per-stage threshold options, shared by
 * `MatchupInsights.tsx` (today `[1, 2, 3, 5]`) and `MatchupStageGuide.tsx`
 * (today `[1, 2, 3, 5, 10]`) — the union, so no option a user can pick
 * today disappears when both components move to this one shared value
 * (plan 35-03's `useMinStageMatches` is the consumer; nothing in this plan
 * reads it).
 */
export const MIN_STAGE_MATCHES_OPTIONS = [1, 2, 3, 5, 10];
export const DEFAULT_MIN_STAGE_MATCHES = 3;

/** The stored shape at `analyticsSelectionStorageKey(uid, clientId)`. */
export interface StoredAnalyticsSelection {
  fighterId?: number;
  opponentId?: number;
  minStageMatches?: number;
}

/**
 * Composes the uid + subject segment into the full localStorage key.
 * `subjectSegment` (imported, never re-spelled here) is the SINGLE place the
 * `client:` literal is spelled anywhere in the app (NEW-M2) — this key and
 * the `X-Active-Subject` header contract cannot drift apart. The uid is
 * part of the key because `subjectSegment` alone (`'personal'`) would leak
 * across two different logged-in accounts sharing one browser (D-05).
 */
export function analyticsSelectionStorageKey(uid: string, clientId: string | null): string {
  return `${ANALYTICS_SELECTION_KEY_PREFIX}.${uid}.${subjectSegment(clientId)}`;
}

function isValidFighterId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    getFighterById(value) != null
  );
}

function isValidMinStageMatches(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (MIN_STAGE_MATCHES_OPTIONS as readonly number[]).includes(value)
  );
}

/**
 * Parses a stored selection, tolerating missing/malformed content: a
 * nullish or empty `raw`, invalid JSON, a JSON array, or a JSON scalar all
 * parse to `{}`. A `fighterId`/`opponentId` is admitted only when it's a
 * positive integer that `getFighterById` actually resolves — the
 * input-validation boundary for untrusted `localStorage` content (T-35-02);
 * a value failing that check is dropped as if absent, never thrown on.
 */
export function parseStoredSelection(raw: string | null): StoredAnalyticsSelection {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const result: StoredAnalyticsSelection = {};
    if (isValidFighterId(record.fighterId)) {
      result.fighterId = record.fighterId;
    }
    if (isValidFighterId(record.opponentId)) {
      result.opponentId = record.opponentId;
    }
    if (isValidMinStageMatches(record.minStageMatches)) {
      result.minStageMatches = record.minStageMatches;
    }
    return result;
  } catch {
    return {};
  }
}

/** Returns `{}` when `uid` is nullish — there is no subject to read for. */
export function readStoredSelection(
  uid: string | null,
  clientId: string | null,
): StoredAnalyticsSelection {
  if (!uid || typeof window === 'undefined') return {};
  try {
    return parseStoredSelection(
      window.localStorage.getItem(analyticsSelectionStorageKey(uid, clientId)),
    );
  } catch {
    return {};
  }
}

/**
 * Merges only the defined fields of `patch` over the current stored record
 * and writes the result back, in the fixed field order fighterId,
 * opponentId, minStageMatches — so writing the same selection twice
 * produces byte-identical storage. No-ops when `uid` is nullish or
 * `window` is undefined. This is the ONLY function that writes to the
 * selection store — called exclusively from `usePersistedSelection`'s
 * `setFighter`/`setOpponent` (an explicit user change), never from the
 * default-computation path (D-06: a computed default is never persisted).
 */
export function persistSelection(
  uid: string | null,
  clientId: string | null,
  patch: StoredAnalyticsSelection,
): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    const key = analyticsSelectionStorageKey(uid, clientId);
    const current = parseStoredSelection(window.localStorage.getItem(key));
    const next: StoredAnalyticsSelection = { ...current, ...patch };
    const ordered: StoredAnalyticsSelection = {
      ...(next.fighterId !== undefined && { fighterId: next.fighterId }),
      ...(next.opponentId !== undefined && { opponentId: next.opponentId }),
      ...(next.minStageMatches !== undefined && { minStageMatches: next.minStageMatches }),
    };
    window.localStorage.setItem(key, JSON.stringify(ordered));
  } catch {
    // Ignore storage failures — the selection just won't persist this session.
  }
}
