/**
 * Onboarding origin stamp (ONBD-01, 13-CONTEXT.md D-03): a SECOND,
 * independently-namespaced localStorage key modeled exactly on
 * `shareReferral.ts`'s parse-tolerant/expiring/consumed-once/never-throws
 * discipline — never extend `shareReferral.ts` itself. The three
 * attribution layers stay strictly separated: (a) the existing server-side
 * write-once `referredByShareId` (untouched), (b) THIS stamp — consumed
 * once at first post-auth landing to drive the skip/ask routing (13-06) and
 * the origin chip, (c) the server-saved `onboardingIntent` (13-02), which
 * takes over after the stamp is consumed.
 *
 * Written at the three signup-entry surfaces: `ShareViewPage.tsx` (VOD
 * share, `kind: 'vodShare'` — unambiguous, D-02), `RecapView.tsx` (tournament
 * recap, `kind: 'recap'` — unambiguous, D-02), and `ReviewDeliveryPage.tsx`
 * (`kind: 'coachReview'` — ambiguous, routes to the ASK variant).
 *
 * Never sent to the server, never logged in telemetry (D-03) — the stamp is
 * navigation/UI-framing state only.
 */

export const ONBOARDING_ORIGIN_STORAGE_KEY = 'smash-tracker.onboardingOrigin';

/**
 * Short TTL (2 hours), deliberately far shorter than `shareReferral.ts`'s 30
 * days (RESEARCH.md Assumption A2): this stamp only needs to bridge ONE
 * signup attempt — including a slow/interrupted OAuth redirect round trip —
 * not durable cross-session attribution. A stamp older than this is assumed
 * to belong to abandoned browsing, not the signup currently in progress.
 */
const ONBOARDING_ORIGIN_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Internal-route allowlist for `returnPath` (13-CONTEXT.md D-03 / RESEARCH.md
 * Security Domain): only a relative `/s/...` (VOD/recap share) or `/r/...`
 * (review delivery) path is ever considered safe to navigate to. A
 * manipulated localStorage value (absolute URL, protocol-relative `//`,
 * `javascript:`, etc.) must never become an open redirect.
 */
const SAFE_RETURN_PATH_PATTERN = /^\/(s|r)\/[A-Za-z0-9_-]+$/;

export type OnboardingOriginKind = 'vodShare' | 'recap' | 'coachReview';

export interface StoredOrigin {
  kind: OnboardingOriginKind;
  returnPath: string;
  timestamp: number;
}

/** Returns true when `path` matches the internal-route allowlist shape. */
export function isSafeReturnPath(path: string): boolean {
  return SAFE_RETURN_PATH_PATTERN.test(path);
}

const ONBOARDING_ORIGIN_KINDS: readonly OnboardingOriginKind[] = [
  'vodShare',
  'recap',
  'coachReview',
];

/**
 * Parses the persisted origin stamp, tolerating missing/malformed
 * localStorage content. Returns `null` for anything that isn't a
 * `{ kind, returnPath, timestamp }` shape — never throws.
 */
function parseStoredOrigin(raw: string | null): StoredOrigin | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      ONBOARDING_ORIGIN_KINDS.includes((parsed as StoredOrigin).kind) &&
      typeof (parsed as StoredOrigin).returnPath === 'string' &&
      (parsed as StoredOrigin).returnPath.length > 0 &&
      typeof (parsed as StoredOrigin).timestamp === 'number'
    ) {
      return parsed as StoredOrigin;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stamps the current onboarding origin with `timestamp: Date.now()`.
 * Overwrites any prior stamp (last-touch, mirroring `shareReferral.ts`).
 * Never throws.
 */
export function stamp(origin: { kind: OnboardingOriginKind; returnPath: string }): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      ONBOARDING_ORIGIN_STORAGE_KEY,
      JSON.stringify({
        kind: origin.kind,
        returnPath: origin.returnPath,
        timestamp: Date.now(),
      } satisfies StoredOrigin),
    );
  } catch {
    // Ignore storage failures — origin just isn't captured this session.
  }
}

/**
 * Returns the stamped origin if present, under the TTL, AND its
 * `returnPath` passes the internal-route allowlist — else `null`. A stale,
 * malformed, or unsafe-path stamp is cleared as a side effect so it is never
 * re-read on a later attempt. Never throws.
 */
export function read(): StoredOrigin | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = parseStoredOrigin(window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY));
    if (!stored) return null;
    if (Date.now() - stored.timestamp > ONBOARDING_ORIGIN_TTL_MS) {
      clear();
      return null;
    }
    if (!isSafeReturnPath(stored.returnPath)) {
      clear();
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

/** Clears the origin stamp (consumed-once semantics). Never throws. */
export function clear(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ONBOARDING_ORIGIN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
