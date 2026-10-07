import { describe, expect, it } from 'vitest';
import {
  parseDigestSnapshot,
  watchlistItemKeySchema,
  watchlistResponseSchema,
} from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { analyticsDigestStorageKey } from '../src/lib/analyticsDigest';
import { GUARD_HARNESS_UID } from '../src/guardHarness/fakeGuardAuthContextValue';
import {
  GUARD_DIGEST_STORAGE_KEY,
  GUARD_DIGEST_UID,
  GUARD_WATCHLIST_ITEM_COUNT,
  buildGuardDigestSeed,
  buildGuardWatchlist,
} from './digestGuardFixture.mjs';

/**
 * Plan 39.2-12 (UI-SPEC G1): the Dashboard oracle's tracked list and digest seed. A seed
 * under the wrong key, or a snapshot the app's tolerant parse rejects, would leave
 * guard:layout measuring a first-visit card — these tests pin the fixture to the app's own
 * key builder, schema and the harness's fake uid.
 */
const matches = generateSyntheticMatches({
  seed: 39_122_001,
  count: 400,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1],
});

describe('digest guard fixture (plan 39.2-12)', () => {
  it('the seed key is exactly the app key for the harness uid and the personal subject', () => {
    expect(GUARD_DIGEST_UID).toBe(GUARD_HARNESS_UID);
    expect(GUARD_DIGEST_STORAGE_KEY).toBe(analyticsDigestStorageKey(GUARD_HARNESS_UID, null));
    expect(buildGuardDigestSeed(matches).key).toBe(GUARD_DIGEST_STORAGE_KEY);
  });

  it('serves 25 valid, unique tracked items that pass the wire schema', () => {
    const items = buildGuardWatchlist(matches);
    expect(items).toHaveLength(GUARD_WATCHLIST_ITEM_COUNT);
    expect(new Set(items.map((entry) => entry.itemKey)).size).toBe(25);
    for (const entry of items) {
      expect(watchlistItemKeySchema.safeParse(entry.itemKey).success, entry.itemKey).toBe(true);
    }
    expect(() => watchlistResponseSchema.parse({ items })).not.toThrow();
    expect(new Set(items.map((entry) => entry.item.kind))).toEqual(
      new Set(['stage', 'matchup', 'opponent']),
    );
  });

  it('is deterministic and drawn from the dataset (no item names a game that is not there)', () => {
    expect(buildGuardWatchlist(matches)).toEqual(buildGuardWatchlist([...matches].reverse()));
    const tags = new Set(
      matches.map((match) => match.opponent?.trim().toLowerCase()).filter(Boolean),
    );
    for (const entry of buildGuardWatchlist(matches)) {
      if (entry.item.kind === 'opponent') expect(tags.has(entry.item.ref)).toBe(true);
    }
  });

  it('the seeded snapshot parses tolerantly, is older than every game, and remembers exactly the served items', () => {
    const seed = buildGuardDigestSeed(matches);
    const snapshot = parseDigestSnapshot(seed.value);
    expect(snapshot).not.toBeNull();
    expect(snapshot.lastSeenAt).toBeLessThan(Math.min(...matches.map((match) => match.time)));
    expect(snapshot.lastSeenMatchCount).toBeLessThan(matches.length);
    expect(Object.keys(snapshot.tracked).sort()).toEqual(
      buildGuardWatchlist(matches)
        .map((entry) => entry.itemKey)
        .sort(),
    );
  });

  it('an empty dataset yields an empty list, not a crash', () => {
    expect(buildGuardWatchlist([])).toEqual([]);
  });
});
