import { describe, expect, it } from 'vitest';
import { matchRecordSchema } from '../match.js';
import { splitIntoSessions } from '../glicko.js';
import { normalizeOpponentTag } from '../evidence/identity.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
  type SyntheticMatchOptions,
} from './syntheticMatches.js';

describe('generateSyntheticMatches determinism (D-18)', () => {
  it('produces byte-identical output for the same seed across two separate calls', () => {
    const first = generateSyntheticMatches({ seed: 1, count: 100 });
    const second = generateSyntheticMatches({ seed: 1, count: 100 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('produces different output for a different seed', () => {
    const seedOne = generateSyntheticMatches({ seed: 1, count: 100 });
    const seedTwo = generateSyntheticMatches({ seed: 2, count: 100 });
    expect(JSON.stringify(seedOne)).not.toBe(JSON.stringify(seedTwo));
  });
});

describe('named fixture presets (SCL-01)', () => {
  it('EIGHT_K_FIXTURE_OPTIONS produces exactly 8000 rows', () => {
    expect(generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS)).toHaveLength(8000);
  });

  it('FIFTY_K_FIXTURE_OPTIONS produces exactly 50000 rows', () => {
    expect(generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS)).toHaveLength(50000);
  });
});

describe('multi-character shape (EVID-01, D-15)', () => {
  it('an 8000-game generation has at least 3 distinct fighter_id values, the top two a majority, and at least 10 distinct opponent_id values', () => {
    const rows = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const fighterCounts = new Map<number, number>();
    for (const row of rows) {
      fighterCounts.set(row.fighter_id, (fighterCounts.get(row.fighter_id) ?? 0) + 1);
    }
    expect(fighterCounts.size).toBeGreaterThanOrEqual(3);
    const sortedCounts = [...fighterCounts.values()].sort((a, b) => b - a);
    const topTwo = (sortedCounts[0] ?? 0) + (sortedCounts[1] ?? 0);
    expect(topTwo).toBeGreaterThan(rows.length / 2);

    const distinctOpponentIds = new Set(rows.map((r) => r.opponent_id));
    expect(distinctOpponentIds.size).toBeGreaterThanOrEqual(40);
  });

  it('splits into more than 50 sessions under splitIntoSessions default gap (burst clustering, not one flat block)', () => {
    const rows = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    expect(splitIntoSessions(rows).length).toBeGreaterThan(50);
  });
});

describe('schema conformance', () => {
  it('every row of a 200-row generation parses through matchRecordSchema without throwing', () => {
    const rows = generateSyntheticMatches({ seed: 3, count: 200 });
    for (const row of rows) {
      expect(() => matchRecordSchema.parse(row)).not.toThrow();
    }
  });
});

describe('unknown-stage conditional-spread shape (D-09)', () => {
  it('includes rows with no own `map` property, and never a null `map`', () => {
    const rows = generateSyntheticMatches({ seed: 4, count: 500, unknownStageRate: 0.2 });
    const unknownRows = rows.filter((r) => !Object.prototype.hasOwnProperty.call(r, 'map'));
    expect(unknownRows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as { map?: unknown }).map).not.toBeNull();
    }
  });
});

describe('alias-split opponent (EVID-12 fixture requirement)', () => {
  const options: SyntheticMatchOptions = {
    seed: 5,
    count: 500,
    aliasSplitOpponentTags: ['shadowfox', 'nightowl'],
    aliasSplitOpponentSlug: 'user/abc123',
  };

  it('the two alias-split tags normalize to two different strings through the engine normalizer', () => {
    const [tag1, tag2] = options.aliasSplitOpponentTags!;
    expect(normalizeOpponentTag(tag1)).not.toBe(normalizeOpponentTag(tag2));
  });

  it('emits rows under exactly the two configured raw tags, at least one slug-only row, and at least one slug+tag binding row', () => {
    const rows = generateSyntheticMatches(options);
    const [tag1, tag2] = options.aliasSplitOpponentTags!;
    const slug = options.aliasSplitOpponentSlug!;

    const taggedRows = rows.filter((r) => r.opponent === tag1 || r.opponent === tag2);
    expect(taggedRows.length).toBeGreaterThan(0);
    const distinctTags = new Set(taggedRows.map((r) => r.opponent));
    expect(distinctTags).toEqual(new Set([tag1, tag2]));

    const slugOnlyRows = rows.filter(
      (r) => r.opponentUserSlug === slug && !Object.prototype.hasOwnProperty.call(r, 'opponent'),
    );
    expect(slugOnlyRows.length).toBeGreaterThanOrEqual(1);

    const bindingRows = rows.filter(
      (r) => r.opponentUserSlug === slug && (r.opponent === tag1 || r.opponent === tag2),
    );
    expect(bindingRows.length).toBeGreaterThanOrEqual(1);
  });
});
