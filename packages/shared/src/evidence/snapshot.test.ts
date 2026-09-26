import { describe, expect, it } from 'vitest';
import { isSnapshotId, SNAPSHOT_ID_LENGTH } from './snapshot.js';

/**
 * `isSnapshotId` was rewritten from a template-built `new RegExp` into a
 * regex literal plus a length check (post-39-11 eager-bundle fix). This
 * battery pins the rewrite to the ORIGINAL pattern's accept/reject set, with
 * that original pattern as the oracle, so the shape rule cannot drift.
 */
const ORIGINAL_PATTERN = new RegExp(`^[0-9a-f]{${SNAPSHOT_ID_LENGTH}}$`);

const hex = (length: number, char = 'a'): string => char.repeat(length);

const CASES: readonly string[] = [
  hex(SNAPSHOT_ID_LENGTH),
  '0123456789abcdef'.repeat(4),
  hex(SNAPSHOT_ID_LENGTH - 1),
  hex(SNAPSHOT_ID_LENGTH + 1),
  '',
  hex(SNAPSHOT_ID_LENGTH, 'A'),
  `${hex(SNAPSHOT_ID_LENGTH - 1)}g`,
  `${hex(SNAPSHOT_ID_LENGTH)}\n`,
  `${hex(SNAPSHOT_ID_LENGTH - 1)}\n`,
  `\n${hex(SNAPSHOT_ID_LENGTH - 1)}`,
  ` ${hex(SNAPSHOT_ID_LENGTH - 1)}`,
  `${hex(32)}-${hex(31)}`,
];

describe('isSnapshotId', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isSnapshotId(hex(SNAPSHOT_ID_LENGTH))).toBe(true);
    expect(isSnapshotId(hex(SNAPSHOT_ID_LENGTH - 1))).toBe(false);
    expect(isSnapshotId(hex(SNAPSHOT_ID_LENGTH + 1))).toBe(false);
    expect(isSnapshotId(hex(SNAPSHOT_ID_LENGTH, 'A'))).toBe(false);
  });

  it.each(CASES.map((value) => [JSON.stringify(value), value]))(
    'agrees with the original ^[0-9a-f]{64}$ pattern for %s',
    (_label, value) => {
      expect(isSnapshotId(value)).toBe(ORIGINAL_PATTERN.test(value));
    },
  );
});
