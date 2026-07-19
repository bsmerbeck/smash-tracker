import { ApiError } from '@/lib/api';

/**
 * Maps a `/api/coaching/clients` error to a friendly inline message —
 * same "check status, fall back to the server message" pattern as
 * `apps/web/src/pages/Groups/describeGroupsError.ts`. The API's own 409
 * (duplicate label) and 403 (soft-cap exceeded) messages are already
 * user-facing (see `apps/api/src/coaching/tenants.ts`).
 */
export function describeCoachingError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message || fallback;
  }
  return fallback;
}
