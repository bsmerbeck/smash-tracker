import { MIN_STAGE_MATCHES_OPTIONS, type HorizonKey } from '@smash-tracker/shared';
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
 * D-11/D-24 (Phase 36 R1-MEDIUM-1): the min-matches-per-stage threshold
 * options and default are now defined ONCE, in
 * `packages/shared/src/evidence/policy.ts`, and re-exported here so the
 * number this UI displays and the number the engine computes against can
 * never drift apart (D-05/D-06). The two Phase-35-era options below the
 * abstention floor (1, 2) were removed here because they recreate the 2-0
 * recommendation bug (D-07) — a stored 1/2 still parses tolerantly via
 * `isValidMinStageMatches`'s unchanged membership check, which now simply
 * rejects them, falling back to `DEFAULT_MIN_STAGE_MATCHES` with no rewrite.
 */
export { MIN_STAGE_MATCHES_OPTIONS, DEFAULT_MIN_STAGE_MATCHES } from '@smash-tracker/shared';

/** The stored shape at `analyticsSelectionStorageKey(uid, clientId)`. */
export interface StoredAnalyticsSelection {
  fighterId?: number;
  opponentId?: number;
  minStageMatches?: number;
  /**
   * Plan 39.1-12 (INS-02, D-06): the page-level `HorizonSwitch`'s
   * persisted choice, additive to the three Phase-35 fields above. Written
   * ONLY by `useHorizon`'s `setHorizon` (an explicit user change) — never a
   * computed default (D-06).
   */
  horizon?: HorizonKey;
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

/** The closed `HorizonKey` union (`@smash-tracker/shared`), restated as a runtime membership check for untrusted stored content — a value outside this set (an older/newer build's key, a typo, a stray number) is dropped as absent, never thrown on. */
const HORIZON_KEYS: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90'];

function isValidHorizon(value: unknown): value is HorizonKey {
  return typeof value === 'string' && (HORIZON_KEYS as readonly string[]).includes(value);
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
    if (isValidHorizon(record.horizon)) {
      result.horizon = record.horizon;
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
 * opponentId, minStageMatches, horizon — so writing the same selection twice
 * produces byte-identical storage. No-ops when `uid` is nullish or
 * `window` is undefined. This is the ONLY function that writes to the
 * selection store — called exclusively from `usePersistedSelection`'s
 * `setFighter`/`setOpponent` and (plan 39.1-12) `useHorizon`'s `setHorizon`,
 * each an explicit user change, never from a computed-default path (D-06: a
 * computed default is never persisted).
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
      ...(next.horizon !== undefined && { horizon: next.horizon }),
    };
    window.localStorage.setItem(key, JSON.stringify(ordered));
  } catch {
    // Ignore storage failures — the selection just won't persist this session.
  }
}
