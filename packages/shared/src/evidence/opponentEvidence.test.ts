import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import type { OpponentAliasMap } from '../opponent.js';
import { buildOpponentEvidence, buildOpponentProfile } from './opponentEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';
import { buildStageEvidence } from './stageEvidence.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: '',
    notes: '',
    matchType: 'none',
    map: { id: 1, name: 'Battlefield' },
    ...overrides,
  };
}

/**
 * Local port of `apps/web/src/hooks/useFilteredMatches.ts`'s
 * `applyOpponentAliases` (packages/shared cannot import from apps/web):
 * rewrites `match.opponent` on a RAW-key lookup with no normalization.
 * Used only to prove the two-hop no-op (R1-MEDIUM-7).
 */
function applyOpponentAliases(matches: Match[], aliasMap: OpponentAliasMap): Match[] {
  if (Object.keys(aliasMap).length === 0) {
    return matches;
  }
  return matches.map((match) => {
    if (!match.opponent || !Object.prototype.hasOwnProperty.call(aliasMap, match.opponent)) {
      return match;
    }
    return { ...match, opponent: aliasMap[match.opponent]! };
  });
}

/** The EVID-12/SC1 oracle fixture: one person under two spellings plus a slug, and an unrelated second opponent. */
function scOracleFixture(): Match[] {
  return [
    // 'mkleo' tag, 3 games.
    makeMatch({ id: 'm1', time: 1, win: true, opponent: 'mkleo' }),
    makeMatch({ id: 'm2', time: 2, win: false, opponent: 'mkleo' }),
    makeMatch({ id: 'm3', time: 3, win: true, opponent: 'mkleo' }),
    // 'Sponsor | MkLeo' — normalizes to 'mkleo' with NO alias needed.
    makeMatch({ id: 'm4', time: 4, win: true, opponent: 'Sponsor | MkLeo' }),
    // 'leo' tag, 3 games — merges into 'mkleo' ONLY via the alias map.
    makeMatch({ id: 'm5', time: 5, win: true, opponent: 'leo' }),
    makeMatch({ id: 'm6', time: 6, win: false, opponent: 'leo' }),
    makeMatch({ id: 'm7', time: 7, win: true, opponent: 'leo' }),
    // Slug-only row (no tag) — merges into 'mkleo' ONLY via the slug binding.
    makeMatch({ id: 'm8', time: 8, win: true, opponent: '', opponentUserSlug: 'user/abc' }),
    // The row that BINDS the slug to 'mkleo' (carries both the tag and the slug).
    makeMatch({ id: 'm9', time: 0.5, win: true, opponent: 'mkleo', opponentUserSlug: 'user/abc' }),
    // Unrelated second opponent, for contrast.
    makeMatch({ id: 'r1', time: 9, win: true, opponent: 'rival' }),
    makeMatch({ id: 'r2', time: 10, win: false, opponent: 'rival' }),
  ];
}

const ALIAS_MAP: OpponentAliasMap = { leo: 'mkleo' };

describe('buildOpponentEvidence — EVID-12/SC1 oracle', () => {
  it('merges two spellings plus a slug into ONE row whose total is the sum of every group, with the alias map', () => {
    const result = buildOpponentEvidence({
      matches: scOracleFixture(),
      aliasMap: ALIAS_MAP,
      refreshedAt: 0,
    });
    const mkleoRows = result.rows.filter((r) => r.identity === 'mkleo');
    expect(mkleoRows).toHaveLength(1);
    // 3 (mkleo) + 1 (Sponsor|MkLeo) + 3 (leo, via alias) + 1 (slug-only, via binding) + 1 (binder row) = 9.
    expect(mkleoRows[0]?.total).toBe(9);
    expect(result.rows).toHaveLength(2); // mkleo + rival
  });

  it('produces one continuous chronological buildOpponentProfile series spanning all merged groups', () => {
    const profile = buildOpponentProfile({
      matches: scOracleFixture(),
      aliasMap: ALIAS_MAP,
      opponentTag: 'mkleo',
      refreshedAt: 0,
    });
    expect(profile).not.toBeNull();
    expect(profile?.record.total).toBe(9);
    // recent is newest-first, up to recentLimit (default 10) — all 9 fit.
    const times = profile!.recent.map((m) => m.time);
    const sortedDesc = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sortedDesc);
  });

  it('returns THREE rows for the same fixture with an empty alias map (leo stays separate) — the mkleo/Sponsor merge and the slug binding still apply independently', () => {
    const result = buildOpponentEvidence({
      matches: scOracleFixture(),
      aliasMap: {},
      refreshedAt: 0,
    });
    const identities = result.rows.map((r) => r.identity).sort();
    expect(identities).toEqual(['leo', 'mkleo', 'rival']);
    const mkleoRow = result.rows.find((r) => r.identity === 'mkleo');
    // m1,m2,m3,m4,m8,m9 = 6 (leo's 3 games no longer merge without the alias).
    expect(mkleoRow?.total).toBe(6);
  });

  it('the two-hop no-op: running over applyOpponentAliases-rewritten matches equals running over the raw matches (R1-MEDIUM-7)', () => {
    const raw = scOracleFixture();
    const rewritten = applyOpponentAliases(raw, ALIAS_MAP);
    const overRaw = buildOpponentEvidence({ matches: raw, aliasMap: ALIAS_MAP, refreshedAt: 0 });
    const overRewritten = buildOpponentEvidence({
      matches: rewritten,
      aliasMap: ALIAS_MAP,
      refreshedAt: 0,
    });
    expect(overRewritten).toEqual(overRaw);
  });
});

describe('buildOpponentEvidence — INVENTORY contract (R2-BLOCKER-1)', () => {
  it('lists a 1-game and a 2-game opponent as rows, both abstained with a null confidenceTier — never deleted', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'one-gamer' }),
      makeMatch({ id: '2', time: 2, win: true, opponent: 'two-gamer' }),
      makeMatch({ id: '3', time: 3, win: false, opponent: 'two-gamer' }),
      makeMatch({ id: '4', time: 4, win: true, opponent: 'four-gamer' }),
      makeMatch({ id: '5', time: 5, win: true, opponent: 'four-gamer' }),
      makeMatch({ id: '6', time: 6, win: false, opponent: 'four-gamer' }),
      makeMatch({ id: '7', time: 7, win: true, opponent: 'four-gamer' }),
    ];
    const result = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: 0 });
    expect(result.rows).toHaveLength(3);
    const one = result.rows.find((r) => r.identity === 'one-gamer')!;
    const two = result.rows.find((r) => r.identity === 'two-gamer')!;
    const four = result.rows.find((r) => r.identity === 'four-gamer')!;
    expect(one.abstained).toBe(true);
    expect(one.sample.confidenceTier).toBeNull();
    expect(two.abstained).toBe(true);
    expect(two.sample.confidenceTier).toBeNull();
    expect(four.abstained).toBe(false);
    expect(four.sample.confidenceTier).toBe('low');
  });

  it('returns one row per opponent when every opponent has exactly one game — never an empty array', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'a' }),
      makeMatch({ id: '2', time: 2, win: true, opponent: 'b' }),
      makeMatch({ id: '3', time: 3, win: true, opponent: 'c' }),
    ];
    const result = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: 0 });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.abstained)).toBe(true);
  });

  it('the module applies no floor at all — no minGames parameter, no effectiveFloor call', () => {
    const path = fileURLToPath(new URL('./opponentEvidence.ts', import.meta.url));
    const body = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(/effectiveFloor\s*\(/.test(body)).toBe(false);
    expect(/minGames/.test(body)).toBe(false);
  });
});

describe('buildOpponentEvidence — displayTag, unnamed bucket, per-row fields (R2-MEDIUM-1)', () => {
  it("no row's displayTag begins with sgg: or pgg: — a slug-only identity with no binding lands in unnamed instead", () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'named' }),
      makeMatch({ id: '2', time: 2, win: true, opponent: 'named' }),
      makeMatch({ id: '3', time: 3, win: false, opponent: 'named' }),
      // Slug-only, no binding anywhere in this fixture.
      makeMatch({ id: '4', time: 4, win: true, opponent: '', opponentUserSlug: 'user/xyz' }),
    ];
    const result = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: 0 });
    expect(
      result.rows.every(
        (r) => !r.displayTag.startsWith('sgg:') && !r.displayTag.startsWith('pgg:'),
      ),
    ).toBe(true);
    expect(result.unnamed).toEqual({ games: 1, wins: 1, losses: 0, distinctIdentities: 1 });
  });

  it("each row's lastPlayedAt and source reflect every match that reached its identity, including alias-hopped and slug-bound ones", () => {
    const result = buildOpponentEvidence({
      matches: scOracleFixture(),
      aliasMap: ALIAS_MAP,
      refreshedAt: 0,
    });
    const mkleoRow = result.rows.find((r) => r.identity === 'mkleo')!;
    // Latest time across ALL 9 merged games is m8's slug-only row (time 8).
    expect(mkleoRow.lastPlayedAt).toBe(8);
    // All manual matches (no `source` field anywhere in the fixture).
    expect(mkleoRow.source).toBe('manual');
  });

  it("computes 'mixed' before single-source labels, matching getOpponentSources's branch order (R3-MEDIUM-1)", () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, opponent: 'x', source: 'startgg' }),
      makeMatch({ id: '2', time: 2, win: true, opponent: 'x' }), // manual
      makeMatch({ id: '3', time: 3, win: false, opponent: 'x' }),
    ];
    const result = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: 0 });
    expect(result.rows[0]?.source).toBe('mixed');
  });
});

describe('R1-BLOCKER-2 negative proof: buildStageEvidence / buildMatchupEvidence are alias-free', () => {
  it('rewriting every match.opponent leaves both outputs deep-equal', () => {
    const matches = scOracleFixture();
    const rewritten = matches.map((m, i) => ({ ...m, opponent: `random-tag-${i}` }));
    expect(buildStageEvidence({ matches: rewritten, refreshedAt: 0 })).toEqual(
      buildStageEvidence({ matches, refreshedAt: 0 }),
    );
    expect(buildMatchupEvidence({ matches: rewritten, refreshedAt: 0 })).toEqual(
      buildMatchupEvidence({ matches, refreshedAt: 0 }),
    );
  });
});
