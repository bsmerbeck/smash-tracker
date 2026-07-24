import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionPatchInput } from '@smash-tracker/shared';
import type { CreateSessionDeliveryRequest, CreateSessionRequest } from '@/lib/api';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02): training-session query/mutation hooks scoped to a SPECIFIC
 * client's sessions — a SIBLING to `useCoachingReviews.ts` (same
 * `clientId`-argument-scoped query keys, since every session route is
 * gated directly on the URL's `:clientId`, `requireMembership`, no
 * `X-Active-Subject` header — see `apps/api/src/routes/
 * coachingSessions.ts`'s own doc comment). A session is a MUTABLE LOG (no
 * draft/publish/status machinery), so there is no `usePublishCoachingReview`
 * counterpart here.
 */
export function coachingSessionsQueryKey(clientId: string) {
  return ['coaching-sessions', clientId] as const;
}

export function coachingSessionQueryKey(clientId: string, sessionId: string) {
  return ['coaching-session', clientId, sessionId] as const;
}

/** GET .../sessions — a client's training sessions, most-recent-first (SESS-02). */
export function useCoachingSessions(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: coachingSessionsQueryKey(clientId ?? ''),
    queryFn: () => api.coaching.sessions.list(clientId as string),
    enabled: Boolean(user) && Boolean(clientId),
  });
}

/** GET .../sessions/:sessionId — the composer's own fetch of one session (includes `coachPrivateNotes`, coach-only). */
export function useCoachingSession(clientId: string, sessionId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: coachingSessionQueryKey(clientId, sessionId),
    queryFn: () => api.coaching.sessions.get(clientId, sessionId),
    enabled: Boolean(user) && Boolean(clientId) && Boolean(sessionId),
  });
}

/** POST .../sessions — logs a new session (SESS-01); invalidates the sessions list. */
export function useCreateCoachingSession(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionRequest) => api.coaching.sessions.create(clientId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingSessionsQueryKey(clientId) });
    },
  });
}

/** PATCH .../sessions/:sessionId — in-place edit (mutable log, no version machinery). */
export function useUpdateCoachingSession(clientId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SessionPatchInput) =>
      api.coaching.sessions.update(clientId, sessionId, patch),
    onSuccess: async (session) => {
      queryClient.setQueryData(coachingSessionQueryKey(clientId, sessionId), session);
      await queryClient.invalidateQueries({ queryKey: coachingSessionsQueryKey(clientId) });
    },
  });
}

/** POST .../homework/:itemId/toggle — flips one homework item's done-state in place. */
export function useToggleHomeworkItem(clientId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) =>
      api.coaching.sessions.toggleHomework(clientId, sessionId, itemId, done),
    onSuccess: async (session) => {
      queryClient.setQueryData(coachingSessionQueryKey(clientId, sessionId), session);
      await queryClient.invalidateQueries({ queryKey: coachingSessionsQueryKey(clientId) });
    },
  });
}

/**
 * SESS-01 (D-10 immutability): the Sessions list's delivery overflow menu —
 * a SEPARATE control (and a separate query key) from the session-authoring
 * hooks above, mirroring `useCoachingReviews.ts`'s
 * `reviewDeliveriesQueryKey`/`useReviewDeliveries` split exactly.
 */
export function sessionDeliveriesQueryKey(clientId: string, sessionId: string) {
  return ['coaching-session-deliveries', clientId, sessionId] as const;
}

/** GET .../deliveries — every delivery ever created for this session, most-recent-first. Opt-in via `enabled` so a closed overflow menu never fetches. */
export function useSessionDeliveries(
  clientId: string,
  sessionId: string,
  options: { enabled?: boolean } = {},
) {
  const { user } = useAuth();
  return useQuery({
    queryKey: sessionDeliveriesQueryKey(clientId, sessionId),
    queryFn: () => api.coaching.sessions.deliveries.list(clientId, sessionId),
    enabled: Boolean(user) && Boolean(clientId) && Boolean(sessionId) && (options.enabled ?? true),
  });
}

/**
 * POST .../deliveries — mints a revocable delivery embedding a FROZEN
 * client-visible snapshot. Phase 21 (DLVX-04): the mutation's `input` is
 * optional so `mutateAsync()` with no argument still sends the exact
 * bodyless POST every pre-Phase-21 caller relies on; `SessionComposerPage`'s
 * `DeliveryVodPicker` confirm now passes `{ includedVods }`.
 */
export function useCreateSessionDelivery(clientId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: CreateSessionDeliveryRequest) =>
      input !== undefined
        ? api.coaching.sessions.deliveries.create(clientId, sessionId, input)
        : api.coaching.sessions.deliveries.create(clientId, sessionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: sessionDeliveriesQueryKey(clientId, sessionId),
      });
    },
  });
}

/** POST .../deliveries/:deliveryId/revoke — idempotent soft-revoke. */
export function useRevokeSessionDelivery(clientId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.coaching.sessions.deliveries.revoke(clientId, sessionId, deliveryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: sessionDeliveriesQueryKey(clientId, sessionId),
      });
    },
  });
}
