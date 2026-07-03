import { describe, expect, it } from 'vitest';
import { generateGradient } from './colors';

describe('generateGradient', () => {
  it('returns an empty array for zero or negative steps', () => {
    expect(generateGradient('#ff0000', '#000000', 0)).toEqual([]);
    expect(generateGradient('#ff0000', '#000000', -1)).toEqual([]);
  });

  it('returns just the start color for a single step', () => {
    expect(generateGradient('#ff0000', '#000000', 1)).toEqual(['#ff0000']);
  });

  it('returns exactly colorA and colorB as the first and last entries for two steps', () => {
    expect(generateGradient('#ff0000', '#000000', 2)).toEqual(['#ff0000', '#000000']);
  });

  it('produces `steps` colors, deterministically, starting and ending on the given endpoints', () => {
    const result = generateGradient('#ff0000', '#070707', 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe('#ff0000');
    expect(result[4]).toBe('#070707');
  });

  it('is deterministic across repeated calls with the same inputs', () => {
    const a = generateGradient('#ff0000', '#070707', 10);
    const b = generateGradient('#ff0000', '#070707', 10);
    expect(a).toEqual(b);
  });

  it('expands shorthand 3-digit hex colors', () => {
    const result = generateGradient('#f00', '#000', 2);
    expect(result).toEqual(['#ff0000', '#000000']);
  });

  it('falls back to white for malformed hex input', () => {
    const result = generateGradient('not-a-color', '#000000', 2);
    expect(result[0]).toBe('#ffffff');
  });

  it('interpolates intermediate steps monotonically toward the end color', () => {
    const result = generateGradient('#ffffff', '#000000', 3);
    expect(result).toEqual(['#ffffff', '#7f7f7f', '#000000']);
  });
});
