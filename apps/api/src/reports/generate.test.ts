import { describe, expect, it } from 'vitest';
import {
  ABSTENTION_FLOOR_GAMES,
  CLAIM_SCHEMA_VERSION,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
  type ScoutBinding,
  type ScoutReportData,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  assembleReportPayload,
  generateScoutReport,
  ReportGenerationError,
  selectOpponentMatches,
  type AnthropicLikeClient,
  type ReportPayload,
} from './generate.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  CLAIM_ID_VOCABULARY,
  MIN_VIABLE_CLAIMS,
  buildClaimSet,
  resolveSubjectDisplayName,
} from '@smash-tracker/shared';
import { claimSelectionSchema } from './claimSelection.js';
import { snapshotIdFor } from './snapshotId.js';
import { seedViableEvidence } from '../test-support/viableEvidenceFixture.js';
import { buildModelPayload } from './generate.js';

const UID = 'test-uid-123';

const SCOUT: ScoutReportData = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  sampledSets: 10,
  sampledGames: 20,
  characters: [
    { fighterId: 8, games: 12, wins: 8 }, // Fox
    { fighterId: 22, games: 8, wins: 4 }, // Falco
  ],
  stages: [{ stageId: 1, games: 20, wins: 12 }],
  recentEvents: [],
  commonOpponents: [],
};

describe('assembleReportPayload', () => {
  it('returns empty head-to-head, zeroed userContext, and null notes with no data', async () => {
    const database = new FakeDatabase();
    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    // Not `.toBe` (reference equality): `assembleReportPayload` rebuilds
    // `scout` into a new object that strips `games` (V9-D) before it reaches
    // Claude — see the doc comment on `ReportPayload.scout`.
    expect(payload.scout).toEqual(SCOUT);
    expect(payload.headToHead).toEqual([]);
    // Phase 36 (D-11, D-14, R1-HIGH-2): relaxed from `toEqual` to
    // `toMatchObject` — every `MatchupAggregate` now also carries `sample`
    // and `claimKind` (see generate.ts's `vsTopCharacters` doc comment),
    // which an exact-shape `toEqual` would reject by construction. The four
    // original field VALUES below (`opponentCharacter`, `wins`, `losses`,
    // `topStages`) are unchanged.
    expect(payload.userContext.vsTopCharacters).toMatchObject([
      { opponentCharacter: 'Fox', wins: 0, losses: 0, topStages: [] },
      { opponentCharacter: 'Falco', wins: 0, losses: 0, topStages: [] },
    ]);
    expect(payload.userContext.recentForm).toEqual({ wins: 0, losses: 0, sampleSize: 0 });
    expect(payload.notes).toBeNull();
    expect(payload.userContext.myFighters).toEqual({ primary: [], secondary: [] });
    expect(payload.userContext.myCharacterRecords).toEqual([]);
  });

  it('strips `games` (V9-D) from the scout payload sent to Claude, keeping every other field', async () => {
    const scoutWithGames: ScoutReportData = {
      ...SCOUT,
      games: [
        {
          time: 1_700_000_000_000,
          win: true,
          fighterId: 8,
          opponentFighterId: 22,
          stageId: 1,
          stageName: 'Battlefield',
          opponentTag: 'PowPow',
          eventName: 'Ultimate Singles',
        },
      ],
    };
    const database = new FakeDatabase();
    const payload = await assembleReportPayload(
      UID,
      scoutWithGames,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.scout).not.toHaveProperty('games');
    expect(payload.scout).toEqual(SCOUT);
  });

  it('maps myFighters sprite ids to character names', async () => {
    const database = new FakeDatabase();
    database.seed(`primaryFighters/${UID}`, [8]); // Fox
    database.seed(`secondaryFighters/${UID}`, [22]); // Falco

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.myFighters).toEqual({ primary: ['Fox'], secondary: ['Falco'] });
  });

  it('builds myCharacterRecords for the union of selections and top-played characters, vs. the opponent’s top characters', async () => {
    const database = new FakeDatabase();
    database.seed(`primaryFighters/${UID}`, [1]); // Mario (the user's main)
    database.seed(`secondaryFighters/${UID}`, []);
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1, // Mario
        opponent_id: 8, // Fox
        time: 3,
        win: true,
        opponent: 'a',
      },
      m2: {
        fighter_id: 1, // Mario
        opponent_id: 8, // Fox
        time: 2,
        win: false,
        opponent: 'b',
      },
      m3: {
        fighter_id: 1, // Mario
        opponent_id: 22, // Falco
        time: 1,
        win: true,
        opponent: 'c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    // Phase 36 (D-11, D-14): relaxed from `toEqual` to `toMatchObject` —
    // `CharacterRecord` now also carries a `sample: SampleMeta` field (see
    // generate.ts's `myCharacterRecords` doc comment), which an exact-shape
    // `toEqual` here would reject by construction the same way it would for
    // `vsTopCharacters` (see the two named relaxations elsewhere in this
    // file). The four original field VALUES below are unchanged.
    expect(payload.userContext.myCharacterRecords).toMatchObject([
      {
        userCharacter: 'Mario',
        wins: 2,
        losses: 1,
        vsOpponentCharacter: [
          { opponentCharacter: 'Fox', wins: 1, losses: 1 },
          { opponentCharacter: 'Falco', wins: 1, losses: 0 },
        ],
      },
    ]);
  });

  it('includes the user’s top-5 most-played characters even without a primary/secondary selection', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: { fighter_id: 9, opponent_id: 8, time: 1, win: true, opponent: 'a' }, // Pikachu
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.myCharacterRecords).toHaveLength(1);
    expect(payload.userContext.myCharacterRecords[0]).toMatchObject({ userCharacter: 'Pikachu' });
  });

  it('matches head-to-head by opponentUserSlug (strongest signal)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'someone else entirely',
        opponentUserSlug: 'user/07dc2239',
        eventName: 'Ultimate Singles',
        roundText: 'Winners Round 2',
        stocksLeft: 2,
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toEqual([
      {
        result: 'win',
        userCharacter: 'Mario',
        opponentCharacter: 'Fox',
        stage: 'Battlefield',
        eventName: 'Ultimate Singles',
        roundText: 'Winners Round 2',
        stocksLeft: 2,
        date: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  it('matches head-to-head by canonical opponent name when no userSlug is present', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: false,
        opponent: 'pandem1c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toHaveLength(1);
    expect(payload.headToHead[0]).toMatchObject({ result: 'loss' });
  });

  it('resolves the opponent name through the alias map before matching', async () => {
    const database = new FakeDatabase();
    database.seed(`opponentAliases/${UID}`, { 'sponsor tag': 'pandem1c' });
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        opponent: 'sponsor tag',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toHaveLength(1);
  });

  it('does not include matches against other opponents in head-to-head', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        opponent: 'someone unrelated',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toEqual([]);
  });

  it('aggregates raw W/L and top stages against the scouted player’s top characters', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 3,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'a',
      },
      m2: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 2,
        win: false,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'b',
      },
      m3: {
        fighter_id: 1,
        opponent_id: 22, // Falco
        time: 1,
        win: true,
        map: { id: 3, name: 'Final Destination' },
        opponent: 'c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    // Phase 36 (D-11, D-14, R1-HIGH-2): relaxed from `toEqual` to
    // `toMatchObject` — see the identical relaxation and rationale above.
    // The four original field VALUES are unchanged.
    expect(payload.userContext.vsTopCharacters).toMatchObject([
      {
        opponentCharacter: 'Fox',
        wins: 1,
        losses: 1,
        topStages: [{ stage: 'Battlefield', wins: 1, losses: 1 }],
      },
      {
        opponentCharacter: 'Falco',
        wins: 1,
        losses: 0,
        topStages: [{ stage: 'Final Destination', wins: 1, losses: 0 }],
      },
    ]);
  });

  it('collapses two rows sharing a map.id but differing map.name into one, carrying the first-seen name (R1-HIGH-3)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 1,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'a',
      },
      m2: {
        fighter_id: 1,
        opponent_id: 8, // Fox
        time: 2,
        win: false,
        // Same numeric stage id, different stored name (legacy rename) — one
        // stage id is one stage, so this must collapse into a single row.
        map: { id: 1, name: 'Battlefield (renamed)' },
        opponent: 'b',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.vsTopCharacters[0]?.topStages).toEqual([
      { stage: 'Battlefield', wins: 1, losses: 1 },
    ]);
  });

  it('vsTopCharacters.topStages carries an explicit unknown-stage entry for games with an absent map (D-09, EVID-11)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: { fighter_id: 1, opponent_id: 8, time: 1, win: true, opponent: 'a' }, // no map -> unknown stage
      m2: { fighter_id: 1, opponent_id: 8, time: 2, win: false, opponent: 'b' }, // no map -> unknown stage
      m3: {
        fighter_id: 1,
        opponent_id: 8,
        time: 3,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    const fox = payload.userContext.vsTopCharacters.find(
      (entry) => entry.opponentCharacter === 'Fox',
    );
    expect(fox?.topStages).toContainEqual({ stage: 'Unknown stage', wins: 1, losses: 1 });
    expect(fox?.topStages).toContainEqual({ stage: 'Battlefield', wins: 1, losses: 0 });
  });

  it('carries a top-level evidencePolicy naming the D-05 abstention floor and policy version (D-11, D-14)', async () => {
    const database = new FakeDatabase();
    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.evidencePolicy.version).toBe(EVIDENCE_POLICY_VERSION);
    expect(payload.evidencePolicy.abstentionFloorGames).toBe(ABSTENTION_FLOOR_GAMES);
    expect(payload.evidencePolicy.recencyTreatment).toBe(RECENCY_TREATMENT);
    expect(typeof payload.evidencePolicy.refreshedAt).toBe('number');
  });

  it('each vsTopCharacters entry carries the engine claim metadata (sample + claimKind, D-11)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'a',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    const fox = payload.userContext.vsTopCharacters.find(
      (entry) => entry.opponentCharacter === 'Fox',
    );
    expect(fox?.claimKind).toBe('inference');
    expect(fox?.sample).toMatchObject({
      rawSampleSize: 1,
      eligibleDenominator: 1,
      knownFieldCoverage: 1,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      recencyTreatment: RECENCY_TREATMENT,
      dateRange: { firstMs: 1, lastMs: 1 },
      confidenceTier: null, // 1 countable game is below the D-05 floor of 3
    });
  });

  it('matchupAdvisor abstains below the D-05 floor: two countable games yields abstained:true and gamesNeeded:1, no ranked array', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: { fighter_id: 1, opponent_id: 8, time: 1, win: true, opponent: 'a' },
      m2: { fighter_id: 1, opponent_id: 8, time: 2, win: false, opponent: 'b' },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    const foxAdvisor = payload.userContext.matchupAdvisor.find(
      (entry) => entry.opponentCharacter === 'Fox',
    );
    expect(foxAdvisor).toMatchObject({ opponentCharacter: 'Fox', abstained: true, gamesNeeded: 1 });
    expect(foxAdvisor).not.toHaveProperty('ranked');
  });

  it('computes recent form over the most recent 50 matches only', async () => {
    const database = new FakeDatabase();
    const seed: Record<string, unknown> = {};
    // 3 wins then 2 losses, all older than a big losing streak that should
    // be excluded once more than 50 matches exist.
    for (let i = 0; i < 3; i += 1) {
      seed[`old-win-${i}`] = { fighter_id: 1, opponent_id: 2, time: i, win: true, opponent: 'x' };
    }
    for (let i = 0; i < 60; i += 1) {
      seed[`recent-${i}`] = {
        fighter_id: 1,
        opponent_id: 2,
        time: 1000 + i,
        win: i % 2 === 0,
        opponent: 'x',
      };
    }

    database.seed(`matches/${UID}`, seed);

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.userContext.recentForm.sampleSize).toBe(50);
    expect(payload.userContext.recentForm.wins + payload.userContext.recentForm.losses).toBe(50);
  });

  it('includes the saved opponent note for the scouted player, keyed by canonical name', async () => {
    const database = new FakeDatabase();
    database.seed(`opponentNotes/${UID}`, {
      pandem1c: { habits: 'likes to dash dance', updatedAt: 1_700_000_000_000 },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.notes).toEqual({
      habits: 'likes to dash dance',
      updatedAt: 1_700_000_000_000,
    });
  });
});

describe('selectOpponentMatches (binding-aware evidence filtering, RPT-01 grounding)', () => {
  const canonicalOpponentName = (name?: string) => (name ?? '').trim().toLowerCase();

  const STARTGG_BINDING: ScoutBinding = {
    provider: 'startgg',
    startggUserSlug: 'user/07dc2239',
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  };
  const PARRYGG_BINDING: ScoutBinding = {
    provider: 'parrygg',
    parryUserId: 'parry-uuid-1',
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1,
  };
  const COMBINED_BINDING: ScoutBinding = {
    provider: 'combined',
    startggUserSlug: 'user/07dc2239',
    parryUserId: 'parry-uuid-1',
    displayTag: 'Pandem1c',
    method: 'profileInput',
    confirmedAt: 1,
  };

  it('no binding: behaves exactly as today (start.gg slug shortcut, then tag fallback)', () => {
    const matches = [
      { opponent: 'someone else', opponentUserSlug: 'user/07dc2239' },
      { opponent: 'pandem1c' },
      { opponent: 'unrelated' },
    ];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      scoutedPlayerUserSlug: 'user/07dc2239',
    });
    expect(result).toEqual([matches[0], matches[1]]);
  });

  it('parry.gg binding: includes a match whose stored parry user id equals the binding’s, even with a mismatched tag', () => {
    const matches = [{ opponent: 'totally different tag', opponentParryUserId: 'parry-uuid-1' }];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      binding: PARRYGG_BINDING,
      curatedCanonicalName: 'pandem1c',
    });
    expect(result).toEqual(matches);
  });

  it('start.gg binding: includes a match whose stored slug equals the binding’s', () => {
    const matches = [{ opponent: 'x', opponentUserSlug: 'user/07dc2239' }];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      binding: STARTGG_BINDING,
      curatedCanonicalName: 'pandem1c',
    });
    expect(result).toEqual(matches);
  });

  it('combined binding: includes a match matching EITHER identity', () => {
    const matches = [
      { opponent: 'a', opponentUserSlug: 'user/07dc2239' },
      { opponent: 'b', opponentParryUserId: 'parry-uuid-1' },
    ];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      binding: COMBINED_BINDING,
      curatedCanonicalName: 'pandem1c',
    });
    expect(result).toEqual(matches);
  });

  it('excludes a match carrying a DIFFERENT provider identity even when its tag canonicalizes to the curated name', () => {
    const matches = [{ opponent: 'pandem1c', opponentUserSlug: 'user/some-other-player' }];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      binding: STARTGG_BINDING,
      curatedCanonicalName: 'pandem1c',
    });
    expect(result).toEqual([]);
  });

  it('includes an identity-less manual match whose alias-resolved name equals the curated canonical name', () => {
    const matches = [{ opponent: 'pandem1c' }];
    const result = selectOpponentMatches({
      matches,
      canonicalOpponentName,
      scoutedCanonicalName: 'pandem1c',
      binding: STARTGG_BINDING,
      curatedCanonicalName: 'pandem1c',
    });
    expect(result).toEqual(matches);
  });
});

describe('assembleReportPayload (binding-aware evidence, RPT-01)', () => {
  it('with no options, filters head-to-head identically to the pre-binding behavior (regression)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      m1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1_700_000_000_000,
        win: true,
        opponent: 'pandem1c',
      },
    });

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );

    expect(payload.headToHead).toHaveLength(1);
    expect(payload.headToHead[0]).toMatchObject({ result: 'win' });
  });

  it('with a parry.gg binding, grounds the head-to-head list in the confirmed identity instead of tag collisions', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      sameIdentity: {
        fighter_id: 1,
        opponent_id: 8,
        time: 2,
        win: true,
        opponent: 'not the tag at all',
        opponentParryUserId: 'parry-uuid-1',
      },
      differentIdentitySameTag: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1,
        win: false,
        opponent: 'pandem1c',
        opponentUserSlug: 'user/some-other-player',
      },
    });
    const binding: ScoutBinding = {
      provider: 'parrygg',
      parryUserId: 'parry-uuid-1',
      displayTag: 'Pandem1c',
      method: 'matchHistory',
      confirmedAt: 1,
    };

    const payload = await assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
      { binding, curatedCanonicalName: 'pandem1c' },
    );

    expect(payload.headToHead).toHaveLength(1);
    expect(payload.headToHead[0]).toMatchObject({ result: 'win' });
  });
});

/**
 * Phase 39 (plan 39-06): the model's output is a claim SELECTION over the
 * fixed claim-id vocabulary, not a free-prose report.
 */
const VALID_REPORT = {
  sections: {
    overview: { claimIds: ['c01'], connective: 'Start the set patient and steady.' },
    gameplan: { claimIds: ['c02'], connective: 'Punish landing habits and reset to neutral.' },
    watchFor: { claimIds: ['c03'], connective: 'Watch for the same ledge option under pressure.' },
  },
  action1: null,
  action2: null,
  action3: null,
};

function stubClient(response: {
  stop_reason: string | null;
  parsed_output: unknown;
}): AnthropicLikeClient {
  return {
    messages: {
      parse: async () => response as Awaited<ReturnType<AnthropicLikeClient['messages']['parse']>>,
    },
  };
}

const PAYLOAD: ReportPayload = {
  scout: SCOUT,
  headToHead: [],
  evidencePolicy: {
    version: EVIDENCE_POLICY_VERSION,
    abstentionFloorGames: ABSTENTION_FLOOR_GAMES,
    recencyTreatment: RECENCY_TREATMENT,
    refreshedAt: 0,
  },
  cohort: {
    online: 0,
    offline: 0,
    unspecified: 0,
    manual: 0,
    startgg: 0,
    parrygg: 0,
    mixedContext: false,
    minorityShare: 0,
    minorityLabel: null,
    majorityLabel: null,
  },
  userContext: {
    myFighters: { primary: [], secondary: [] },
    myCharacterRecords: [],
    vsTopCharacters: [],
    recentForm: { wins: 0, losses: 0, sampleSize: 0 },
    matchupAdvisor: [],
  },
  notes: null,
  rows: {},
  snapshot: {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt: 0,
    cohort: {
      online: 0,
      offline: 0,
      unspecified: 0,
      manual: 0,
      startgg: 0,
      parrygg: 0,
      mixedContext: false,
      minorityShare: 0,
      minorityLabel: null,
      majorityLabel: null,
    },
    rows: {},
    matchIdDigest: { count: 0, hash: 'fixture-empty-digest' },
  },
  claimSet: { claims: [], issuedClaimIds: [], truncatedCandidateCount: 0 },
  actionCandidates: [],
};

describe('generateScoutReport', () => {
  it('returns the parsed output on a normal completion', async () => {
    const client = stubClient({ stop_reason: 'end_turn', parsed_output: VALID_REPORT });
    const report = await generateScoutReport(client, PAYLOAD);
    expect(report).toEqual(VALID_REPORT);
  });

  it('throws ReportGenerationError("refusal") when stop_reason is refusal', async () => {
    const client = stubClient({ stop_reason: 'refusal', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('refusal'),
    );
  });

  it('throws ReportGenerationError("truncated") when stop_reason is max_tokens', async () => {
    const client = stubClient({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('truncated'),
    );
  });

  it('throws ReportGenerationError("unparseable") when parsed_output is null on a normal stop', async () => {
    const client = stubClient({ stop_reason: 'end_turn', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject(
      new ReportGenerationError('unparseable'),
    );
  });
});

describe('generateScoutReport: claim-selection schema and guard order (Phase 39, plan 39-06)', () => {
  it('passes the claim-selection schema to messages.parse — the enum over the fixed vocabulary, never the free-prose report schema', async () => {
    let captured: Parameters<AnthropicLikeClient['messages']['parse']>[0] | undefined;
    const client: AnthropicLikeClient = {
      messages: {
        parse: async (params) => {
          captured = params;
          return { stop_reason: 'end_turn', parsed_output: VALID_REPORT } as Awaited<
            ReturnType<AnthropicLikeClient['messages']['parse']>
          >;
        },
      },
    };
    await generateScoutReport(client, PAYLOAD);

    const expected = zodOutputFormat(claimSelectionSchema);
    expect(JSON.stringify(captured!.output_config.format.schema)).toBe(
      JSON.stringify(expected.schema),
    );
    // Call SHAPE is byte-preserved: same model, token budget and adaptive thinking.
    expect(captured).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
    });
    for (const forbidden of ['temperature', 'top_p', 'citations']) {
      expect(captured).not.toHaveProperty(forbidden);
    }
  });

  it('checks refusal FIRST: a refusal whose parsed_output is also null throws the refusal reason, not unparseable', async () => {
    const client = stubClient({ stop_reason: 'refusal', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject({
      name: 'ReportGenerationError',
      reason: 'refusal',
    });
  });

  it('checks truncation before the null-output guard: max_tokens with a null parse throws truncated', async () => {
    const client = stubClient({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(generateScoutReport(client, PAYLOAD)).rejects.toMatchObject({
      reason: 'truncated',
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-06 Task 3): the payload emits rows, snapshot, claim set
// and ranked actions; the MODEL sees only claims and action candidates.
// ---------------------------------------------------------------------------

describe('assembleReportPayload: evidence rows, snapshot, claim set and ranked actions (plan 39-06 Task 3)', () => {
  /** A scouted opponent with three known characters and one unmapped (fighterId 0) bucket. */
  const THREE_CHARACTER_SCOUT: ScoutReportData = {
    player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
    sampledSets: 12,
    sampledGames: 26,
    characters: [
      { fighterId: 8, games: 12, wins: 8 }, // Fox
      { fighterId: 9, games: 8, wins: 4 }, // Pikachu
      { fighterId: 23, games: 4, wins: 2 }, // Marth
      { fighterId: 0, games: 2, wins: 1 }, // unmapped bucket — never a claim subject
    ],
    stages: [],
    recentEvents: [],
    commonOpponents: [],
  };

  async function assembleViable() {
    const database = new FakeDatabase();
    seedViableEvidence(database, UID, { opponentTag: 'Pandem1c' });
    return assembleReportPayload(
      UID,
      THREE_CHARACTER_SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );
  }

  it('every emitted claim id is a member of CLAIM_ID_VOCABULARY and every action candidate cites at least one issued claim id', async () => {
    const payload = await assembleViable();
    expect(payload.claimSet.claims.length).toBeGreaterThan(0);
    for (const claim of payload.claimSet.claims) {
      expect(CLAIM_ID_VOCABULARY).toContain(claim.id);
    }
    expect(payload.claimSet.claims).toEqual(
      buildClaimSet({ rows: payload.rows, surface: 'scout' }).claims,
    );
    const issued = new Set(payload.claimSet.issuedClaimIds);
    expect(payload.actionCandidates.length).toBeGreaterThan(0);
    for (const candidate of payload.actionCandidates) {
      expect(candidate.claimIds.length).toBeGreaterThan(0);
      for (const claimId of candidate.claimIds) {
        expect(issued.has(claimId)).toBe(true);
      }
    }
  });

  it('C2-B2: a stage_record AND a stage_pick_rate row exist for the same stage under two distinct keys', async () => {
    const payload = await assembleViable();
    const recordRow = payload.rows['sr-g8-s1'];
    const rateRow = payload.rows['spr-g8-s1'];
    expect(recordRow?.predicate).toBe('stage_record');
    expect(rateRow?.predicate).toBe('stage_pick_rate');
    expect(recordRow?.subject).toEqual(rateRow?.subject);
  });

  it('C3-B1: an EMPTY own history with a populated scouted opponent yields one opponent_character_usage row per known scout.characters entry, issuing at least MIN_VIABLE_CLAIMS.scout claims', async () => {
    const database = new FakeDatabase();
    const payload = await assembleReportPayload(
      UID,
      THREE_CHARACTER_SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );
    const usageRows = Object.values(payload.rows).filter(
      (row) => row.predicate === 'opponent_character_usage',
    );
    const knownCharacters = THREE_CHARACTER_SCOUT.characters.filter((c) => c.fighterId !== 0);
    expect(usageRows.map((row) => row.subject.opponentFighterId)).toEqual(
      knownCharacters.map((c) => c.fighterId),
    );
    // The rate's denominator IS the sample's countable games (validator rule R7).
    for (const row of usageRows) {
      expect(row.value.kind === 'rate' && row.value.denominator).toBe(
        row.sample.eligibleDenominator,
      );
    }
    expect(payload.claimSet.claims.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.scout);
  });

  it('the snapshot id is identical across two assemblies of the same input, even at different wall-clock times', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const first = await assembleViable();
    nowSpy.mockReturnValue(1_800_086_400_000);
    const second = await assembleViable();
    nowSpy.mockRestore();
    expect(first.snapshot.refreshedAt).not.toBe(second.snapshot.refreshedAt);
    expect(snapshotIdFor(first.snapshot)).toBe(snapshotIdFor(second.snapshot));
  });

  it('VOD refs come from the existing selectOpponentMatches result: a LOST head-to-head match with a VOD timestamp licenses a vod_review candidate naming that match', async () => {
    const database = new FakeDatabase();
    seedViableEvidence(database, UID, { opponentTag: 'Pandem1c' });
    // One extra lost game against the scouted tag, with a VOD moment.
    database.seed(`matches/${UID}/vod-lost-1`, {
      fighter_id: 1,
      opponent_id: 23,
      time: 1_700_100_000_000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'pandem1c',
      matchType: 'offline-tourney',
      win: false,
      vodUrl: 'https://www.youtube.com/watch?v=fixture',
      vodTimestamps: [{ seconds: 42, note: 'missed punish' }],
    });
    const payload = await assembleReportPayload(
      UID,
      THREE_CHARACTER_SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );
    const vodCandidates = payload.actionCandidates.filter((c) => c.kind === 'vod_review');
    expect(vodCandidates.length).toBeGreaterThan(0);
    expect(vodCandidates.some((c) => c.target.matchId === 'vod-lost-1')).toBe(true);
  });
});

describe('the model-facing payload (plan 39-06 Task 3)', () => {
  async function assembleViable() {
    const database = new FakeDatabase();
    seedViableEvidence(database, UID, { opponentTag: 'Pandem1c' });
    return assembleReportPayload(
      UID,
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
    );
  }

  it('C2-M6: every claim carries a displayName for each non-null resolvable axis, equal to resolveSubjectDisplayName', async () => {
    const model = buildModelPayload(await assembleViable());
    expect(model.claims.length).toBeGreaterThan(0);
    for (const claim of model.claims) {
      const expected: Record<string, string> = {};
      if (claim.subject.myFighterId !== null) {
        expected.myFighter = resolveSubjectDisplayName('fighter', claim.subject.myFighterId);
      }
      if (claim.subject.opponentFighterId !== null) {
        expected.opponentFighter = resolveSubjectDisplayName(
          'fighter',
          claim.subject.opponentFighterId,
        );
      }
      if (claim.subject.stageId !== null) {
        expected.stage = resolveSubjectDisplayName('stage', claim.subject.stageId);
      }
      expect(claim.displayName).toEqual(expected);
    }
    // The advisor's pick is on the subject, so its name is resolvable (and licensed).
    const picks = model.claims.filter(
      (claim) => claim.predicate === 'matchup_advisor_pick' && claim.value.kind === 'entity',
    );
    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
      const entityId = pick.value.kind === 'entity' ? Number(pick.value.entityId) : NaN;
      expect(pick.subject.myFighterId).toBe(entityId);
      expect(pick.displayName.myFighter).toBe(resolveSubjectDisplayName('fighter', entityId));
    }
  });

  it('the user message carries ONLY the claims and ranked action candidates — the named raw payload is not serialized', async () => {
    let captured: Parameters<AnthropicLikeClient['messages']['parse']>[0] | undefined;
    const client: AnthropicLikeClient = {
      messages: {
        parse: async (params) => {
          captured = params;
          return { stop_reason: 'end_turn', parsed_output: VALID_REPORT } as Awaited<
            ReturnType<AnthropicLikeClient['messages']['parse']>
          >;
        },
      },
    };
    const payload = await assembleViable();
    await generateScoutReport(client, payload);
    const message = JSON.parse(captured!.messages[0]!.content) as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(['actionCandidates', 'claims']);
    expect(message).toEqual(JSON.parse(JSON.stringify(buildModelPayload(payload))));
  });

  it('the assembled system prompt carries no instruction to state or hedge a confidence level, and no per-job value', async () => {
    let captured: Parameters<AnthropicLikeClient['messages']['parse']>[0] | undefined;
    const client: AnthropicLikeClient = {
      messages: {
        parse: async (params) => {
          captured = params;
          return { stop_reason: 'end_turn', parsed_output: VALID_REPORT } as Awaited<
            ReturnType<AnthropicLikeClient['messages']['parse']>
          >;
        },
      },
    };
    await generateScoutReport(client, await assembleViable());
    const system = captured!.system;
    expect(system.length).toBeGreaterThan(0);
    expect(system).not.toMatch(/confidence|hedg/i);
    expect(system).not.toMatch(/\d/);
    expect(system).not.toContain('Pandem1c');
  });

  it('C2-M10: orderSnapshotOpponents is called exactly once in generate.ts (source read) — no second ordering derived locally', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/reports/generate.ts'), 'utf-8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(source.match(/orderSnapshotOpponents\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/localeCompare/);
  });
});
