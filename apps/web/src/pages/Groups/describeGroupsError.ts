import { ApiError } from '@/lib/api';

/**
 * Maps a groups-API error to a friendly inline message, following the same
 * "check status, fall back to the server message, then a generic fallback"
 * pattern as `ScoutPage`'s `describeError`. The API's own messages for
 * 403/404/409 are already user-facing (see `apps/api/src/groups/groups.ts`),
 * so this mostly just makes sure something reasonable is always shown.
 */
export function describeGroupsError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message || fallback;
  }
  return fallback;
}
