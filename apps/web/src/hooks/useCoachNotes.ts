import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  errorResponseSchema,
  publicShareSnapshotSchema,
  vodTimestampEntrySchema,
  type PublicShareSnapshot,
  type VodTimestamp,
} from '@smash-tracker/shared';
import type { TFunction } from 'i18next';
import { ApiError, getApiBaseUrl } from '@/lib/api';

/**
 * Anonymous client for the coach-edit-session surface (Phase 8 Plan 3's
 * route contract): `GET /api/vod-shares/:token/session` (the LIVE
 * redacted recompute) plus `POST/PATCH/DELETE /api/vod-shares/:token/notes[/:noteId]`.
 * Deliberately self-contained rather than routed through `apps/web/src/lib/api.ts`'s
 * `apiRequest`/`apiRequestParsed` helpers (private to that module, and this
 * plan's declared files don't include it) — these routes are token-scoped,
 * never user-scoped, and are never called with a Firebase auth header
 * regardless of whether a coach happens to also be signed in as an owner in
 * the same browser.
 */

/**
 * Token-scoped key PREFIX — what the write mutations invalidate. The full
 * query key below additionally carries the caller's sessionId (the server
 * computes each note's `own` flag from it, review WR-02), and TanStack's
 * prefix matching means invalidating this scope hits it regardless.
 */
export const coachSessionScopeKey = (token: string) =>
  ['vod-shares', 'coach-session', token] as const;

export const coachSessionQueryKey = (token: string, sessionId: string) =>
  [...coachSessionScopeKey(token), sessionId] as const;

interface CoachRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function coachRequest<TResponse>(
  path: string,
  options: CoachRequestOptions = {},
): Promise<TResponse> {
  const hasBody = options.body !== undefined;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(json);
    if (parsedError.success) {
      throw new ApiError(response.status, parsedError.data.message, parsedError.data.details);
    }
    throw new ApiError(response.status, response.statusText || 'Request failed');
  }

  return json as TResponse;
}

/**
 * GET /api/vod-shares/:token/session — the LIVE edit-session view. Resolves
 * with `permissions: 'edit'` (plus per-note `id`/`coach`/`own`) only for a
 * valid, unrevoked, unexpired EDIT-tier token; 404s (identical body, no
 * oracle) for a view-tier/unknown/revoked/expired token, in which case this
 * query simply fails and the caller falls back to the existing frozen
 * view-tier render. Deliberately no `enabled` gate keyed off token validity
 * — the query itself IS the "is this an edit-tier link" probe.
 *
 * `sessionId` is this browser's own coach session id, sent as a query param
 * so the SERVER computes each note's `own` flag (review WR-02) — the
 * response never carries any coach's sessionId.
 */
export function useCoachSession(token: string, sessionId: string) {
  return useQuery({
    queryKey: coachSessionQueryKey(token, sessionId),
    queryFn: () =>
      coachRequest<unknown>(
        `/api/vod-shares/${encodeURIComponent(token)}/session?sessionId=${encodeURIComponent(sessionId)}`,
      ).then((json) => publicShareSnapshotSchema.parse(json)),
    enabled: Boolean(token) && Boolean(sessionId),
  });
}

/**
 * Shared failure toast for every coach write (review WR-03): a coach's work
 * must never vanish silently. A 404 means the share itself died mid-session
 * (revoked/expired — guaranteed eventually, edit tokens expire after 30
 * days) and gets its own message; everything else (429 rate limit, 403 cap,
 * 400 validation, network) collapses to the generic save-failed copy the
 * owner-side note surfaces already use.
 *
 * A 409 (first-write name collision, FB-04) is deliberately skipped here —
 * `ShareViewPage`'s per-call mutation options own that UX (re-opening the
 * name prompt with a "name taken" message), so this generic handler must
 * never also fire the save-failed toast on top of it.
 */
function toastCoachWriteError(t: TFunction, error: unknown): void {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 409) {
    return;
  }
  toast.error(status === 404 ? t('share.coach.shareGoneToast') : t('shared.vod.saveFailed'));
}

export interface CreateCoachNoteInput {
  sessionId: string;
  displayName: string;
  seconds: number;
  note: string;
  tags?: string[];
}

/** POST /api/vod-shares/:token/notes — sessionId + displayName travel in the body. */
export function useCreateCoachNote(token: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCoachNoteInput) =>
      coachRequest<unknown>(`/api/vod-shares/${encodeURIComponent(token)}/notes`, {
        method: 'POST',
        body: input,
      }).then((json): VodTimestamp => vodTimestampEntrySchema.parse(json)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachSessionScopeKey(token) });
    },
    onError: (error) => toastCoachWriteError(t, error),
  });
}

export interface UpdateCoachNoteInput {
  sessionId: string;
  seconds?: number;
  note?: string;
  tags?: string[];
}

/**
 * PATCH /api/vod-shares/:token/notes/:noteId — partial body; absent fields
 * preserve the stored value. `sessionId` travels in the body — the server
 * scopes the write to a note the caller's OWN session authored (404 on any
 * mismatch, per the identical-404 no-oracle rule).
 */
export function useUpdateCoachNote(token: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, input }: { noteId: string; input: UpdateCoachNoteInput }) =>
      coachRequest<unknown>(
        `/api/vod-shares/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}`,
        { method: 'PATCH', body: input },
      ).then((json): VodTimestamp => vodTimestampEntrySchema.parse(json)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachSessionScopeKey(token) });
    },
    onError: (error) => toastCoachWriteError(t, error),
  });
}

/**
 * DELETE /api/vod-shares/:token/notes/:noteId?sessionId=... — `sessionId`
 * travels as a QUERY param (no DELETE body — the route contract locked in
 * 08-03), never in the body.
 */
export function useDeleteCoachNote(token: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, sessionId }: { noteId: string; sessionId: string }) =>
      coachRequest<void>(
        `/api/vod-shares/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}?sessionId=${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachSessionScopeKey(token) });
    },
    onError: (error) => toastCoachWriteError(t, error),
  });
}

export type { PublicShareSnapshot };
