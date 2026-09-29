import { useState } from 'react';
import type { DigestSnapshot } from '@smash-tracker/shared';
import { useAuth } from '@/hooks/useAuth';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import {
  analyticsDigestStorageKey,
  countNewEvents,
  readStoredDigest,
  writeStoredDigest,
} from '@/lib/analyticsDigest';

/** `loading`: matches not settled. `start`: first visit on this device. `quiet`: nothing new. `expanded`: something to say. */
export type DigestStatus = 'loading' | 'start' | 'quiet' | 'expanded';

export interface UseDigestResult {
  status: DigestStatus;
  newGames: number;
  newEvents: number;
  /** The `lastSeenAt` the card names ("since Sep 21"), or `null` on a first visit. */
  since: number | null;
  /** Mark as read is offered only while expanded and the match query is settled. */
  canMarkAsRead: boolean;
  markAsRead: () => void;
}

/**
 * Plan 39.2-12 (TRK-01, T-03): the Dashboard's since-last-visit digest.
 *
 * The stored snapshot is read ONCE per storage key, after the match query has
 * settled, and frozen for the visit (Assumption A6): a background refetch or
 * Mark as read never yanks the card mid-visit except through the explicit
 * quiet transition. The read uses the "adjust state during render" shape of
 * `useInsightDismissals`, so there is no storage read while `isLoading`.
 *
 * Counts come from the SUBJECT's games only (D-17): new games are the growth
 * of `allMatches` past the stored count, new events are distinct event keys
 * whose first game is later than `lastSeenAt`.
 */
export function useDigest(): UseDigestResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { clientId } = useEffectiveSubject();
  const { allMatches, isLoading, isFetching } = useFilteredMatches();

  const storageKey = uid ? analyticsDigestStorageKey(uid, clientId) : null;

  const [stored, setStored] = useState<DigestSnapshot | null>(null);
  // `undefined` means "never seeded" — distinct from a real `null` key
  // (signed out), so the first settled render always seeds once.
  const [seededKey, setSeededKey] = useState<string | null | undefined>(undefined);
  // The `lastSeenAt` a Mark as read wrote this visit; non-null flips the card to quiet.
  const [markedAt, setMarkedAt] = useState<number | null>(null);

  if (!isLoading && seededKey !== storageKey) {
    setSeededKey(storageKey);
    setStored(readStoredDigest(uid, clientId));
    setMarkedAt(null);
  }

  if (isLoading || seededKey !== storageKey) {
    return {
      status: 'loading',
      newGames: 0,
      newEvents: 0,
      since: null,
      canMarkAsRead: false,
      markAsRead: () => {},
    };
  }

  const newGames = stored ? Math.max(0, allMatches.length - stored.lastSeenMatchCount) : 0;
  const newEvents = stored ? countNewEvents(allMatches, stored.lastSeenAt) : 0;

  let status: DigestStatus;
  if (markedAt !== null) {
    status = 'quiet';
  } else if (stored === null) {
    status = 'start';
  } else if (newGames === 0 && newEvents === 0) {
    status = 'quiet';
  } else {
    status = 'expanded';
  }

  const canMarkAsRead = status === 'expanded' && !isFetching;

  function markAsRead(): void {
    if (!canMarkAsRead) return;
    const now = Date.now();
    writeStoredDigest(uid, clientId, {
      lastSeenAt: now,
      lastSeenMatchCount: allMatches.length,
      tracked: {},
    });
    setMarkedAt(now);
  }

  return {
    status,
    newGames,
    newEvents,
    since: markedAt ?? stored?.lastSeenAt ?? null,
    canMarkAsRead,
    markAsRead,
  };
}
