import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  COUNTABLE_GAME_UPSTREAM_RULES,
  isUnknownCharacter,
  isUnknownStage,
  stageBucketId,
  UNKNOWN_STAGE_ID,
} from './predicate.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('stageBucketId / isUnknownStage', () => {
  it('defaults an absent map to UNKNOWN_STAGE_ID', () => {
    const match = makeMatch({ id: '1', time: 1, win: true });
    expect(stageBucketId(match)).toBe(UNKNOWN_STAGE_ID);
    expect(isUnknownStage(match)).toBe(true);
  });

  it('treats map.id 0 as unknown', () => {
    const match = makeMatch({ id: '1', time: 1, win: true, map: { id: 0, name: 'no selection' } });
    expect(isUnknownStage(match)).toBe(true);
  });

  it('is known for a real stage id', () => {
    const match = makeMatch({ id: '1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } });
    expect(stageBucketId(match)).toBe(1);
    expect(isUnknownStage(match)).toBe(false);
  });
});

describe('isUnknownCharacter (D-25 — synthetic-fixture-only branch)', () => {
  it('is false for two real roster fighter ids', () => {
    const match = makeMatch({ id: '1', time: 1, win: true, fighter_id: 1, opponent_id: 8 });
    expect(isUnknownCharacter(match)).toBe(false);
  });

  it('is true when a fighter id is outside the roster — a fabricated fixture, since real ingestion drops such games before a Match[] is ever produced (D-25)', () => {
    const match = makeMatch({ id: '1', time: 1, win: true, fighter_id: 999_999, opponent_id: 8 });
    expect(isUnknownCharacter(match)).toBe(true);
  });
});

describe('COUNTABLE_GAME_UPSTREAM_RULES (D-17/D-25)', () => {
  it('contains the five documented rule ids', () => {
    expect(COUNTABLE_GAME_UPSTREAM_RULES.map((r) => r.id).sort()).toEqual(
      ['R-BYE', 'R-DQ-DISPLAY', 'R-DQ-FLAG', 'R-NO-GAME-DETAIL', 'R-WALKOVER-EXPLICIT'].sort(),
    );
  });

  it("every entry's where names a path under apps/api/src/ that exists on disk", () => {
    expect(COUNTABLE_GAME_UPSTREAM_RULES.length).toBeGreaterThan(0);
    for (const rule of COUNTABLE_GAME_UPSTREAM_RULES) {
      const [filePath] = rule.where.split(':');
      expect(filePath, `rule ${rule.id}`).toMatch(/^apps\/api\/src\//);
      // predicate.ts lives at packages/shared/src/evidence/; repo root is three levels up.
      const repoRelative = new URL(`../../../../${filePath}`, import.meta.url);
      expect(existsSync(repoRelative), `rule ${rule.id} path ${filePath}`).toBe(true);
    }
  });
});
