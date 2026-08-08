import { describe, expect, it } from 'vitest';
import { CLIENT_TENANT_KINDS, isResearchKind, SUBJECT_KIND_RESOLUTIONS } from './researchKind.js';

describe('CLIENT_TENANT_KINDS (D-01 stored discriminator vocabulary)', () => {
  it('is exactly [coaching, research]', () => {
    expect(CLIENT_TENANT_KINDS).toEqual(['coaching', 'research']);
  });
});

describe('SUBJECT_KIND_RESOLUTIONS (review finding 29-01 HIGH resolution vocabulary)', () => {
  it('is exactly [ordinary, research, unresolved]', () => {
    expect(SUBJECT_KIND_RESOLUTIONS).toEqual(['ordinary', 'research', 'unresolved']);
  });
});

describe('isResearchKind', () => {
  it('returns true for the research member (stored vocabulary)', () => {
    expect(isResearchKind('research')).toBe(true);
  });

  it('returns true for the research member (resolution vocabulary)', () => {
    expect(isResearchKind('research')).toBe(true);
  });

  it('returns false for the coaching member', () => {
    expect(isResearchKind('coaching')).toBe(false);
  });

  it('returns false for the ordinary resolution', () => {
    expect(isResearchKind('ordinary')).toBe(false);
  });

  it('returns false for the unresolved resolution (never a silent false negative treated as known-ordinary or known-research)', () => {
    expect(isResearchKind('unresolved')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isResearchKind(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isResearchKind(null)).toBe(false);
  });
});
