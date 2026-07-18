/**
 * Phase 10 Plan 4 (Canonical Measurement, MEAS-04/MEAS-09): posts an
 * X-class event to the durable, same-origin `POST /api/events` ingestion
 * route — the server-validated replacement for ad-blocker-erasable direct
 * calls to the GA4 SDK. This is a SIBLING to `logProductEvent`
 * (`./firebase.ts`), not a refactor of it: `logProductEvent`'s existing
 * callers (`share_opened`, `vod_note_created`) are unchanged and out of
 * scope for this phase.
 *
 * Same never-throw, fire-and-forget contract as `logProductEvent`: analytics
 * must never break the app, so any network failure is swallowed. The route
 * itself validates `eventName` against a server-side allowlist and stamps
 * `receivedAt` — this helper never assumes the POST succeeded.
 */
export function postCanonicalEvent(
  eventName: string,
  payload: Record<string, string | number | boolean> = {},
): void {
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: crypto.randomUUID(),
      eventName,
      occurredAt: Date.now(),
      payload,
    }),
  }).catch(() => {});
}
