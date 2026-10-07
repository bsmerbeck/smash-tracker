import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN_STAGE_ID,
  buildStageBreakdown,
  resolveOpponentIdentities,
  trackedItemScope,
  type Match,
  type WatchlistItem,
} from '@smash-tracker/shared';
import { applyOpponentAliases } from '@/hooks/useFilteredMatches';

/**
 * A Tracked row reads its record, chip and strip through `trackedItemScope`.
 * Those numbers are only honest if the scope selects EXACTLY the games the
 * page the row opens selects for the same item. This test states that for all
 * three kinds against one fixture: for an opponent, a matchup and a stage
 * item, `trackedItemScope(item).filter(matches)` equals the ids the host
 * page's own scope selects.
 *
 * Each host's scope is reproduced here from its page (the pages inline it in
 * a component body and export nothing to call), and the last block reads each
 * page's source to prove the expression reproduced below is still the one the
 * page runs, so a page that changes its scope fails here instead of drifting
 * away from the Tracked row silently.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readPage(repoRelativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8');
}

let nextId = 0;
function game(overrides: Partial<Match> & Pick<Match, 'win'>): Match {
  nextId += 1;
  return {
    id: `eq-${nextId}`,
    time: 1_000 + nextId * 1_000,
    fighter_id: 1,
    opponent_id: 2,
    ...overrides,
  } as Match;
}

/**
 * A history built to make every filter earn its keep: two spellings of one
 * player (a merged alias), a provider id that binds a differently-spelled tag
 * to the same person, a bystander, an unnamed opponent, two pairings, and
 * three stage buckets including "no map at all".
 */
const RAW_MATCHES: Match[] = [
  game({ win: true, opponent: 'mkleo', opponentUserSlug: 'user/abc', map: { id: 1, name: 'x' } }),
  game({ win: false, opponent: 'mkleo', map: { id: 1, name: 'x' } }),
  game({ win: true, opponent: 'mkleo2', map: { id: 2, name: 'y' } }),
  game({
    win: false,
    opponent: 'leo-alt',
    opponentUserSlug: 'user/abc',
    map: { id: 2, name: 'y' },
  }),
  game({
    win: true,
    opponent: 'sparg0',
    fighter_id: 10,
    opponent_id: 12,
    map: { id: 1, name: 'x' },
  }),
  game({ win: false, opponent: 'sparg0', fighter_id: 10, opponent_id: 12 }),
  game({ win: true, fighter_id: 10, opponent_id: 12, map: { id: 0, name: 'unknown' } }),
  game({
    win: true,
    opponent: 'sparg0',
    fighter_id: 10,
    opponent_id: 3,
    map: { id: 3, name: 'z' },
  }),
  game({ win: false }),
];

const ALIAS_MAP: Record<string, string> = { mkleo2: 'mkleo' };

const NOW = 1_700_000_000_000;

function itemOf(entry: Pick<WatchlistItem, 'kind' | 'ref'>): WatchlistItem {
  return { ...entry, createdAt: NOW } as WatchlistItem;
}

function ids(matches: Match[]): string[] {
  return matches.map((match) => match.id).sort();
}

describe('trackedItemScope selects exactly what the host page selects', () => {
  // The Dashboard hands the scope the alias-APPLIED history (`useFilteredMatches().allMatches`);
  // the hub resolves identities over that same history with the alias map.
  const allMatches = applyOpponentAliases(RAW_MATCHES, ALIAS_MAP);

  it("opponent: the hub selects the games whose resolved identity is the tag's", () => {
    // The hub (`OpponentHubPage.tsx`): prepResolve over allMatches + the alias map, prepIdentity of the path tag.
    const prepResolve = resolveOpponentIdentities(allMatches, ALIAS_MAP);
    const prepIdentity = prepResolve({ opponent: 'mkleo' });
    const hubIds = ids(allMatches.filter((m) => prepResolve(m) === prepIdentity));

    const scoped = trackedItemScope(itemOf({ kind: 'opponent', ref: 'mkleo' })).filter(allMatches);

    expect(hubIds).toHaveLength(4);
    expect(ids(scoped)).toEqual(hubIds);
  });

  it('opponent: the shared contract also holds on RAW games when the alias names are handed in', () => {
    const prepResolve = resolveOpponentIdentities(RAW_MATCHES, ALIAS_MAP);
    const prepIdentity = prepResolve({ opponent: 'mkleo' });
    const hubIds = ids(RAW_MATCHES.filter((m) => prepResolve(m) === prepIdentity));

    const scoped = trackedItemScope(itemOf({ kind: 'opponent', ref: 'mkleo' }), {
      opponentAliases: ['mkleo2'],
    }).filter(RAW_MATCHES);

    expect(ids(scoped)).toEqual(hubIds);
  });

  it('opponent: a bystander and the unnamed bucket are never selected', () => {
    const scoped = trackedItemScope(itemOf({ kind: 'opponent', ref: 'sparg0' })).filter(allMatches);
    expect(scoped.every((match) => match.opponent === 'sparg0')).toBe(true);
    expect(scoped).toHaveLength(3);
  });

  it('matchup: the Matchups pairing selects fighter_id and opponent_id together', () => {
    // `MatchupsPage.tsx`'s `matchupMatches`.
    const fighterId = 10;
    const opponentId = 12;
    const pageIds = ids(
      allMatches.filter((m) => m.fighter_id === fighterId && m.opponent_id === opponentId),
    );

    const scoped = trackedItemScope(
      itemOf({ kind: 'matchup', ref: { fighterId, vsFighterId: opponentId } }),
    ).filter(allMatches);

    expect(pageIds).toHaveLength(3);
    expect(ids(scoped)).toEqual(pageIds);
  });

  it('stage: the stage page selects its stage bucket, absent map included for the unknown stage only', () => {
    for (const stageId of [1, 2, 3]) {
      // `StageDetailPage.tsx`: `buildStageBreakdown` counts `stageBucketId(m) === stageId`, and the
      // page's own filter line reads `(m.map?.id ?? UNKNOWN_STAGE_ID) === resolvedStageId`.
      const pageIds = ids(allMatches.filter((m) => (m.map?.id ?? UNKNOWN_STAGE_ID) === stageId));
      const breakdown = buildStageBreakdown({
        matches: allMatches,
        aliasMap: ALIAS_MAP,
        stageId,
        refreshedAt: NOW,
        minMatches: 1,
      });

      const scoped = trackedItemScope(itemOf({ kind: 'stage', ref: stageId })).filter(allMatches);

      expect(ids(scoped), `stage ${stageId}`).toEqual(pageIds);
      expect(breakdown.sample.rawSampleSize, `stage ${stageId} sample`).toBe(scoped.length);
    }
  });

  it('stage: a game with no map at all is never in a tracked stage (it is the unknown bucket)', () => {
    const noMap = allMatches.filter((m) => m.map === undefined);
    expect(noMap.length).toBeGreaterThan(0);
    for (const stageId of [1, 2, 3]) {
      const scoped = trackedItemScope(itemOf({ kind: 'stage', ref: stageId })).filter(allMatches);
      expect(scoped.some((match) => noMap.includes(match))).toBe(false);
    }
  });

  describe('the expressions reproduced above are still the ones the pages run', () => {
    it('the opponent hub filters allMatches by its resolved identity', () => {
      const source = readPage('apps/web/src/pages/Opponents/OpponentHubPage.tsx');
      expect(source).toContain('resolveOpponentIdentities(allMatches, aliasMap ?? {})');
      expect(source).toContain('allMatches.filter((m) => prepResolve(m) === prepIdentity)');
    });

    it('the Matchups page filters by fighter id AND opponent id', () => {
      const source = readPage('apps/web/src/pages/Matchups/MatchupsPage.tsx');
      expect(source).toContain('m.fighter_id === effectiveFighterIdForFilter &&');
      expect(source).toContain('m.opponent_id === effectiveOpponentIdForFilter');
    });

    it('the stage page keys a stage on the map id, an absent map being the unknown stage', () => {
      const source = readPage('apps/web/src/pages/Stages/StageDetailPage.tsx');
      expect(source).toContain('(m.map?.id ?? UNKNOWN_STAGE_ID) === resolvedStageId');
      expect(source).toContain('buildStageBreakdown');
    });
  });
});
