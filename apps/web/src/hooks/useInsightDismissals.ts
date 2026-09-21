import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import {
  capDismissedIds,
  insightDismissalsStorageKey,
  readStoredDismissals,
  writeStoredDismissals,
} from '@/lib/insightDismissals';

export interface UseInsightDismissalsResult {
  dismissedIds: string[];
  /** The stable `Insight.id` (`${templateId}:${scopeKey}:${horizonKey}`) to dismiss. */
  dismiss: (id: string) => void;
  restoreAll: () => void;
  isLoading: boolean;
}

/**
 * Plan 39.1-12 (INS-02/INS-04, D-06, T-39.1-12-01..05): per-(uid, subject)
 * insight dismissals, backing `InsightRail`'s `dismissedIds`/`onDismiss`/
 * `onRestore` contract (plan 39.1-07). Mirrors `useHorizon.ts`'s write
 * discipline exactly: `dismiss` and `restoreAll` are the ONLY two call
 * sites of `writeStoredDismissals` in this module, and the storage READ
 * itself is deferred until the match query has settled — zero reads and
 * zero writes while `isLoading` — via the same "adjust state during
 * render" pattern, gated on `!isLoading`, that `useHorizon` uses.
 */
export function useInsightDismissals(): UseInsightDismissalsResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { clientId } = useEffectiveSubject();
  const { isLoading } = useFilteredMatches();

  const storageKey = uid ? insightDismissalsStorageKey(uid, clientId) : null;

  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  // `undefined` means "never seeded" — distinct from a real `null` key
  // (signed out / no subject), so the first not-loading render always seeds
  // once, even when there is nothing to read.
  const [seededKey, setSeededKey] = useState<string | null | undefined>(undefined);

  if (!isLoading && seededKey !== storageKey) {
    setSeededKey(storageKey);
    setDismissedIds(readStoredDismissals(uid, clientId));
  }

  if (isLoading) {
    return {
      dismissedIds: [],
      dismiss: () => {},
      restoreAll: () => {},
      isLoading: true,
    };
  }

  function dismiss(id: string): void {
    setDismissedIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = capDismissedIds([...prev, id]);
      writeStoredDismissals(uid, clientId, next);
      return next;
    });
  }

  function restoreAll(): void {
    setDismissedIds([]);
    writeStoredDismissals(uid, clientId, []);
  }

  return { dismissedIds, dismiss, restoreAll, isLoading: false };
}
