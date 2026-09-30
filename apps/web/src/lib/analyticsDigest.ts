import {
  eventBlocksOf,
  movedTransition,
  parseDigestSnapshot,
  readTrackedItem,
  selectMovedItems,
  type DigestMovedToken,
  type DigestSnapshot,
  type DigestStateClass,
  type Match,
  type WatchlistItem,
} from '@smash-tracker/shared';
import {
  dedupeTrackedEntries,
  type WatchlistEntry,
} from '@/components/analytics/track/trackedRowModel';
import { subjectSegment } from '@/lib/subjectQueryKey';

/**
 * Plan 39.2-12 (TRK-01, T-03): the since-last-visit digest's device-local
 * store, one record per (uid, subject). A SIBLING of
 * `lib/insightDismissals.ts` and `lib/analyticsSelection.ts` — same prefix
 * family, same `subjectSegment` composition (the `client:` literal is spelled
 * in exactly one place) — and never RTDB: "last seen" is a property of a
 * device, so a second device shows its own digest.
 *
 * The stored value is `{ lastSeenAt, lastSeenMatchCount, tracked }`
 * (`DigestSnapshot` in shared). Renaming the key orphans every stored digest,
 * which reads as a first visit and degrades safely (no migration).
 */
export const ANALYTICS_DIGEST_KEY_PREFIX = 'smash-tracker.analyticsDigest';

/** `smash-tracker.analyticsDigest.<uid>.<subject>` — the SAME (uid, subject) shape the dismissal store uses. */
export function analyticsDigestStorageKey(uid: string, clientId: string | null): string {
  return `${ANALYTICS_DIGEST_KEY_PREFIX}.${uid}.${subjectSegment(clientId)}`;
}

/**
 * The stored snapshot, or `null` for a first visit: absent, corrupt, tampered
 * (shared's tolerant parse), no uid, no `window`, or a throwing store all read
 * the same way (DD-16) — never an error.
 */
export function readStoredDigest(
  uid: string | null,
  clientId: string | null,
): DigestSnapshot | null {
  if (!uid || typeof window === 'undefined') return null;
  try {
    return parseDigestSnapshot(
      window.localStorage.getItem(analyticsDigestStorageKey(uid, clientId)),
    );
  } catch {
    return null;
  }
}

/**
 * Writes `snapshot` for (uid, subject). No-ops without a uid or `window`; the
 * storage call is inside a silent try/catch — a throwing or full store leaves
 * the Dashboard fully usable, the digest just will not advance on this device.
 */
export function writeStoredDigest(
  uid: string | null,
  clientId: string | null,
  snapshot: DigestSnapshot,
): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(analyticsDigestStorageKey(uid, clientId), JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures — the digest just will not advance on this device.
  }
}

/**
 * D-17 / F3b: how many distinct events are new since `lastSeenAt`, derived from
 * the SUBJECT's games only (never the account-scoped tournament registry,
 * which would show the viewer's own events under a coach route). An event is
 * one block of the shared event-identity rule (`eventBlocksOf`: event name and
 * tournament name, split by proximity) — never a bare event name, which every
 * "Ultimate Singles" weekly shares (39.2-REVIEW WEB-CR-01) — and is new when
 * its FIRST game is later than `lastSeenAt`. Games with no event name belong
 * to no event.
 */
export function countNewEvents(matches: readonly Match[], lastSeenAt: number): number {
  return eventBlocksOf(matches).filter((block) => block.startMs > lastSeenAt).length;
}

/** One tracked item's read at the digest's fixed horizon (`DIGEST_HORIZON`), never the page's switch. */
export interface DigestItemState {
  /** The stored key of the entry standing for the item (the snapshot key). */
  itemKey: string;
  stateClass: DigestStateClass;
  /** The engine's own salience for the read; orders moved rows, never rendered. */
  salience: number;
}

/**
 * Reads every tracked item's state class from the SUBJECT's games (D-05, D-17).
 * Items that alias merges made one identity are read once, under the resolved
 * identity, and keyed by the entry that stands for them — the same grouping the
 * Tracked section displays, so the snapshot and the rows agree.
 */
export function readDigestItems(input: {
  entries: readonly WatchlistEntry[];
  matches: Match[];
  aliasMap: Record<string, string>;
  nowMs: number;
}): DigestItemState[] {
  const { entries, matches, aliasMap, nowMs } = input;
  return dedupeTrackedEntries(entries, matches, aliasMap).map(({ entry, identity }) => {
    // The stored ref may be an alias; the scope is always built on the resolved identity.
    const item: WatchlistItem =
      entry.item.kind === 'opponent' ? { ...entry.item, ref: identity } : entry.item;
    const read = readTrackedItem({ matches, item, nowMs });
    return { itemKey: entry.itemKey, stateClass: read.stateClass, salience: read.salience };
  });
}

/** The snapshot's `tracked` map for the items just read: every item's class, keyed by its stored key. */
export function trackedSnapshotOf(items: readonly DigestItemState[]): DigestSnapshot['tracked'] {
  return Object.fromEntries(items.map((item) => [item.itemKey, item.stateClass]));
}

/** Two `tracked` maps hold the same classes under the same keys. */
export function sameTracked(a: DigestSnapshot['tracked'], b: DigestSnapshot['tracked']): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** One moved item, keyed by stored item key. */
export interface DigestMoved {
  itemKey: string;
  token: DigestMovedToken;
  salience: number;
}

/**
 * D-05: an item MOVED when `movedTransition(snapshot class, current class)` is
 * non-null — an item absent from the snapshot is never one. Returns the moved
 * items in the engine's salience order (`selectMovedItems` orders them; its cap
 * is applied by the caller through `shown` / `moreCount`).
 */
export function movedItemsOf(
  items: readonly DigestItemState[],
  previous: DigestSnapshot['tracked'],
): { all: DigestMoved[]; shown: DigestMoved[]; moreCount: number } {
  const all: DigestMoved[] = [];
  for (const item of items) {
    const token = movedTransition(previous[item.itemKey], item.stateClass);
    if (token !== null) {
      all.push({ itemKey: item.itemKey, token, salience: item.salience });
    }
  }
  const { shown, moreCount } = selectMovedItems(all);
  return { all, shown, moreCount };
}
