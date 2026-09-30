import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DIGEST_HORIZON, type DigestSnapshot } from '@smash-tracker/shared';
import {
  buildTrackedRows,
  type TrackedMovedEntry,
  type TrackedRowModel,
} from '@/components/analytics/track/trackedRowModel';
import { useAuth } from '@/hooks/useAuth';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useWatchlist } from '@/hooks/useWatchlist';
import {
  analyticsDigestStorageKey,
  countNewEvents,
  movedItemsOf,
  readDigestItems,
  readStoredDigest,
  trackedSnapshotOf,
  writeStoredDigest,
} from '@/lib/analyticsDigest';

/** `loading`: matches (or, with nothing else new, the tracked list) not settled. `start`: first visit on this device. `quiet`: nothing new. `expanded`: something to say. */
export type DigestStatus = 'loading' | 'start' | 'quiet' | 'expanded';

export interface UseDigestOptions {
  /**
   * Whether the digest is actually on screen. A page that early-returns before
   * rendering the card (no fighters chosen) passes false, so leaving it never
   * marks a digest the player was not shown as read.
   */
  enabled?: boolean;
}

export interface UseDigestResult {
  status: DigestStatus;
  newGames: number;
  newEvents: number;
  /** How many tracked items moved, or `null` while the tracked list is unresolved. */
  movedCount: number | null;
  /** At most five compact rows carrying their moved token, in engine-salience order (D-06). */
  movedRows: TrackedRowModel[];
  /** The moved items beyond the five shown. */
  moreCount: number;
  /** Every moved item by stored item key, for the Tracked section's moved-first order and tokens. */
  movedByItemKey: ReadonlyMap<string, TrackedMovedEntry>;
  /** The `lastSeenAt` the card names ("since Sep 21"), or `null` on a first visit. */
  since: number | null;
  /**
   * Plan 39.2-13: the stored `lastSeenAt` exactly as it was when this visit's snapshot was read
   * (`null` on a first visit on this device). Unlike `since` it never moves on Mark as read, so
   * the recap card, which keys "synced since last seen" on it, survives the digest going quiet.
   */
  visitLastSeenAt: number | null;
  /** True once this visit's snapshot has been read (the match query settled); `visitLastSeenAt` is meaningful only then. */
  snapshotReady: boolean;
  /** Mark as read is offered only while expanded, the match query is settled and the tracked list resolved. */
  canMarkAsRead: boolean;
  markAsRead: () => void;
}

const NO_MOVED: ReadonlyMap<string, TrackedMovedEntry> = new Map();

/** A scheduled leave-write, held by ref so the next effect run can cancel it (StrictMode) or flush it (subject switch). */
interface PendingLeaveWrite {
  storageKey: string | null;
  timer: ReturnType<typeof setTimeout>;
  write: () => void;
}

/**
 * Plan 39.2-12 (TRK-01, T-03, D-05): the Dashboard's since-last-visit digest.
 *
 * READ. The stored snapshot is read ONCE per storage key, after the match query
 * has settled, and frozen for the visit (Assumption A6): a background refetch
 * or Mark as read never yanks the card mid-visit except through the explicit
 * quiet transition. The read is the "adjust state during render" shape of
 * `useInsightDismissals`, so there is no storage read while `isLoading`.
 * Counts come from the SUBJECT's games only (D-17).
 *
 * MOVED. Each tracked item's state class is read at the fixed
 * `DIGEST_HORIZON` (never the page's switch) and compared with the snapshot's
 * class through the shared D-05 table; an item absent from the snapshot never
 * counts.
 *
 * WRITE. "Last seen" advances in exactly two places, both only from settled
 * data and a resolved tracked list, so an unresolved read can never overwrite
 * the snapshot: `markAsRead`, and ONE effect that writes when the Dashboard is
 * left. Nothing is written while the match query is loading or fetching.
 */
export function useDigest({ enabled = true }: UseDigestOptions = {}): UseDigestResult {
  const { t } = useTranslation();
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { clientId } = useEffectiveSubject();
  const { allMatches, isLoading, isFetching } = useFilteredMatches();
  const watchlist = useWatchlist();
  const aliases = useOpponentAliases();
  // The one clock the digest reads, captured once as the hero's and the Tracked section's are
  // (the React Compiler forbids a bare `Date.now()` in the render body).
  const [nowMs] = useState(() => Date.now());

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

  const seeded = !isLoading && seededKey === storageKey;
  const entries = watchlist.data?.items;
  const aliasMap = aliases.data;

  const items = useMemo(
    () =>
      seeded && entries
        ? readDigestItems({ entries, matches: allMatches, aliasMap: aliasMap ?? {}, nowMs })
        : null,
    [seeded, entries, allMatches, aliasMap, nowMs],
  );

  // The tracked map a write would store. A resolved list stores every item's class; a FAILED
  // list carries the stored map forward rather than overwriting it with `{}`; an unresolved
  // list has nothing to store yet (`null`), so no write can be issued (production-gap #8).
  const currentTracked = useMemo<DigestSnapshot['tracked'] | null>(() => {
    if (items) return trackedSnapshotOf(items);
    return watchlist.isError ? (stored?.tracked ?? {}) : null;
  }, [items, watchlist.isError, stored]);

  const moved = useMemo(
    () => (stored && markedAt === null && items ? movedItemsOf(items, stored.tracked) : null),
    [stored, markedAt, items],
  );

  const movedByItemKey = useMemo<ReadonlyMap<string, TrackedMovedEntry>>(
    () => (moved ? new Map(moved.all.map((entry) => [entry.itemKey, entry] as const)) : NO_MOVED),
    [moved],
  );

  const movedRows = useMemo(() => {
    if (!moved || moved.shown.length === 0 || !entries) return [];
    const shownKeys = new Set(moved.shown.map((entry) => entry.itemKey));
    const rows = buildTrackedRows({
      entries: entries.filter((entry) => shownKeys.has(entry.itemKey)),
      matches: allMatches,
      aliasMap: aliasMap ?? {},
      horizon: DIGEST_HORIZON,
      nowMs,
      t,
      horizonOwnedByParent: false,
      moved: movedByItemKey,
    });
    const byKey = new Map(rows.map((row) => [row.itemKey, row] as const));
    // Keep the engine's own salience order (`selectMovedItems`), not the row builder's tiebreak.
    return moved.shown.flatMap((entry) => byKey.get(entry.itemKey) ?? []);
  }, [moved, entries, allMatches, aliasMap, nowMs, t, movedByItemKey]);

  // ---- Leave-with-data-settled write (T-03 / UI-SPEC G9) ------------------------------------
  // ONE effect owns it. Its cleanup schedules the write through a ref-held zero-delay timer and
  // the next run of the effect body clears any pending timer, so React StrictMode's synthetic
  // unmount/remount (same key) cancels the write while a real route leave lets it fire. A run
  // for a DIFFERENT key (subject switched by navigation without a remount) flushes the previous
  // subject's write under the previous subject's OWN captured key. The cleanup uses only what
  // its own render captured — never a shared "latest" ref — which is how subject B's data
  // would otherwise land under subject A's key. It exists only for a settled render, so
  // nothing is written while the match query is in flight, and never after Mark as read
  // (the card showed "nothing new"; later data was not shown and must stay unseen).
  const pendingLeaveWrite = useRef<PendingLeaveWrite | null>(null);
  const matchCount = allMatches.length;
  const leaveWriteEligible =
    enabled && seeded && !isFetching && currentTracked !== null && markedAt === null;

  useEffect(() => {
    const pending = pendingLeaveWrite.current;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pendingLeaveWrite.current = null;
      if (pending.storageKey !== storageKey) {
        pending.write();
      }
    }
    if (!leaveWriteEligible || currentTracked === null) {
      return undefined;
    }
    const capturedKey = storageKey;
    const capturedUid = uid;
    const capturedClientId = clientId;
    const capturedCount = matchCount;
    const capturedTracked = currentTracked;
    return () => {
      const write = () =>
        writeStoredDigest(capturedUid, capturedClientId, {
          lastSeenAt: Date.now(),
          lastSeenMatchCount: capturedCount,
          tracked: capturedTracked,
        });
      const timer = setTimeout(() => {
        pendingLeaveWrite.current = null;
        write();
      }, 0);
      pendingLeaveWrite.current = { storageKey: capturedKey, timer, write };
    };
  }, [leaveWriteEligible, storageKey, uid, clientId, matchCount, currentTracked]);

  if (isLoading || !seeded) {
    return {
      status: 'loading',
      newGames: 0,
      newEvents: 0,
      movedCount: null,
      movedRows: [],
      moreCount: 0,
      movedByItemKey: NO_MOVED,
      since: null,
      visitLastSeenAt: null,
      snapshotReady: false,
      canMarkAsRead: false,
      markAsRead: () => {},
    };
  }

  const newGames = stored ? Math.max(0, allMatches.length - stored.lastSeenMatchCount) : 0;
  const newEvents = stored ? countNewEvents(allMatches, stored.lastSeenAt) : 0;
  // A failed tracked list cannot say anything moved; an unresolved one cannot say yet.
  const movedCount =
    markedAt !== null ? 0 : moved ? moved.all.length : watchlist.isError ? 0 : null;

  let status: DigestStatus;
  if (markedAt !== null) {
    status = 'quiet';
  } else if (stored === null) {
    status = 'start';
  } else if (newGames > 0 || newEvents > 0 || (movedCount ?? 0) > 0) {
    status = 'expanded';
  } else if (movedCount === null) {
    // Nothing new in games or events and the tracked list is still resolving: quiet vs expanded is undecided.
    status = 'loading';
  } else {
    status = 'quiet';
  }

  const canMarkAsRead = status === 'expanded' && !isFetching && currentTracked !== null;

  function markAsRead(): void {
    if (!canMarkAsRead || currentTracked === null) return;
    const now = Date.now();
    writeStoredDigest(uid, clientId, {
      lastSeenAt: now,
      lastSeenMatchCount: allMatches.length,
      tracked: currentTracked,
    });
    setMarkedAt(now);
  }

  return {
    status,
    newGames,
    newEvents,
    movedCount,
    movedRows: markedAt !== null ? [] : movedRows,
    moreCount: moved?.moreCount ?? 0,
    movedByItemKey,
    since: markedAt ?? stored?.lastSeenAt ?? null,
    visitLastSeenAt: stored?.lastSeenAt ?? null,
    snapshotReady: true,
    canMarkAsRead,
    markAsRead,
  };
}
