/**
 * Phase 12 Plan 08 (D-08/D-09): per-browser, per-TOKEN persistence for the
 * `/r/:token` recipient page's "✓ Acknowledged" confirmation surviving a
 * reload. Mirrors `coachSession.ts`'s `smash-tracker.*`-prefixed key and
 * try/catch-guarded, no-throw storage discipline (Safari private mode /
 * disabled storage must never break the page).
 *
 * This is deliberately CLIENT-side, not derived from the GET snapshot: the
 * anonymous `GET /api/review-deliveries/:token` response is the plan-05
 * `publicShareSnapshotSchema` (`kind: 'coachReview'`), which has no
 * `ackAt`/delivery-state field to read at all (T-12-25 — the page consumes
 * ONLY the published-version snapshot, never the coach-facing delivery
 * record that actually carries `ackAt`). The one-time POST .../ack call is
 * still the SOURCE OF TRUTH the coach's own dashboard reads (Delivered →
 * Viewed → Acknowledged) — this record only remembers, for THIS browser,
 * that the click already happened, so a reload doesn't ask the recipient to
 * acknowledge twice or hide the confirmation they already earned.
 */
const ACK_STORAGE_PREFIX = 'smash-tracker.reviewDeliveryAck.';

/** Returns `true` if this browser already recorded an acknowledgement for `token`. Never throws. */
export function hasAcknowledgedReviewDelivery(token: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`${ACK_STORAGE_PREFIX}${token}`) != null;
  } catch {
    return false;
  }
}

/** Records that this browser acknowledged `token`'s delivery, stamped with the moment it happened. Best-effort — a storage failure just means the confirmation won't survive a reload. */
export function markReviewDeliveryAcknowledged(token: string, ackedAt: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${ACK_STORAGE_PREFIX}${token}`, String(ackedAt));
  } catch {
    // Ignore storage failures.
  }
}

/** Returns the stored ack timestamp for `token`, or `null` if none/unparseable. Never throws. */
export function getReviewDeliveryAckedAt(token: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${ACK_STORAGE_PREFIX}${token}`);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
