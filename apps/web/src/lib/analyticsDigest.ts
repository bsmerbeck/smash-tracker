import {
  parseDigestSnapshot,
  trimmedEventKey,
  type DigestSnapshot,
  type Match,
} from '@smash-tracker/shared';
import { subjectSegment } from '@/lib/subjectQueryKey';

/**
 * Plan 39.2-12 (TRK-01, T-03): the since-last-visit digest's device-local
 * store, one record per (uid, subject). A SIBLING of
 * `lib/insightDismissals.ts` and `lib/analyticsSelection.ts` — same prefix
 * family, same `subjectSegment` composition (the `client:` literal is spelled
 * in exactly one place) — and never RTDB: "last seen" is a property of a
 * device, so a second device shows its own digest.
 *
 * The stored value is `{ lastSeenAt, lastSeenMatchCount, tracked }`
 * (`DigestSnapshot` in shared). Renaming the key orphans every stored digest,
 * which reads as a first visit and degrades safely (no migration).
 */
export const ANALYTICS_DIGEST_KEY_PREFIX = 'smash-tracker.analyticsDigest';

/** `smash-tracker.analyticsDigest.<uid>.<subject>` — the SAME (uid, subject) shape the dismissal store uses. */
export function analyticsDigestStorageKey(uid: string, clientId: string | null): string {
  return `${ANALYTICS_DIGEST_KEY_PREFIX}.${uid}.${subjectSegment(clientId)}`;
}

/**
 * The stored snapshot, or `null` for a first visit: absent, corrupt, tampered
 * (shared's tolerant parse), no uid, no `window`, or a throwing store all read
 * the same way (DD-16) — never an error.
 */
export function readStoredDigest(
  uid: string | null,
  clientId: string | null,
): DigestSnapshot | null {
  if (!uid || typeof window === 'undefined') return null;
  try {
    return parseDigestSnapshot(
      window.localStorage.getItem(analyticsDigestStorageKey(uid, clientId)),
    );
  } catch {
    return null;
  }
}

/**
 * Writes `snapshot` for (uid, subject). No-ops without a uid or `window`; the
 * storage call is inside a silent try/catch — a throwing or full store leaves
 * the Dashboard fully usable, the digest just will not advance on this device.
 */
export function writeStoredDigest(
  uid: string | null,
  clientId: string | null,
  snapshot: DigestSnapshot,
): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(analyticsDigestStorageKey(uid, clientId), JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures — the digest just will not advance on this device.
  }
}

/**
 * D-17 / F3b: how many distinct events are new since `lastSeenAt`, derived from
 * the SUBJECT's games only (never the account-scoped tournament registry,
 * which would show the viewer's own events under a coach route). An event is
 * a distinct `trimmedEventKey` — the one event-name rule the evidence engine
 * and the Tournaments page share — and is new when its FIRST game is later
 * than `lastSeenAt`. Games with no event name belong to no event.
 */
export function countNewEvents(matches: readonly Match[], lastSeenAt: number): number {
  const firstGameByEvent = new Map<string, number>();
  for (const match of matches) {
    const key = trimmedEventKey(match);
    if (key === null) continue;
    const seen = firstGameByEvent.get(key);
    if (seen === undefined || match.time < seen) {
      firstGameByEvent.set(key, match.time);
    }
  }
  let count = 0;
  for (const first of firstGameByEvent.values()) {
    if (first > lastSeenAt) count += 1;
  }
  return count;
}
