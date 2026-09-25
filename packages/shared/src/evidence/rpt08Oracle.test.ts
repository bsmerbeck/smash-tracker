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
import { ADVERSARIAL_FAMILIES, ADVERSARIAL_FIXTURES } from './adversarialFixtures.js';
import { CONFIDENCE_TIER_BOUNDS, confidenceTierFor } from './policy.js';
import { emptyWorkspace, oneGameWorkspace, twoGameWorkspace } from '../testUtils/index.js';

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

// ---------------------------------------------------------------------------
// Task 2: the full adversarial corpus's coverage/integrity gates.
// ---------------------------------------------------------------------------

describe('adversarial fixture corpus coverage (Task 2)', () => {
  it('every declared family has at least one fixture (anti-vacuous — a family added to the type but never populated fails)', () => {
    const populatedFamilies = new Set(ADVERSARIAL_FIXTURES.map((fixture) => fixture.family));
    for (const family of ADVERSARIAL_FAMILIES) {
      expect(populatedFamilies.has(family)).toBe(true);
    }
  });

  it('every fixture carries at least one rubric rule id', () => {
    for (const fixture of ADVERSARIAL_FIXTURES) {
      expect(fixture.rubricRuleIds.length).toBeGreaterThan(0);
    }
  });

  it("C2-B2: every row key is reproduced by rebuilding it from that row's own predicate and subject, and row count equals distinct (predicate, subject) pairs (per fixture)", () => {
    for (const fixture of ADVERSARIAL_FIXTURES) {
      const rows = fixture.snapshot.rows;
      const opponentTags = Object.values(rows)
        .map((row) => row.subject.opponentTag)
        .filter((tag): tag is string => tag !== null);
      const opponentOrder = orderSnapshotOpponents(opponentTags);
      const distinctPairKeys = new Set<string>();

      for (const [storedKey, row] of Object.entries(rows)) {
        const rebuiltKey = evidenceIdFor({
          predicate: row.predicate,
          subject: row.subject,
          opponentOrder,
        });
        expect(rebuiltKey).toBe(storedKey);
        distinctPairKeys.add(`${row.predicate}::${JSON.stringify(row.subject)}`);
      }

      expect(distinctPairKeys.size).toBe(Object.keys(rows).length);
    }
  });

  it('cold-start fixtures derive their digest count from the EXISTING sparse-workspace builders, not a re-declared literal', () => {
    expect(findFixture('cold-start-empty-snapshot').snapshot.matchIdDigest.count).toBe(
      emptyWorkspace().length,
    );
    expect(findFixture('cold-start-one-game').snapshot.matchIdDigest.count).toBe(
      oneGameWorkspace().length,
    );
    expect(findFixture('cold-start-two-game').snapshot.matchIdDigest.count).toBe(
      twoGameWorkspace().length,
    );
  });

  it('tier-boundary fixtures carry tiers computed by confidenceTierFor and map to abstain/low/low/medium/medium/high', () => {
    const boundaryGames = [
      CONFIDENCE_TIER_BOUNDS.low - 1,
      CONFIDENCE_TIER_BOUNDS.low,
      CONFIDENCE_TIER_BOUNDS.medium - 1,
      CONFIDENCE_TIER_BOUNDS.medium,
      CONFIDENCE_TIER_BOUNDS.high - 1,
      CONFIDENCE_TIER_BOUNDS.high,
    ];
    const expectedTiers = [null, 'low', 'low', 'medium', 'medium', 'high'] as const;

    boundaryGames.forEach((games, index) => {
      const fixture = findFixture(`tier-boundary-${games}-games`);
      const row = Object.values(fixture.snapshot.rows)[0]!;
      expect(confidenceTierFor(games)).toBe(expectedTiers[index]);
      expect(row.sample.confidenceTier).toBe(expectedTiers[index]);
    });
  });

  it('C2-H3: ordinary_prose carries at least four sentences with a Unicode decimal digit, and at least one digit run absent from every licensed claim value', () => {
    const fixture = findFixture('ordinary-prose-negative-corpus');
    const prose = (fixture.sections ?? []).map((section) => section.prose).join(' ');
    const sentences = prose.split(/(?<=[.!?])\s+/);
    const digitBearingSentences = sentences.filter((sentence) => /\p{Nd}/u.test(sentence));
    expect(digitBearingSentences.length).toBeGreaterThanOrEqual(4);

    const licensedNumbers = new Set<number>();
    for (const claim of fixture.output.claims) {
      const value = claim.assertedValue;
      if (value.kind === 'record') {
        licensedNumbers.add(value.wins);
        licensedNumbers.add(value.losses);
        licensedNumbers.add(value.games);
      } else if (value.kind === 'rate') {
        licensedNumbers.add(value.numerator);
        licensedNumbers.add(value.denominator);
      } else if (value.kind === 'count') {
        licensedNumbers.add(value.count);
      }
    }

    const digitRuns = Array.from(prose.matchAll(/\d+/g)).map((match) => Number(match[0]));
    expect(digitRuns.some((digitRun) => !licensedNumbers.has(digitRun))).toBe(true);
  });

  it('C2-H1: the all_null_subject family carries a recent_form row and a cohort_disclosure row whose four subject axes are all null', () => {
    const fixture = findFixture('all-null-subject');
    const rows = Object.values(fixture.snapshot.rows);
    const allNull = (subject: ClaimSubject): boolean =>
      subject.myFighterId === null &&
      subject.opponentFighterId === null &&
      subject.stageId === null &&
      subject.opponentTag === null;

    const recentFormRow = rows.find((row) => row.predicate === 'recent_form');
    const cohortRow = rows.find((row) => row.predicate === 'cohort_disclosure');
    expect(recentFormRow).toBeDefined();
    expect(cohortRow).toBeDefined();
    expect(allNull(recentFormRow!.subject)).toBe(true);
    expect(allNull(cohortRow!.subject)).toBe(true);
  });

  it('C2-M6: prose_entity contains one fixture whose stage row stored name differs from StageList canonical spelling, recorded as accepted', () => {
    const fixture = findFixture('prose-entity-stage-name-mismatch');
    expect(fixture.family).toBe('prose_entity');
    expect(fixture.expected.validatorVerdict).toBe('accepted');
    const prose = (fixture.sections ?? []).map((section) => section.prose).join(' ');
    // "Battle Field" (this fixture's stand-in stored name) must differ from
    // StageList's canonical spelling for stage id 1 ("Battlefield").
    expect(prose).toContain('Battle Field');
    expect(prose).not.toContain('on Battlefield');
  });

  it('no fixture file contains a real account tag or a production push key (spot-check: no known real player tags)', () => {
    const serialized = JSON.stringify(ADVERSARIAL_FIXTURES);
    for (const forbiddenTag of ['sparg0', 'MkLeo', 'IzAw', 'hbox']) {
      expect(serialized.toLowerCase()).not.toContain(forbiddenTag.toLowerCase());
    }
  });
});
