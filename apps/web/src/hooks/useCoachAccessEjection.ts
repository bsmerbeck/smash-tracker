import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useActiveSubject } from './useActiveSubject';
import { coachingClientsQueryKey } from './useCoachingClients';

/**
 * Quick 260726-r5 (Phase 24 gap 2): boots a coach out of a client workspace
 * the instant a subject-scoped request for the ACTIVE client returns 403
 * (access revoked mid-session — server-side enforcement was already correct,
 * per Phase 23; the defect was purely client-side stale UI). Reads
 * `useActiveSubject()` — never modifies it, `CoachingModeGate`, or any
 * `/coach/*` route file — so this hook is mounted once from `MainLayout`
 * (every `ProtectedRoute` page renders through it), and is a true no-op
 * everywhere except an active `/coach/:clientId/*` workspace.
 *
 * Surgical, not global: subscribes to the query cache but filters to
 * queries keyed `['client', <the CURRENT clientId>, ...]` — the
 * `subjectScope()` shape every subject-scoped hook (`useFighters`,
 * `useMatches`, etc.) already uses (`apps/web/src/lib/subjectQueryKey.ts`).
 * An unrelated 403 — a different query's cache namespace (`['personal', ...]`,
 * `['startgg', 'status']`, etc.) or a different client's — never matches, so
 * it never triggers this. The effect re-subscribes whenever `clientId`
 * changes (new subscription filter) and its cleanup drops the previous one,
 * so a stale subscription from a client the coach already left can never
 * fire. `ejectedForRef` additionally guards against firing more than once
 * for the SAME clientId (e.g. several subject-scoped queries 403 in the same
 * tick) — no repeat toast/navigate, and no thrash if the hub itself later
 * errors (the hub's own queries live in the `['personal', ...]` namespace,
 * outside this filter, by construction).
 */
export function useCoachAccessEjection(): void {
  const { clientId } = useActiveSubject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const ejectedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!clientId) {
      return;
    }

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.state.status !== 'error') {
        return;
      }
      const [scope, scopedClientId] = event.query.queryKey;
      if (scope !== 'client' || scopedClientId !== clientId) {
        return;
      }
      if (ejectedForRef.current === clientId) {
        return;
      }
      const error = event.query.state.error;
      if (!(error instanceof ApiError) || error.status !== 403) {
        return;
      }

      ejectedForRef.current = clientId;
      toast.info(t('coaching.workspace.accessEndedToast'));
      void queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey });
      navigate('/coach');
    });

    return unsubscribe;
  }, [clientId, navigate, queryClient, t]);
}
