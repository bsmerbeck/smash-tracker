import { describe, expect, it } from 'vitest';
import { matchRecordSchema } from '../match.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
} from './sparseWorkspaces.js';

describe('named sparse/cold-start workspaces (FIXT-02, D-18)', () => {
  it('emptyWorkspace() has zero games', () => {
    expect(emptyWorkspace()).toHaveLength(0);
  });

  it('oneGameWorkspace() has exactly one game, valid against matchRecordSchema', () => {
    const rows = oneGameWorkspace();
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(() => matchRecordSchema.parse(row)).not.toThrow();
    }
  });

  it('twoGameWorkspace() has exactly two games, both with a known stage', () => {
    const rows = twoGameWorkspace();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(() => matchRecordSchema.parse(row)).not.toThrow();
      expect(row.map?.id).toBeGreaterThan(0);
    }
  });

  it('unknownStageOnlyWorkspace() has five games, none carrying an own `map` property', () => {
    const rows = unknownStageOnlyWorkspace();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'map')).toBe(false);
      expect(() => matchRecordSchema.parse(row)).not.toThrow();
    }
  });

  it('unknownCharacterOnlyWorkspace() has five games, each rejected by matchRecordSchema (D-25: no live ingestion path produces this)', () => {
    const rows = unknownCharacterOnlyWorkspace();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(matchRecordSchema.safeParse(row).success).toBe(false);
    }
  });
});
