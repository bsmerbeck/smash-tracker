import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { movedItemsOf, readDigestItems } from '@/lib/analyticsDigest';
import { buildTrackedRows, type WatchlistEntry } from './trackedRowModel';

/**
 * 39.2-REVIEW SH-WR-04: a Tracked row's "moved" token and its chip must never contradict each
 * other. The token is the digest's class change, read at the fixed `DIGEST_HORIZON` and the
 * stricter moved z; a chip read at the default z (and at whatever horizon the page's switch
 * names) can call the same games a trend. A row that carries a token therefore shows the chip of
 * the SAME read that produced the token.
 */

const NOW_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;
const t = ((key: string) => key) as unknown as TFunction;

/** Mario (1) vs Luigi (10): 200 older games at 40%, then a 21–9 run — steady at z 3.09, a trend at 1.96. */
function twentyOneNine(): Match[] {
  const rows: Match[] = [];
  for (let i = 0; i < 230; i += 1) {
    const win = i < 200 ? i % 5 < 2 : (i - 200) % 10 < 7;
    rows.push({
      id: `g${String(i).padStart(4, '0')}`,
      fighter_id: 1,
      opponent_id: 10,
      opponent: 'rival',
      time: NOW_MS - (1000 - i) * HOUR_MS,
      win,
      matchType: 'none',
    } as Match);
  }
  return rows;
}

const ENTRY: WatchlistEntry = {
  itemKey: 'matchup:1-10',
  item: { kind: 'matchup', ref: { fighterId: 1, vsFighterId: 10 }, createdAt: 1 },
};

function rowsAt(horizon: 'last30' | 'last90', previousClass: 'down' | undefined) {
  const matches = twentyOneNine();
  const items = readDigestItems({ entries: [ENTRY], matches, aliasMap: {}, nowMs: NOW_MS });
  const moved = movedItemsOf(items, previousClass ? { [ENTRY.itemKey]: previousClass } : {});
  return buildTrackedRows({
    entries: [ENTRY],
    matches,
    aliasMap: {},
    horizon,
    nowMs: NOW_MS,
    t,
    moved: new Map(moved.all.map((entry) => [entry.itemKey, entry] as const)),
  });
}

describe('Tracked row: the moved token and its chip agree (39.2-REVIEW SH-WR-04)', () => {
  it('down at the last visit, 21–9 now: the token reads steady and so does the chip', () => {
    for (const horizon of ['last30', 'last90'] as const) {
      const [row] = rowsAt(horizon, 'down');
      expect(row?.movedToken, horizon).toBe('steady');
      expect(row?.chip?.state, horizon).toBe('steady');
    }
  });

  it('control: without a moved token the same row keeps the page-horizon engine chip (a trend here)', () => {
    const [row] = rowsAt('last30', undefined);
    expect(row?.movedToken).toBeNull();
    expect(row?.chip?.state).toBe('up');
  });
});
