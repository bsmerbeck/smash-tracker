/**
 * Plan 39.2-12 (UI-SPEC G1): the Dashboard oracle's tracked list and digest
 * seed, both derived from the harness dataset's own games so the measured page
 * carries an EXPANDED digest and 25 tracked items on realistic data.
 *
 * Kept as a plain module (like `scoutGuardFixture.mjs`) so the fixture plugin
 * (which answers `GET /api/watchlist`) and the runner (which seeds the digest's
 * device-local key before the app boots) build from ONE definition and can
 * never disagree about which items exist.
 */
import { buildWatchlistItemKey } from '@smash-tracker/shared';

/** The WATCHLIST_MAX_ITEMS ceiling the server enforces; the fixture fills it. */
export const GUARD_WATCHLIST_ITEM_COUNT = 25;

/** The harness's fake auth uid (`src/guardHarness/fakeGuardAuthContextValue.ts`); a test pins the two together. */
export const GUARD_DIGEST_UID = 'guard-layout-harness-user';

/** `analyticsDigestStorageKey(uid, null)`: prefix, uid and the personal subject segment. */
export const GUARD_DIGEST_STORAGE_KEY = `smash-tracker.analyticsDigest.${GUARD_DIGEST_UID}.personal`;

function countBy(matches, keyOf) {
  const counts = new Map();
  for (const match of matches) {
    const key = keyOf(match);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1),
  );
}

/**
 * Up to 25 tracked items drawn from `matches`: stages first (at most 2), then
 * matchups (at most 8), then the most-played opponents to fill the rest.
 * Deterministic: ties break by key, so the served list and the seeded snapshot
 * always agree.
 * @param {ReadonlyArray<{ opponent?: string | null; fighter_id: number; opponent_id: number; map?: { id: number } }>} matches
 * @returns {{ itemKey: string; item: { kind: string; ref: unknown; createdAt: number } }[]}
 */
export function buildGuardWatchlist(matches) {
  const refs = [];
  for (const [stageId] of countBy(matches, (m) => (m.map?.id ? m.map.id : null)).slice(0, 2)) {
    refs.push({ kind: 'stage', ref: stageId });
  }
  for (const [pair] of countBy(matches, (m) => `${m.fighter_id}-${m.opponent_id}`).slice(0, 8)) {
    const [fighterId, vsFighterId] = String(pair).split('-').map(Number);
    refs.push({ kind: 'matchup', ref: { fighterId, vsFighterId } });
  }
  const opponents = countBy(matches, (m) => {
    const tag = m.opponent?.trim().toLowerCase();
    return tag ? tag : null;
  });
  for (const [tag] of opponents) {
    if (refs.length >= GUARD_WATCHLIST_ITEM_COUNT) break;
    refs.push({ kind: 'opponent', ref: tag });
  }
  return refs.slice(0, GUARD_WATCHLIST_ITEM_COUNT).map((input, index) => ({
    itemKey: buildWatchlistItemKey(input),
    item: { ...input, createdAt: index + 1 },
  }));
}

/**
 * The device-local digest snapshot that makes the Dashboard digest EXPANDED:
 * last seen at the epoch with one game counted (so every game and event is new)
 * and every tracked item remembered as `locked`, which the D-05 table reads as
 * moved ("now enough games") for any item that is no longer locked. The runner
 * proves the seed took by waiting on the expanded card and its moved rows.
 */
export function buildGuardDigestSeed(matches) {
  const tracked = Object.fromEntries(
    buildGuardWatchlist(matches).map((entry) => [entry.itemKey, 'locked']),
  );
  return {
    key: GUARD_DIGEST_STORAGE_KEY,
    value: JSON.stringify({ lastSeenAt: 1, lastSeenMatchCount: 1, tracked }),
  };
}
