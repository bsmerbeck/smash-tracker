import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { buildPrepBriefActions, type PrepBriefActionsInput } from './prepBriefClaims';

/**
 * Phase 39 (plan 39-11, review C1-H8): the free prep brief's action producer.
 * The anti-empty proof — a history-bearing fixture MUST yield three ranked,
 * claim-citing candidates; a permanently-empty free brief is the failure this
 * file exists to catch.
 */

const REFRESHED_AT = 1_800_000_000_000;
const MARIO = 1;
const DONKEY_KONG = 2;
const LINK = 3;
const BATTLEFIELD = 1;
const BIG_BATTLEFIELD = 2;

let nextId = 0;
function makeMatch(overrides: Partial<Match> & Pick<Match, 'win'>): Match {
  nextId += 1;
  return {
    id: `m${String(nextId).padStart(3, '0')}`,
    time: 1_700_000_000_000 + nextId * 60_000,
    fighter_id: MARIO,
    opponent_id: DONKEY_KONG,
    map: { id: BATTLEFIELD, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

const VOD_NOTE = [{ id: 't1', seconds: 42, note: 'missed punish' }] as Match['vodTimestamps'];

/** Mario vs "rival": 1–5 against Donkey Kong on Battlefield, 1–3 against Link on Big Battlefield, two lost games carrying VOD notes. */
function rivalHistory(opponent = 'rival'): Match[] {
  return [
    makeMatch({ opponent, win: true }),
    makeMatch({ opponent, win: false, vodTimestamps: VOD_NOTE }),
    makeMatch({ opponent, win: false }),
    makeMatch({ opponent, win: false }),
    makeMatch({ opponent, win: false }),
    makeMatch({ opponent, win: false, vodTimestamps: VOD_NOTE }),
    makeMatch({
      opponent,
      win: true,
      opponent_id: LINK,
      map: { id: BIG_BATTLEFIELD, name: 'Big Battlefield' },
    }),
    makeMatch({
      opponent,
      win: false,
      opponent_id: LINK,
      map: { id: BIG_BATTLEFIELD, name: 'Big Battlefield' },
    }),
    makeMatch({
      opponent,
      win: false,
      opponent_id: LINK,
      map: { id: BIG_BATTLEFIELD, name: 'Big Battlefield' },
    }),
    makeMatch({
      opponent,
      win: false,
      opponent_id: LINK,
      map: { id: BIG_BATTLEFIELD, name: 'Big Battlefield' },
    }),
  ];
}

function input(overrides: Partial<PrepBriefActionsInput> = {}): PrepBriefActionsInput {
  return {
    matches: rivalHistory(),
    aliasMap: {},
    likelyOpponentTags: ['rival'],
    myFighters: { primary: [MARIO], secondary: [] },
    refreshedAt: REFRESHED_AT,
    ...overrides,
  };
}

describe('buildPrepBriefActions', () => {
  it('a history-bearing fixture yields three ranked candidates, each citing a real claim (C1-H8 anti-empty)', () => {
    const { claims, actions } = buildPrepBriefActions(input());
    expect(claims.length).toBeGreaterThanOrEqual(3);
    expect(actions).toHaveLength(3);
    const claimIds = new Set(claims.map((claim) => claim.id));
    for (const action of actions) {
      expect(action.claimIds.length).toBeGreaterThan(0);
      for (const claimId of action.claimIds) {
        expect(claimIds.has(claimId)).toBe(true);
      }
    }
    expect(actions.map((action) => action.id)).toEqual(['a01', 'a02', 'a03']);
  });

  it('includes a matchup_practice candidate built from the caller’s character axes (C2-M8)', () => {
    const { actions } = buildPrepBriefActions(input());
    const practice = actions.find((action) => action.kind === 'matchup_practice');
    expect(practice).toBeDefined();
    expect(practice!.target).toMatchObject({
      kind: 'matchup',
      myFighterId: MARIO,
      opponentFighterId: DONKEY_KONG,
    });
  });

  it('carries the matchup_advisor_pick and my_character_record families once the caller’s fighters are known', () => {
    const { claims } = buildPrepBriefActions(input());
    const predicates = new Set(claims.map((claim) => claim.predicate));
    expect(predicates.has('my_character_record')).toBe(true);
    expect(predicates.has('matchup_advisor_pick')).toBe(true);
    expect(predicates.has('head_to_head_record')).toBe(true);
    expect(predicates.has('opponent_character_usage')).toBe(true);
    expect(predicates.has('stage_record')).toBe(true);
  });

  it('a lost game with a VOD note becomes a vod_review door target', () => {
    const { actions } = buildPrepBriefActions(input());
    const vod = actions.find((action) => action.kind === 'vod_review');
    expect(vod).toBeDefined();
    expect(vod!.target.kind).toBe('vod');
  });

  it('a cold start (no matches) yields zero claims and zero candidates, without throwing', () => {
    const result = buildPrepBriefActions(input({ matches: [] }));
    expect(result.claims).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it('no likely opponents yields no opponent-backed candidates', () => {
    const { actions } = buildPrepBriefActions(input({ likelyOpponentTags: [] }));
    expect(actions).toEqual([]);
  });

  it('the same input twice yields deeply-equal output (engine determinism)', () => {
    const fixture = input();
    expect(buildPrepBriefActions(fixture)).toEqual(buildPrepBriefActions(fixture));
  });

  it('an alias-only opponent still contributes — identity is resolved, never a raw tag comparison', () => {
    const aliasOnly = input({
      matches: rivalHistory('old-tag'),
      aliasMap: { 'old-tag': 'rival' },
      likelyOpponentTags: ['rival'],
    });
    const resolved = buildPrepBriefActions(aliasOnly);
    expect(resolved.actions.length).toBeGreaterThan(0);
    expect(
      resolved.claims.some(
        (claim) =>
          claim.predicate === 'head_to_head_record' && claim.subject.opponentTag === 'rival',
      ),
    ).toBe(true);

    // Control: without the alias the same games belong to someone else.
    const unaliased = buildPrepBriefActions({ ...aliasOnly, aliasMap: {} });
    expect(unaliased.claims.some((claim) => claim.predicate === 'head_to_head_record')).toBe(false);
  });
});

describe('prepBriefClaims source (no new route, shared keying)', () => {
  const source = readFileSync(resolve(__dirname, 'prepBriefClaims.ts'), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('reaches for no hook, fetch, API client or query key', () => {
    expect(source).not.toMatch(/use[A-Z]|fetch\(|api\.|queryKey/);
  });

  it('keys rows through the shared evidenceIdFor and orders opponents through the shared orderSnapshotOpponents — no local sort of tags, no hand-built key', () => {
    expect(source).toMatch(
      /evidenceIdFor\(\{ predicate, subject, opponentOrder: opponentTags \}\)/,
    );
    expect(source).toMatch(/orderSnapshotOpponents\(/);
    expect(source).not.toMatch(/localeCompare/);
    expect(source).not.toMatch(/rows\[`/);
  });

  it('runs the shared engine end to end', () => {
    for (const builder of [
      'buildClaimSet(',
      'buildActionCandidates(',
      'rankActionCandidates(',
      'selectTopActions(',
      'buildMatchupAdvisorWithGate(',
      'buildOpponentCrossTab(',
      'buildStageEvidence(',
      'resolveOpponentIdentities(',
    ]) {
      expect(source).toContain(builder);
    }
  });
});
