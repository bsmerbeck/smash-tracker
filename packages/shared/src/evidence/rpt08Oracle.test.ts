import { describe, expect, it } from 'vitest';
import {
  ACTION_ID_VOCABULARY,
  ACTION_ID_VOCABULARY_SIZE,
  CLAIM_ID_VOCABULARY,
  CLAIM_ID_VOCABULARY_SIZE,
  CLAIM_PREDICATES,
  EVIDENCE_ID_PATTERN,
  type ClaimSubject,
} from './claims.js';
import {
  EVIDENCE_ID_PREFIX,
  UnsupportedEvidenceSubjectError,
  evidenceIdFor,
  orderSnapshotOpponents,
  parseVodEvidenceId,
  vodEvidenceId,
} from './snapshot.js';
import { legacyCitationOnlyVerdict } from './legacyCitationRule.js';
import { ADVERSARIAL_FIXTURES } from './adversarialFixtures.js';

/**
 * RPT-08 / D-09 (phase 39 plan 01, wave 1): this suite's green-ness IS the
 * proof that today's shipped citation rule is insufficient — a claim citing
 * a REAL evidence id but stating a wrong number is ACCEPTED by the frozen
 * `legacyCitationOnlyVerdict`. It also carries the contract tests for the
 * `claims.ts`/`snapshot.ts` shapes every later plan compiles against, until
 * Task 3 relocates the contract-only assertions into `claimContracts.test.ts`.
 */

function findFixture(id: string) {
  const fixture = ADVERSARIAL_FIXTURES.find((entry) => entry.id === id);
  if (!fixture) {
    throw new Error(`adversarial fixture not found: ${id}`);
  }
  return fixture;
}

describe('RPT-08 fail-first proof: the frozen legacy citation rule accepts a wrong number behind a real citation', () => {
  it('legacyCitationOnlyVerdict ACCEPTS wrong-number-with-real-id (rule R2) — the committed demonstration that the rule shipping today does not catch a wrong number', () => {
    const fixture = findFixture('wrong-number-with-real-id');
    const verdict = legacyCitationOnlyVerdict({
      snapshot: fixture.snapshot,
      output: fixture.output,
    });
    expect(verdict.accepted).toBe(true);
    expect(verdict.rejectedClaimIds).toEqual([]);
  });

  it('control: legacyCitationOnlyVerdict REJECTS missing-evidence-id (rule R1) — so the accept above is not vacuous (a rule that accepted everything would also "accept" the wrong number)', () => {
    const fixture = findFixture('missing-evidence-id');
    const verdict = legacyCitationOnlyVerdict({
      snapshot: fixture.snapshot,
      output: fixture.output,
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejectedClaimIds.length).toBeGreaterThan(0);
  });
});

describe('vodEvidenceId / parseVodEvidenceId round-trip (C1-M8)', () => {
  const cases: Array<{ matchId: string; seconds: number }> = [
    { matchId: '-KzAbC-defGH-push-key', seconds: 0 },
    { matchId: 'match-with-several-dashes', seconds: 4821 },
    { matchId: 'plainMatchId', seconds: 12 },
  ];

  it.each(cases)('round-trips matchId=$matchId seconds=$seconds', ({ matchId, seconds }) => {
    const id = vodEvidenceId(matchId, seconds);
    expect(EVIDENCE_ID_PATTERN.test(id)).toBe(true);
    expect(parseVodEvidenceId(id)).toEqual({ matchId, seconds });
  });

  it('every produced id starts with the vod_annotation prefix', () => {
    for (const { matchId, seconds } of cases) {
      expect(
        vodEvidenceId(matchId, seconds).startsWith(`${EVIDENCE_ID_PREFIX.vod_annotation}-`),
      ).toBe(true);
    }
  });

  it('parseVodEvidenceId returns null for a non-vod id and for a malformed seconds segment', () => {
    expect(parseVodEvidenceId('sr-f23-s1')).toBeNull();
    expect(parseVodEvidenceId('vod-abc-not-a-number')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract tests (Task 1's acceptance criteria). These will be relocated to
// claimContracts.test.ts in Task 3, once that file exists — until then this
// is the only test file Task 1 has to carry them in.
// ---------------------------------------------------------------------------

describe('CLAIM_ID_VOCABULARY contract', () => {
  it('has CLAIM_ID_VOCABULARY_SIZE members, each matching /^c\\d{2}$/, unique, ascending', () => {
    expect(CLAIM_ID_VOCABULARY.length).toBe(CLAIM_ID_VOCABULARY_SIZE);
    for (const id of CLAIM_ID_VOCABULARY) {
      expect(id).toMatch(/^c\d{2}$/);
    }
    expect(new Set(CLAIM_ID_VOCABULARY).size).toBe(CLAIM_ID_VOCABULARY.length);
    expect([...CLAIM_ID_VOCABULARY]).toEqual([...CLAIM_ID_VOCABULARY].sort());
  });
});

describe('ACTION_ID_VOCABULARY contract', () => {
  it('has ACTION_ID_VOCABULARY_SIZE members, each matching /^a\\d{2}$/, unique, ascending', () => {
    expect(ACTION_ID_VOCABULARY.length).toBe(ACTION_ID_VOCABULARY_SIZE);
    for (const id of ACTION_ID_VOCABULARY) {
      expect(id).toMatch(/^a\d{2}$/);
    }
    expect(new Set(ACTION_ID_VOCABULARY).size).toBe(ACTION_ID_VOCABULARY.length);
  });
});

describe('CLAIM_PREDICATES contract', () => {
  it('has exactly the ten named members', () => {
    expect(CLAIM_PREDICATES).toEqual([
      'stage_record',
      'stage_pick_rate',
      'character_matchup_record',
      'my_character_record',
      'head_to_head_record',
      'recent_form',
      'opponent_character_usage',
      'matchup_advisor_pick',
      'vod_annotation',
      'cohort_disclosure',
    ]);
  });
});

describe('EVIDENCE_ID_PREFIX contract (review C2-B2)', () => {
  it('has a key for every member of CLAIM_PREDICATES, values are pairwise distinct and contain no dash', () => {
    for (const predicate of CLAIM_PREDICATES) {
      const prefix = EVIDENCE_ID_PREFIX[predicate];
      expect(prefix).toBeDefined();
      expect(prefix).not.toContain('-');
      expect(prefix).toMatch(/^[a-z0-9]{2,4}$/);
    }
    const prefixes = CLAIM_PREDICATES.map((predicate) => EVIDENCE_ID_PREFIX[predicate]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

const AXIS_VALUES = {
  myFighterId: 23,
  opponentFighterId: 59,
  stageId: 1,
  opponentTag: 'ShadowOfTheOpponent',
} as const;

function buildSubjectBattery(): ClaimSubject[] {
  const keys = ['myFighterId', 'opponentFighterId', 'stageId', 'opponentTag'] as const;
  const subjects: ClaimSubject[] = [{ ...NULL_SUBJECT }];
  for (const key of keys) {
    subjects.push({ ...NULL_SUBJECT, [key]: AXIS_VALUES[key] });
  }
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      subjects.push({
        ...NULL_SUBJECT,
        [keys[i]!]: AXIS_VALUES[keys[i]!],
        [keys[j]!]: AXIS_VALUES[keys[j]!],
      });
    }
  }
  subjects.push({ ...AXIS_VALUES });
  return subjects;
}

describe('evidenceIdFor injectivity across (predicate, subject) (review C2-B2)', () => {
  it('every (predicate, subject) pair across all ten predicates and a full axis battery produces a distinct id', () => {
    const opponentOrder = orderSnapshotOpponents([AXIS_VALUES.opponentTag]);
    const subjects = buildSubjectBattery();
    const nonVodPredicates = CLAIM_PREDICATES.filter((predicate) => predicate !== 'vod_annotation');

    const ids: string[] = [];
    for (const predicate of nonVodPredicates) {
      for (const subject of subjects) {
        ids.push(evidenceIdFor({ predicate, subject, opponentOrder }));
      }
    }
    // vod_annotation supplied through vodEvidenceId, one distinct (matchId, seconds) per battery slot.
    subjects.forEach((_, index) => {
      ids.push(vodEvidenceId(`injectivity-battery-match-${index}`, index));
    });

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('evidenceIdFor throws UnsupportedEvidenceSubjectError for vod_annotation', () => {
    expect(() =>
      evidenceIdFor({ predicate: 'vod_annotation', subject: NULL_SUBJECT, opponentOrder: [] }),
    ).toThrow(UnsupportedEvidenceSubjectError);
  });

  it('evidenceIdFor throws UnsupportedEvidenceSubjectError for an opponentTag absent from opponentOrder', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, opponentTag: 'NotInTheOrder' };
    expect(() =>
      evidenceIdFor({ predicate: 'recent_form', subject, opponentOrder: ['SomeoneElse'] }),
    ).toThrow(UnsupportedEvidenceSubjectError);
  });

  it('every id evidenceIdFor/vodEvidenceId produces satisfies EVIDENCE_ID_PATTERN', () => {
    const opponentOrder = orderSnapshotOpponents([AXIS_VALUES.opponentTag]);
    for (const predicate of CLAIM_PREDICATES.filter((p) => p !== 'vod_annotation')) {
      for (const subject of buildSubjectBattery()) {
        expect(EVIDENCE_ID_PATTERN.test(evidenceIdFor({ predicate, subject, opponentOrder }))).toBe(
          true,
        );
      }
    }
    expect(EVIDENCE_ID_PATTERN.test(vodEvidenceId('m-1', 5))).toBe(true);
  });
});

describe('orderSnapshotOpponents contract (review C2-M10)', () => {
  it('de-duplicates and is idempotent', () => {
    const tags = ['b', 'a', 'b', 'a', 'c'];
    const once = orderSnapshotOpponents(tags);
    expect(once).toEqual(['a', 'b', 'c']);
    expect(orderSnapshotOpponents(once)).toEqual(once);
  });

  it('orders by raw UTF-16 code-unit comparison, not localeCompare — a case where the two orders genuinely differ', () => {
    const tags = ['apple', 'Zebra'];
    const codeUnitOrder = [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const localeOrder = [...tags].sort((a, b) => a.localeCompare(b));
    // Sanity check: this input must actually exercise the divergence this
    // test exists to prove, or the assertion below would pass vacuously.
    expect(codeUnitOrder).not.toEqual(localeOrder);
    expect(orderSnapshotOpponents(tags)).toEqual(codeUnitOrder);
  });
});
