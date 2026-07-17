/**
 * Referral attribution bridge (FUNNEL-02): `ShareViewPage` stamps the current
 * share on mount; `AuthContext.provisionUser` reads (and clears) it once at
 * signup, threading it through as `referredByShareId` on `PUT /api/users/me`
 * (server-side write-once/first-touch — see 07-07-SUMMARY.md). A stale stamp
 * (>30 days) must never re-attribute a returning user, so `read()` enforces
 * the expiry itself.
 *
 * Mirrors `pages/VodManager/lib/vodPrefs.ts`'s localStorage convention: a
 * namespaced `smash-tracker.*` key, a pure `parseStored*` tolerant of
 * malformed content, and every storage call guarded by try/catch (Safari
 * private mode / disabled storage must never throw).
 */

export const SHARE_REFERRAL_STORAGE_KEY = 'smash-tracker.shareReferral';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredReferral {
  shareId: string;
  timestamp: number;
}

/**
 * Parses the persisted referral stamp, tolerating missing/malformed
 * localStorage content. Returns `null` for anything that isn't a
 * `{ shareId: string, timestamp: number }` shape — never throws.
 */
function parseStoredReferral(raw: string | null): StoredReferral | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StoredReferral).shareId === 'string' &&
      (parsed as StoredReferral).shareId.length > 0 &&
      typeof (parsed as StoredReferral).timestamp === 'number'
    ) {
      return parsed as StoredReferral;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stamps `shareId` as the current referral source with `timestamp:
 * Date.now()`. Overwrites any prior stamp (last-touch on the CLIENT side;
 * the server enforces first-touch on the actual attribution write). Never
 * throws.
 */
export function stamp(shareId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SHARE_REFERRAL_STORAGE_KEY,
      JSON.stringify({ shareId, timestamp: Date.now() } satisfies StoredReferral),
    );
  } catch {
    // Ignore storage failures — attribution just won't be captured this session.
  }
}

/**
 * Returns the stamped shareId if present and under 30 days old, else `null`.
 * A stale (or malformed) stamp is cleared as a side effect so it is never
 * re-read or re-sent on a later sign-in. Never throws.
 */
export function read(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = parseStoredReferral(window.localStorage.getItem(SHARE_REFERRAL_STORAGE_KEY));
    if (!stored) return null;
    if (Date.now() - stored.timestamp > THIRTY_DAYS_MS) {
      clear();
      return null;
    }
    return stored.shareId;
  } catch {
    return null;
  }
}

/** Clears the referral stamp (consumed-once semantics). Never throws. */
export function clear(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SHARE_REFERRAL_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
