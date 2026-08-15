import { describe, expect, it } from 'vitest';
import { classifyPlayerTag } from './playerSlot.js';
import {
  clampNullableUntrustedText,
  clampReason,
  clampUntrustedText,
  normalizeOptionalUntrustedText,
  RESEARCH_ENRICHMENT_MAX_RAW_TEXT,
  RESEARCH_ENRICHMENT_MAX_REASON_TEXT,
} from './observationBounds.js';

describe('classifyPlayerTag', () => {
  it('classifies an absent parameter as missing', () => {
    expect(classifyPlayerTag(undefined)).toMatchObject({ usable: false, reason: 'missing' });
  });

  it.each(['', ' ', '   ', '\t', '\n'])('classifies %j as empty', (raw) => {
    expect(classifyPlayerTag(raw)).toMatchObject({ usable: false, reason: 'empty' });
  });

  it.each(['TBD', 'tbd', 'Tbd', 'BYE', 'Bye', 'bye', '  TBD  '])(
    'classifies the placeholder %j as unusable',
    (raw) => {
      expect(classifyPlayerTag(raw)).toMatchObject({ usable: false, reason: 'placeholder' });
    },
  );

  it('returns the trimmed tag for a usable slot', () => {
    expect(classifyPlayerTag('  MkLeo  ')).toEqual({ usable: true, tag: 'MkLeo' });
  });

  it('does not treat a tag that merely CONTAINS a placeholder as one', () => {
    expect(classifyPlayerTag('TBDaniel')).toEqual({ usable: true, tag: 'TBDaniel' });
    expect(classifyPlayerTag('Byleth')).toEqual({ usable: true, tag: 'Byleth' });
  });

  it('clamps an overlength tag to the persistence schema raw-text cap', () => {
    const oversized = 'x'.repeat(RESEARCH_ENRICHMENT_MAX_RAW_TEXT + 50);
    const result = classifyPlayerTag(oversized);
    expect(result.usable).toBe(true);
    if (result.usable) {
      expect(result.tag.length).toBe(RESEARCH_ENRICHMENT_MAX_RAW_TEXT);
    }
  });
});

describe('observation bounds helpers', () => {
  it('clampUntrustedText truncates only past the cap', () => {
    expect(clampUntrustedText('abc', 5)).toBe('abc');
    expect(clampUntrustedText('abcdef', 5)).toBe('abcde');
  });

  it('clampNullableUntrustedText passes null and undefined through byte-unchanged', () => {
    expect(clampNullableUntrustedText(null, 5)).toBeNull();
    expect(clampNullableUntrustedText(undefined, 5)).toBeUndefined();
    expect(clampNullableUntrustedText('abcdef', 5)).toBe('abcde');
  });

  it('normalizeOptionalUntrustedText drops missing and effectively-empty values', () => {
    expect(normalizeOptionalUntrustedText(undefined, 5)).toBeUndefined();
    expect(normalizeOptionalUntrustedText(null, 5)).toBeUndefined();
    expect(normalizeOptionalUntrustedText('   ', 5)).toBeUndefined();
    expect(normalizeOptionalUntrustedText('  us  ', 5)).toBe('us');
  });

  it('clampReason bounds a stated reason to the schema per-reason cap', () => {
    const reason = 'r'.repeat(RESEARCH_ENRICHMENT_MAX_REASON_TEXT + 100);
    expect(clampReason(reason).length).toBe(RESEARCH_ENRICHMENT_MAX_REASON_TEXT);
  });
});
