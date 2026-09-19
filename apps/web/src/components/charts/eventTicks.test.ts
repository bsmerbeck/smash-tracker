import { describe, expect, it } from 'vitest';
import { MAX_EVENT_TICK_LABEL_LENGTH, formatEventTickLabel, selectEventTicks } from './eventTicks';

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `anchor-${i}`);
}

describe('selectEventTicks', () => {
  it('returns every key in input order for a sparse anchor count at an explicit width', () => {
    const input = keys(4);
    expect(selectEventTicks(input, 640)).toEqual(input);
  });

  it('returns strictly fewer keys for a dense anchor count at the same width', () => {
    const input = keys(30);
    const result = selectEventTicks(input, 640);
    expect(result.length).toBeLessThan(input.length);
  });

  it('the dense result always keeps the input first and last key', () => {
    const input = keys(30);
    const result = selectEventTicks(input, 640);
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[input.length - 1]);
  });

  it('the dense result is a subsequence of the input in input order, no invented or duplicated key', () => {
    const input = keys(30);
    const result = selectEventTicks(input, 640);
    expect(new Set(result).size).toBe(result.length);
    for (const key of result) {
      expect(input).toContain(key);
    }
    let cursor = -1;
    for (const key of result) {
      const idx = input.indexOf(key);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('zero anchors returns an empty array without throwing', () => {
    expect(selectEventTicks([], 640)).toEqual([]);
  });

  it('one anchor returns that one key without throwing', () => {
    expect(selectEventTicks(['solo'], 640)).toEqual(['solo']);
  });

  it('a non-positive width returns the first and last keys only rather than dividing by zero', () => {
    const input = keys(10);
    expect(selectEventTicks(input, 0)).toEqual([input[0], input[input.length - 1]]);
    expect(selectEventTicks(input, -100)).toEqual([input[0], input[input.length - 1]]);
  });
});

describe('formatEventTickLabel', () => {
  it('returns a label at or under the maximum length byte-identical', () => {
    const label = 'a'.repeat(MAX_EVENT_TICK_LABEL_LENGTH);
    expect(formatEventTickLabel(label)).toBe(label);
  });

  it('returns the empty string unchanged', () => {
    expect(formatEventTickLabel('')).toBe('');
  });

  it('truncates a longer label to the maximum length plus a trailing ellipsis', () => {
    const label = 'a'.repeat(MAX_EVENT_TICK_LABEL_LENGTH + 5);
    const result = formatEventTickLabel(label);
    expect(result).toBe(`${'a'.repeat(MAX_EVENT_TICK_LABEL_LENGTH)}…`);
    expect(result.length).toBe(MAX_EVENT_TICK_LABEL_LENGTH + 1);
  });
});
