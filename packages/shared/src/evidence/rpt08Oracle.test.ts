import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_ID_PATTERN, MIN_VIABLE_CLAIMS, type ClaimSubject } from './claims.js';
import {
  EVIDENCE_ID_PREFIX,
  evidenceIdFor,
  orderSnapshotOpponents,
  parseVodEvidenceId,
  vodEvidenceId,
} from './snapshot.js';
import { legacyCitationOnlyVerdict } from './legacyCitationRule.js';
import {
  ADVERSARIAL_FAMILIES,
  ADVERSARIAL_FIXTURES,
  RUBRIC_RULE_IDS,
} from './adversarialFixtures.js';
import { CONFIDENCE_TIER_BOUNDS, confidenceTierFor } from './policy.js';
import { emptyWorkspace, oneGameWorkspace, twoGameWorkspace } from '../testUtils/index.js';

/**
 * RPT-08 / D-09 (phase 39 plan 01, wave 1): this suite's green-ness IS the
 * proof that today's shipped citation rule is insufficient — a claim citing
 * a REAL evidence id but stating a wrong number is ACCEPTED by the frozen
 * `legacyCitationOnlyVerdict`. It also carries the fixture-corpus coverage
 * gates and the rubric<->corpus cross-checks. Pure contract tests for
 * `claims.ts`/`snapshot.ts` shapes live in `claimContracts.test.ts`.
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

// ---------------------------------------------------------------------------
// Task 3: the rubric record<->corpus cross-checks — the wave-1 gate that
// keeps `RPT-08-rubric.md` and `adversarialFixtures.ts` from silently
// drifting apart.
// ---------------------------------------------------------------------------

/** Parses the rule ids out of the rubric markdown's rule table (a single regex over the table's first column). */
function parseRubricRuleIds(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const rubricPath = join(here, 'records', 'RPT-08-rubric.md');
  const markdown = readFileSync(rubricPath, 'utf8');
  const ruleIdPattern = /^\|\s*(R[0-9]+)\s*\|/gm;
  const ids: string[] = [];
  for (const match of markdown.matchAll(ruleIdPattern)) {
    if (match[1]) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/** Parses the `MIN_VIABLE_CLAIMS` table the rubric records, keyed by surface name, so the record can be cross-checked against the exported constant. */
function parseRubricMinViableClaims(): Record<string, number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const rubricPath = join(here, 'records', 'RPT-08-rubric.md');
  const markdown = readFileSync(rubricPath, 'utf8');
  const rowPattern = /^\|\s*`([a-z_]+)`\s*\|\s*([0-9]+)\s*\|/gm;
  const values: Record<string, number> = {};
  for (const match of markdown.matchAll(rowPattern)) {
    const surface = match[1];
    const value = match[2];
    if (surface && value) {
      values[surface] = Number(value);
    }
  }
  return values;
}

describe('RPT-08-rubric.md <-> adversarialFixtures.ts cross-check (Task 3)', () => {
  it('the rubric parses to a non-empty rule-id set equal to RUBRIC_RULE_IDS', () => {
    const parsedRuleIds = parseRubricRuleIds();
    expect(parsedRuleIds.length).toBeGreaterThan(0);
    expect(new Set(parsedRuleIds)).toEqual(new Set(RUBRIC_RULE_IDS));
  });

  it('every rubric rule id is named by at least one fixture (a rule with no fixture fails here)', () => {
    const namedByFixtures = new Set(
      ADVERSARIAL_FIXTURES.flatMap((fixture) => fixture.rubricRuleIds),
    );
    for (const ruleId of RUBRIC_RULE_IDS) {
      expect(namedByFixtures.has(ruleId)).toBe(true);
    }
  });

  it('the corpus is not silently empty (anti-vacuous guard — at least as many fixtures as declared families)', () => {
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThanOrEqual(ADVERSARIAL_FAMILIES.length);
  });

  it('the MIN_VIABLE_CLAIMS values written in the rubric record equal the exported constant', () => {
    const parsed = parseRubricMinViableClaims();
    expect(parsed).toEqual(MIN_VIABLE_CLAIMS);
  });
});
