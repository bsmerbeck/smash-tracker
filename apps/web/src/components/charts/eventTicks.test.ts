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

/**
 * Plan 39.1-37 (VIZ-03, design-audit item 5; human-event-axis): at most
 * MAX_EVENT_POINT_LABELS (8) per-anchor W-L labels, first and last always.
 * Read through the module namespace so the RED run fails on an assertion.
 */
async function loadLabelKeys(): Promise<{
  select: (keys: readonly string[], width: number) => string[];
  max: unknown;
}> {
  const mod = (await import('./eventTicks')) as Record<string, unknown>;
  expect(typeof mod.selectEventLabelKeys, 'selectEventLabelKeys is exported').toBe('function');
  return {
    select: mod.selectEventLabelKeys as (keys: readonly string[], width: number) => string[],
    max: mod.MAX_EVENT_POINT_LABELS,
  };
}

describe('selectEventLabelKeys (plan 39.1-37)', () => {
  it('MAX_EVENT_POINT_LABELS is 8', async () => {
    const { max } = await loadLabelKeys();
    expect(max).toBe(8);
  });

  it('23 anchors at 1,390px -> at most 8 keys, first and last kept, a subsequence of selectEventTicks', async () => {
    const { select } = await loadLabelKeys();
    const input = keys(23);
    const result = select(input, 1390);
    expect(result.length).toBeLessThanOrEqual(8);
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[22]);
    const ticks = selectEventTicks(input, 1390);
    let cursor = 0;
    for (const key of result) {
      const at = ticks.indexOf(key, cursor);
      expect(at, key).toBeGreaterThanOrEqual(0);
      cursor = at + 1;
    }
  });

  it('5 anchors -> all 5', async () => {
    const { select } = await loadLabelKeys();
    expect(select(keys(5), 1390)).toEqual(keys(5));
  });

  it('at 326px -> at most what selectEventTicks allows there, capped at 8', async () => {
    const { select } = await loadLabelKeys();
    const input = keys(23);
    const result = select(input, 326);
    expect(result.length).toBeLessThanOrEqual(Math.min(8, selectEventTicks(input, 326).length));
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[22]);
  });
});
