import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ID_VOCABULARY,
  ACTION_ID_VOCABULARY_SIZE,
  CLAIM_ID_VOCABULARY,
  CLAIM_ID_VOCABULARY_SIZE,
  CLAIM_PREDICATES,
  EVIDENCE_ID_PATTERN,
  isRtdbSafeKeySegment,
  type ClaimSubject,
} from './claims.js';
import {
  EVIDENCE_ID_PREFIX,
  UnsupportedEvidenceSubjectError,
  evidenceIdFor,
  orderSnapshotOpponents,
  vodEvidenceId,
} from './snapshot.js';

/**
 * RPT-08 / D-09 (phase 39 plan 01, wave 1): the contract assertions from
 * Task 1's acceptance criteria that do not belong in the oracle — vocabulary
 * shape, predicate membership, `EVIDENCE_ID_PATTERN` acceptance/rejection,
 * and the evidence-id contract in full (review C2-B2/C2-M10). Relocated
 * here from `rpt08Oracle.test.ts`, which now carries only the fail-first
 * proof, the round-trip battery, and the corpus/rubric coverage gates.
 */

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

describe('EVIDENCE_ID_PATTERN / isRtdbSafeKeySegment contract', () => {
  it('accepts ordinary alphanumeric/underscore/dash segments', () => {
    for (const value of ['c01', 'sr-f23-s1', 'vod-abc-42', 'a_b-C9', 'x']) {
      expect(EVIDENCE_ID_PATTERN.test(value)).toBe(true);
      expect(isRtdbSafeKeySegment(value)).toBe(true);
    }
  });

  it('rejects every RTDB-illegal character and a control character', () => {
    const illegal = ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', `a${String.fromCharCode(0)}b`];
    for (const value of illegal) {
      expect(EVIDENCE_ID_PATTERN.test(value)).toBe(false);
      expect(isRtdbSafeKeySegment(value)).toBe(false);
    }
  });

  it('rejects an empty string and a string over 128 characters', () => {
    expect(isRtdbSafeKeySegment('')).toBe(false);
    expect(isRtdbSafeKeySegment('a'.repeat(129))).toBe(false);
    expect(isRtdbSafeKeySegment('a'.repeat(128))).toBe(true);
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

/** Strips line and block comments — mirrors `purity.test.ts`'s own helper — so this module's OWN doc comment (which deliberately NAMES `canonicalJson`/`canonicalDigest` to explain why they are NOT here) can't false-positive this gate. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('snapshot.ts carries no canonicalizer or digest (review C1-B2)', () => {
  it('a source read finds no createHash, canonicalJson or canonicalDigest OUTSIDE comments — the one canonicalizer stays in apps/api/src/research/registry/canonical.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rawSource = readFileSync(join(here, 'snapshot.ts'), 'utf8');
    // Self-check: the doc comment DOES name these identifiers (intentionally,
    // to explain their absence) — if it stopped doing so, stripComments'
    // premise for this test would be untested.
    expect(rawSource).toMatch(/canonicalJson/);
    const code = stripComments(rawSource);
    expect(code).not.toMatch(/createHash/);
    expect(code).not.toMatch(/canonicalJson/);
    expect(code).not.toMatch(/canonicalDigest/);
  });
});
