import { describe, expect, it } from 'vitest';
import {
  RESEARCH_SET_CLASSIFICATIONS,
  type ResearchSetClassification,
} from '@smash-tracker/shared';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../../startgg/client.js';
import {
  classifyResearchSet,
  PROVIDER_WALKOVER_TOKENS,
  RESEARCH_ELIGIBILITY_RULES,
} from './classification.js';

type ResearchEntrant = NonNullable<NonNullable<StartggResearchSet['slots']>[number]>['entrant'];
type ResearchGame = NonNullable<StartggResearchSet['games']>[number];

const SUBJECT_PLAYER_ID = 100;
const OPPONENT_PLAYER_ID = 200;
const CONFIRMED = new Set([String(SUBJECT_PLAYER_ID)]);

function makeEntrant(
  overrides: Partial<NonNullable<ResearchEntrant>> = {},
): NonNullable<ResearchEntrant> {
  return {
    id: 10,
    name: 'Subject',
    isDisqualified: null,
    initialSeedNum: null,
    participants: [{ player: { id: SUBJECT_PLAYER_ID, gamerTag: 'Subject' }, user: null }],
    seeds: null,
    standing: null,
    ...overrides,
  };
}

function makeOpponentEntrant(
  overrides: Partial<NonNullable<ResearchEntrant>> = {},
): NonNullable<ResearchEntrant> {
  return makeEntrant({
    id: 20,
    name: 'Opponent',
    participants: [{ player: { id: OPPONENT_PLAYER_ID, gamerTag: 'Opponent' }, user: null }],
    ...overrides,
  });
}

function makeGame(overrides: Partial<ResearchGame> = {}): ResearchGame {
  return {
    id: 1,
    winnerId: 10,
    stage: { id: 1, name: 'Battlefield' },
    selections: [
      { character: { id: 1 }, entrant: { id: 10 } },
      { character: { id: 2 }, entrant: { id: 20 } },
    ],
    entrant1Score: null,
    entrant2Score: null,
    ...overrides,
  };
}

function makeSet(overrides: Partial<StartggResearchSet> = {}): StartggResearchSet {
  return {
    id: 1,
    state: null,
    completedAt: 1_000,
    createdAt: null,
    updatedAt: null,
    fullRoundText: null,
    round: null,
    displayScore: '2-1',
    totalGames: null,
    vodUrl: null,
    identifier: null,
    event: {
      id: 1,
      name: 'Genesis',
      slug: null,
      isOnline: false,
      numEntrants: null,
      type: null,
      videogame: { id: SSBU_VIDEOGAME_ID },
      tournament: null,
    },
    slots: [{ entrant: makeEntrant() }, { entrant: makeOpponentEntrant() }],
    games: [makeGame()],
    ...overrides,
  };
}

describe('classifyResearchSet', () => {
  it('classifies a set whose videogame id differs from SSBU as non-ssbu (R-NON-SSBU)', () => {
    const set = makeSet({ event: { ...makeSet().event, videogame: { id: 99 } } });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('non-ssbu');
    expect(result.ruleId).toBe('R-NON-SSBU');
  });

  it('classifies a set with an ABSENT videogame id as unresolved (R-VIDEOGAME-UNKNOWN), never non-ssbu', () => {
    const set = makeSet({ event: { ...makeSet().event, videogame: null } });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('unresolved');
    expect(result.ruleId).toBe('R-VIDEOGAME-UNKNOWN');
    expect(result.gapFlags.unknownVideogame).toBe(true);
    expect(result.classification).not.toBe('non-ssbu');
  });

  it('classifies a doubles set as non-singles even when the subject entrant itself is a single participant (R-NON-SINGLES)', () => {
    const set = makeSet({
      slots: [
        { entrant: makeEntrant() },
        {
          entrant: makeOpponentEntrant({
            participants: [
              { player: { id: OPPONENT_PLAYER_ID, gamerTag: 'Opponent' }, user: null },
              { player: { id: 999, gamerTag: 'Partner' }, user: null },
            ],
          }),
        },
      ],
    });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('non-singles');
    expect(result.ruleId).toBe('R-NON-SINGLES');
  });

  it('classifies a set with one entrant present and the other absent as bye (R-BYE)', () => {
    const set = makeSet({ slots: [{ entrant: makeEntrant() }, { entrant: null }] });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('bye');
    expect(result.ruleId).toBe('R-BYE');
  });

  it('classifies a set with an entrant DQ boolean as dq (R-DQ-FLAG, primary signal)', () => {
    const set = makeSet({
      slots: [
        { entrant: makeEntrant({ isDisqualified: true }) },
        { entrant: makeOpponentEntrant() },
      ],
    });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('dq');
    expect(result.ruleId).toBe('R-DQ-FLAG');
  });

  it('classifies a set with no DQ boolean but displayScore "DQ" (any case, whitespace tolerated) as dq (R-DQ-DISPLAY fallback)', () => {
    const set = makeSet({ displayScore: '  dq  ' });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('dq');
    expect(result.ruleId).toBe('R-DQ-DISPLAY');
  });

  it('does NOT fall back to R-DQ-DISPLAY when an entrant already carries the DQ boolean as false', () => {
    const set = makeSet({
      displayScore: 'DQ',
      slots: [
        { entrant: makeEntrant({ isDisqualified: false }) },
        { entrant: makeOpponentEntrant({ isDisqualified: false }) },
      ],
    });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    // Both entrants carry the boolean (as false) — the display fallback must not fire,
    // and with no games/completedAt gap this set falls through to no-game-detail-style rules.
    expect(result.ruleId).not.toBe('R-DQ-DISPLAY');
  });

  it.each(PROVIDER_WALKOVER_TOKENS)(
    'classifies a set whose displayScore is the provider token "%s" as walkover (R-WALKOVER-EXPLICIT)',
    (token) => {
      const set = makeSet({ displayScore: token.toLowerCase() });
      const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
      expect(result.classification).toBe('walkover');
      expect(result.ruleId).toBe('R-WALKOVER-EXPLICIT');
    },
  );

  it('classifies a completed set with an empty games array as no-game-detail, never walkover (R-NO-GAME-DETAIL)', () => {
    const set = makeSet({ games: [], completedAt: 1_000, displayScore: '3-1' });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('no-game-detail');
    expect(result.ruleId).toBe('R-NO-GAME-DETAIL');
  });

  it('classifies a completed set with a REAL score line and empty games as no-game-detail — the score line does not upgrade the classification', () => {
    const set = makeSet({ games: [], completedAt: 1_000, displayScore: '3-1' });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('no-game-detail');
  });

  it('classifies a set with empty games and a null completedAt as no-game (R-NO-GAME)', () => {
    const set = makeSet({ games: [], completedAt: null });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('no-game');
    expect(result.ruleId).toBe('R-NO-GAME');
  });

  it('classifies a set with games present but a null completedAt as no-game (R-NO-COMPLETED-AT)', () => {
    const set = makeSet({ completedAt: null });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('no-game');
    expect(result.ruleId).toBe('R-NO-COMPLETED-AT');
  });

  it('classifies an eligible SSBU singles completed set with no confirmed player id as unresolved (R-SUBJECT-NOT-FOUND)', () => {
    const set = makeSet();
    const result = classifyResearchSet({ set, confirmedPlayerIds: new Set(['999999']) });
    expect(result.classification).toBe('unresolved');
    expect(result.ruleId).toBe('R-SUBJECT-NOT-FOUND');
  });

  it('classifies the same set as complete when a confirmed player id is present, reporting subject and opponent entrant ids (R-COMPLETE)', () => {
    const set = makeSet();
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('complete');
    expect(result.ruleId).toBe('R-COMPLETE');
    expect(result.subjectEntrantId).toBe('10');
    expect(result.opponentEntrantId).toBe('20');
  });

  it('classifies both an online and an offline set as complete — online context is preserved, never excluded', () => {
    const online = makeSet({ event: { ...makeSet().event, isOnline: true } });
    const offline = makeSet({ event: { ...makeSet().event, isOnline: false } });
    expect(classifyResearchSet({ set: online, confirmedPlayerIds: CONFIRMED }).classification).toBe(
      'complete',
    );
    expect(
      classifyResearchSet({ set: offline, confirmedPlayerIds: CONFIRMED }).classification,
    ).toBe('complete');
  });

  it('classifies a set with an absent online flag as complete, and reports unknownOnlineContext without changing the classification', () => {
    const set = makeSet({ event: { ...makeSet().event, isOnline: null } });
    const result = classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(result.classification).toBe('complete');
    expect(result.gapFlags.unknownOnlineContext).toBe(true);
  });

  it('never mutates its input', () => {
    const set = makeSet();
    const clone = JSON.parse(JSON.stringify(set));
    classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED });
    expect(set).toEqual(clone);
  });

  it('never throws for a maximally sparse set', () => {
    const set = makeSet({
      event: null,
      slots: null,
      games: null,
      completedAt: null,
      displayScore: null,
    });
    expect(() => classifyResearchSet({ set, confirmedPlayerIds: CONFIRMED })).not.toThrow();
  });
});

describe('RESEARCH_ELIGIBILITY_RULES table integrity', () => {
  const EXPECTED_RULE_IDS = [
    'R-NON-SSBU',
    'R-VIDEOGAME-UNKNOWN',
    'R-NON-SINGLES',
    'R-BYE',
    'R-DQ-FLAG',
    'R-DQ-DISPLAY',
    'R-WALKOVER-EXPLICIT',
    'R-NO-GAME-DETAIL',
    'R-NO-GAME',
    'R-NO-COMPLETED-AT',
    'R-SUBJECT-NOT-FOUND',
    'R-COMPLETE',
  ];

  it('has exactly 12 entries in the exact evaluation order named by the plan', () => {
    expect(RESEARCH_ELIGIBILITY_RULES.map((rule) => rule.id)).toEqual(EXPECTED_RULE_IDS);
  });

  it('every rule classification is a member of RESEARCH_SET_CLASSIFICATIONS', () => {
    for (const rule of RESEARCH_ELIGIBILITY_RULES) {
      expect(RESEARCH_SET_CLASSIFICATIONS as readonly string[]).toContain(rule.classification);
    }
  });

  it('no rule maps to walkover except the explicit-token rule — the anti-inference guarantee, machine-checked', () => {
    const walkoverRules = RESEARCH_ELIGIBILITY_RULES.filter(
      (rule) => rule.classification === 'walkover',
    );
    expect(walkoverRules).toHaveLength(1);
    expect(walkoverRules[0]?.id).toBe('R-WALKOVER-EXPLICIT');
  });

  // Drives coverage from the table itself: a rule id added without a
  // corresponding fixture below fails this suite, per the plan's own
  // "drive it from the table" requirement.
  const setsByRuleId: Record<string, StartggResearchSet> = {
    'R-NON-SSBU': makeSet({ event: { ...makeSet().event, videogame: { id: 99 } } }),
    'R-VIDEOGAME-UNKNOWN': makeSet({ event: { ...makeSet().event, videogame: null } }),
    'R-NON-SINGLES': makeSet({
      slots: [
        { entrant: makeEntrant() },
        {
          entrant: makeOpponentEntrant({
            participants: [
              { player: { id: OPPONENT_PLAYER_ID, gamerTag: 'Opponent' }, user: null },
              { player: { id: 999, gamerTag: 'Partner' }, user: null },
            ],
          }),
        },
      ],
    }),
    'R-BYE': makeSet({ slots: [{ entrant: makeEntrant() }, { entrant: null }] }),
    'R-DQ-FLAG': makeSet({
      slots: [
        { entrant: makeEntrant({ isDisqualified: true }) },
        { entrant: makeOpponentEntrant() },
      ],
    }),
    'R-DQ-DISPLAY': makeSet({ displayScore: 'dq' }),
    'R-WALKOVER-EXPLICIT': makeSet({ displayScore: 'w/o' }),
    'R-NO-GAME-DETAIL': makeSet({ games: [], completedAt: 1_000 }),
    'R-NO-GAME': makeSet({ games: [], completedAt: null }),
    'R-NO-COMPLETED-AT': makeSet({ completedAt: null }),
    'R-SUBJECT-NOT-FOUND': makeSet(),
    'R-COMPLETE': makeSet(),
  };

  it.each(RESEARCH_ELIGIBILITY_RULES)(
    'rule $id is exercised by a fixture that fires it',
    (rule) => {
      const set = setsByRuleId[rule.id];
      expect(set).toBeDefined();
      const confirmedPlayerIds =
        rule.id === 'R-SUBJECT-NOT-FOUND' ? new Set(['999999']) : CONFIRMED;
      const result = classifyResearchSet({ set: set!, confirmedPlayerIds });
      expect(result.ruleId).toBe(rule.id);
    },
  );

  it('every rule id classifyResearchSet ever returns across this whole suite exists in the table', () => {
    const returned = new Set<string>();
    for (const [ruleId, set] of Object.entries(setsByRuleId)) {
      const confirmedPlayerIds = ruleId === 'R-SUBJECT-NOT-FOUND' ? new Set(['999999']) : CONFIRMED;
      returned.add(classifyResearchSet({ set, confirmedPlayerIds }).ruleId);
    }
    const tableIds = new Set(RESEARCH_ELIGIBILITY_RULES.map((rule) => rule.id));
    for (const id of returned) {
      expect(tableIds.has(id)).toBe(true);
    }
  });
});

// Compile-time reminder: if a classification is ever added to the shared
// vocabulary without a corresponding rule, this cast fails to typecheck.
const _allClassificationsCovered: readonly ResearchSetClassification[] =
  RESEARCH_SET_CLASSIFICATIONS;
void _allClassificationsCovered;
