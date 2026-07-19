import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddReviewSectionRequest } from '@/lib/api';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * Phase 12 (Coach Reviews & Delivery): review query/mutation hooks scoped to
 * a SPECIFIC client's reviews. Unlike `useCoachingClients` (a personal-
 * account read of "which clients does this coach manage") or `useMatches`/
 * `usePlaylists`/etc (keyed by `subjectScope()`/the `X-Active-Subject`
 * header), every review route is gated directly on the URL's `:clientId`
 * (`requireMembership`, no header — see `apps/api/src/routes/
 * coachingReviews.ts`'s own doc comment, and 12-03-SUMMARY.md's key
 * decision documenting the same split for the Client Hub's own
 * `clientId`-taking routes). These query keys are therefore scoped directly
 * by the `clientId` ARGUMENT rather than the active-subject header, so a
 * coach viewing two different clients' reviews (e.g. two browser tabs) never
 * shares a cache entry.
 */
export function coachingReviewsQueryKey(clientId: string) {
  return ['coaching-reviews', clientId] as const;
}

export function reviewDraftQueryKey(clientId: string, reviewId: string) {
  return ['coaching-review-draft', clientId, reviewId] as const;
}

export function reviewPreviewQueryKey(clientId: string, reviewId: string) {
  return ['coaching-review-preview', clientId, reviewId] as const;
}

/** GET .../reviews — the review + delivery state list for one client (D-05). */
export function useCoachingReviews(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: coachingReviewsQueryKey(clientId ?? ''),
    queryFn: () => api.coaching.reviews.list(clientId as string),
    enabled: Boolean(user) && Boolean(clientId),
  });
}

/** POST .../reviews — starts a new review draft; invalidates the reviews list. */
export function useCreateCoachingReview(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.coaching.reviews.create(clientId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingReviewsQueryKey(clientId) });
    },
  });
}

/**
 * GET .../reviews/:reviewId/draft — the ONLY composer-side fetch that
 * returns `coachPrivateNotes` (coach-only; REV-03). Never spread into any
 * preview/delivery component's props.
 */
export function useCoachingReviewDraft(clientId: string, reviewId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: reviewDraftQueryKey(clientId, reviewId),
    queryFn: () => api.coaching.reviews.getDraft(clientId, reviewId),
    enabled: Boolean(user) && Boolean(clientId) && Boolean(reviewId),
  });
}

/** GET .../preview — exactly the client-visible render (REV-05); opt-in via `enabled` so "Preview as client" only fetches on demand. */
export function useCoachingReviewPreview(
  clientId: string,
  reviewId: string,
  options: { enabled?: boolean } = {},
) {
  const { user } = useAuth();
  return useQuery({
    queryKey: reviewPreviewQueryKey(clientId, reviewId),
    queryFn: () => api.coaching.reviews.preview(clientId, reviewId),
    enabled: Boolean(user) && Boolean(clientId) && Boolean(reviewId) && (options.enabled ?? true),
  });
}

/** POST .../publish — server-authoritative seal; invalidates the list + preview for this review. */
export function usePublishCoachingReview(clientId: string, reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.coaching.reviews.publish(clientId, reviewId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: coachingReviewsQueryKey(clientId) }),
        queryClient.invalidateQueries({ queryKey: reviewPreviewQueryKey(clientId, reviewId) }),
      ]);
    },
  });
}

/** POST .../sections/:sectionId/hide — D-03 "Hide section" (content preserved, never an ×). */
export function useHideReviewSection(clientId: string, reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) =>
      api.coaching.reviews.hideSection(clientId, reviewId, sectionId),
    onSuccess: (draft) => {
      queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), draft);
    },
  });
}

/** POST .../sections/:sectionId/show — the Undo counterpart; restores the section in place. */
export function useShowReviewSection(clientId: string, reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) =>
      api.coaching.reviews.showSection(clientId, reviewId, sectionId),
    onSuccess: (draft) => {
      queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), draft);
    },
  });
}

/** POST .../sections — "Add section" (restores a hidden suggested block, or adds General Notes / an optional SSBU-specific section). */
export function useAddReviewSection(clientId: string, reviewId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddReviewSectionRequest) =>
      api.coaching.reviews.addSection(clientId, reviewId, input),
    onSuccess: (draft) => {
      queryClient.setQueryData(reviewDraftQueryKey(clientId, reviewId), draft);
    },
  });
}

/** POST .../archive — removes the review from the active (non-archived) list. */
export function useArchiveCoachingReview(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) => api.coaching.reviews.archive(clientId, reviewId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: coachingReviewsQueryKey(clientId) });
    },
  });
}
