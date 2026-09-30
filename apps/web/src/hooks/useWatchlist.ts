import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  buildWatchlistItemKey,
  watchlistTrackInputSchema,
  type WatchlistItemKind,
  type WatchlistResponse,
  type WatchlistTrackInput,
} from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import type { ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';
import { useEffectiveSubject } from './useEffectiveSubject';
import { useSubjectPath } from './useSubjectPath';

/** The machine code the API puts on the 409 that refuses a 26th tracked item (plan 39.2-05). */
const WATCHLIST_FULL_CODE = 'watchlist-full';

/** The anchor the Dashboard's Tracked section carries (UI-SPEC 7.7: "Manage tracked" lands here). */
const TRACKED_ANCHOR = '#tracked';

/**
 * TRK-02 / T-39.2-41: subject-scoped so a coach's own list and each client's
 * list never share a cache entry. Reads and BOTH mutations use this exact key
 * (production-gap #9) — a mutation that invalidated a different key would
 * leave the toggle stale.
 */
export function watchlistQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'watchlist'] as const;
}

/**
 * Validates a `kind` + `ref` pair the way the server will, returning the
 * canonical track input (an opponent tag is trimmed and lowercased) or null
 * when the ref is not trackable — e.g. an opponent tag holding a character
 * RTDB reserves in a path, or the id-0 "no selection" stage. Hosts render no
 * toggle for a null result, so the UI never offers a track the API refuses.
 */
export function parseTrackInput(
  kind: WatchlistItemKind,
  ref: WatchlistTrackInput['ref'] | null | undefined,
): WatchlistTrackInput | null {
  if (ref == null) {
    return null;
  }
  const parsed = watchlistTrackInputSchema.safeParse({ kind, ref });
  return parsed.success ? parsed.data : null;
}

/**
 * GET /api/watchlist — the ACTIVE SUBJECT's tracked items (the global
 * `X-Active-Subject` header scopes the request; the key below scopes the cache).
 */
export function useWatchlist() {
  const { user } = useAuth();
  const subject = useEffectiveSubject();
  return useQuery({
    queryKey: watchlistQueryKey(subject),
    queryFn: () => api.watchlist.list(),
    enabled: Boolean(user),
  });
}

/**
 * Whether one item is tracked. `ready` is true ONLY once the list query has
 * succeeded (production-gap #8): a toggle must never act on an unloaded or
 * errored list, and an unloaded list must not read as "not tracked".
 */
export function useIsTracked(
  kind: WatchlistItemKind,
  ref: WatchlistTrackInput['ref'] | null | undefined,
): { ready: boolean; tracked: boolean; itemKey: string | null } {
  const { data, isSuccess } = useWatchlist();
  const input = parseTrackInput(kind, ref);
  const itemKey = input ? buildWatchlistItemKey(input) : null;
  const tracked =
    itemKey != null && isSuccess && data.items.some((entry) => entry.itemKey === itemKey);
  return { ready: isSuccess && itemKey != null, tracked, itemKey };
}

/** True for the 409 the server sends when the subject already tracks 25 items. */
function isWatchlistFull(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, details } = error as { status?: unknown; details?: unknown };
  if (status !== 409 || typeof details !== 'object' || details === null) {
    return false;
  }
  return (details as { code?: unknown }).code === WATCHLIST_FULL_CODE;
}

/** Reports a failed mutation: the full-list refusal carries a way out, anything else the generic error. */
function useReportWatchlistFailure() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  return (error: unknown) => {
    if (isWatchlistFull(error)) {
      toast(t('watchlist.full'), {
        action: {
          label: t('watchlist.manage'),
          onClick: () => {
            void navigate(`${subjectPath('/dashboard')}${TRACKED_ANCHOR}`);
          },
        },
      });
      return;
    }
    toast.error(t('watchlist.error'));
  };
}

interface TrackVariables {
  input: WatchlistTrackInput;
  /** The display name, for the toast only. */
  name: string;
}

interface UntrackVariables {
  itemKey: string;
  name: string;
}

interface OptimisticContext {
  previous: WatchlistResponse | undefined;
}

/**
 * PUT /api/watchlist/items — tracks ONE item, applied optimistically. A per-item
 * write (never a whole-list replace) means no body is ever built from an
 * unresolved read. Any failure restores the snapshot taken before the tap; the
 * 26th item's 409 leaves the cache byte-identical and nothing is evicted.
 */
export function useTrackWatchlistItem() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const subject = useEffectiveSubject();
  const queryKey = watchlistQueryKey(subject);
  const reportFailure = useReportWatchlistFailure();
  return useMutation<unknown, unknown, TrackVariables, OptimisticContext>({
    mutationFn: ({ input }) => api.watchlist.track(input),
    onMutate: async ({ input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WatchlistResponse>(queryKey);
      if (previous) {
        const itemKey = buildWatchlistItemKey(input);
        if (!previous.items.some((entry) => entry.itemKey === itemKey)) {
          queryClient.setQueryData<WatchlistResponse>(queryKey, {
            items: [...previous.items, { itemKey, item: { ...input, createdAt: Date.now() } }],
          });
        }
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      reportFailure(error);
    },
    onSuccess: (_result, { name }) => {
      toast.success(t('watchlist.trackedToast', { name }));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** DELETE /api/watchlist/items/:itemKey — untracks ONE item, applied optimistically (rolls back on error). */
export function useUntrackWatchlistItem() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const subject = useEffectiveSubject();
  const queryKey = watchlistQueryKey(subject);
  const reportFailure = useReportWatchlistFailure();
  return useMutation<unknown, unknown, UntrackVariables, OptimisticContext>({
    mutationFn: ({ itemKey }) => api.watchlist.untrack(itemKey),
    onMutate: async ({ itemKey }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WatchlistResponse>(queryKey);
      if (previous) {
        queryClient.setQueryData<WatchlistResponse>(queryKey, {
          items: previous.items.filter((entry) => entry.itemKey !== itemKey),
        });
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      reportFailure(error);
    },
    onSuccess: (_result, { name }) => {
      toast.success(t('watchlist.untrackedToast', { name }));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}

interface UntrackManyVariables {
  /** Every stored key the untrack removes (a Tracked row can fold several after an alias merge). */
  itemKeys: readonly string[];
  name: string;
}

/**
 * A multi-key untrack in which at least one DELETE failed. `deleted` names the keys the server
 * DID remove, so the rollback restores only the ones that are still stored.
 */
class PartialUntrackError extends Error {
  readonly deleted: readonly string[];
  readonly failure: unknown;

  constructor(deleted: readonly string[], failure: unknown) {
    super('One or more watchlist deletes failed');
    this.name = 'PartialUntrackError';
    this.deleted = deleted;
    this.failure = failure;
  }
}

/**
 * Untracks EVERY stored key one displayed item folds (39.2-REVIEW WEB-IN multi-key untrack and
 * WEB-WR-04): one DELETE per key, applied optimistically as one change, announced with ONE
 * toast. If some DELETEs fail, the rollback restores only the keys the server still holds —
 * never a key another DELETE of the same untrack already removed — and one error is reported.
 */
export function useUntrackWatchlistItems() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const subject = useEffectiveSubject();
  const queryKey = watchlistQueryKey(subject);
  const reportFailure = useReportWatchlistFailure();
  return useMutation<readonly string[], unknown, UntrackManyVariables, OptimisticContext>({
    mutationFn: async ({ itemKeys }) => {
      const results = await Promise.allSettled(
        itemKeys.map((itemKey) => api.watchlist.untrack(itemKey)),
      );
      const deleted = itemKeys.filter((_, index) => results[index]?.status === 'fulfilled');
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed) {
        throw new PartialUntrackError(deleted, failed.reason);
      }
      return deleted;
    },
    onMutate: async ({ itemKeys }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WatchlistResponse>(queryKey);
      if (previous) {
        queryClient.setQueryData<WatchlistResponse>(queryKey, {
          items: previous.items.filter((entry) => !itemKeys.includes(entry.itemKey)),
        });
      }
      return { previous };
    },
    onError: (error, _variables, context) => {
      const deleted = error instanceof PartialUntrackError ? error.deleted : [];
      if (context?.previous !== undefined) {
        queryClient.setQueryData<WatchlistResponse>(queryKey, {
          items: context.previous.items.filter((entry) => !deleted.includes(entry.itemKey)),
        });
      }
      reportFailure(error instanceof PartialUntrackError ? error.failure : error);
    },
    onSuccess: (_result, { name }) => {
      toast.success(t('watchlist.untrackedToast', { name }));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}
