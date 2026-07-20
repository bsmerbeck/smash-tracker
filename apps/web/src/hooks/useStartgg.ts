import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { onboardingProgressQueryKey } from '@/hooks/useOnboardingProgress';

/** Link status for the signed-in user; refetches after link/unlink/sync. */
export function useStartggStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['startgg', 'status'],
    queryFn: () => api.startgg.status(),
    enabled: user != null,
  });
}

/** Starts the link flow: asks the API for the authorize URL and navigates to it. */
export function useStartggConnect() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.startgg.authorize();
      window.location.assign(url);
    },
  });
}

/**
 * Runs a tournament sync; imported matches/opponents invalidate immediately.
 * Phase 13 (ONBD-04, D-04): also invalidates `onboardingProgressQueryKey` —
 * a sync can populate `tournamentEntries`/cross the `analytics_activated`
 * games threshold server-side (`reconcilePlayerActivation` runs after every
 * sync, 13-05), so the guided-path card must reflect that without a manual
 * refresh.
 */
export function useStartggSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.startgg.sync(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['matches'] }),
        queryClient.invalidateQueries({ queryKey: ['opponents'] }),
        queryClient.invalidateQueries({ queryKey: ['startgg', 'status'] }),
        queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey }),
      ]);
    },
  });
}

/**
 * Fires the FIRST sync automatically for a freshly-linked start.gg account:
 * linked with no `lastSyncAt` yet — the API stamps `lastSyncAt` after every
 * sync, even one that imports nothing, so this triggers at most once per
 * link. Community feedback: after "sign up with start.gg" nothing imported
 * until people discovered Settings → Integrations → "Sync now". Mounting
 * this once in MainLayout covers both entry points — the login flow (which
 * lands on the dashboard) and linking from the Integrations page. A failed
 * attempt doesn't retry until the next full page load; the manual "Sync
 * now" button remains the recovery path.
 */
export function useStartggAutoSync() {
  const { t } = useTranslation();
  const { data: status } = useStartggStatus();
  // v5 mutate functions are referentially stable; the ref guard below is
  // what actually prevents re-fires (status refetches re-run the effect).
  const { mutateAsync: runSync } = useStartggSync();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || status == null || !status.linked || status.lastSyncAt != null) {
      return;
    }
    attempted.current = true;
    toast.info(t('integrations.startgg.autoSyncStarted'));
    runSync()
      .then((summary) => {
        toast.success(
          t('integrations.startgg.autoSyncDone', {
            imported: summary.imported,
            sets: summary.sets,
          }),
        );
      })
      .catch(() => {
        toast.error(t('integrations.startgg.autoSyncFailed'));
      });
  }, [status, runSync, t]);
}

export function useStartggUnlink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.startgg.unlink(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['startgg', 'status'] });
    },
  });
}
