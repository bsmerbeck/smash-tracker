import { describe, expect, it } from 'vitest';
import {
  getActiveSubjectHeader,
  setActiveSubject,
  subjectScope,
  subjectSegment,
} from './subjectQueryKey';

describe('subjectScope', () => {
  it('returns a personal-only scope for personal mode', () => {
    expect(subjectScope({ mode: 'personal', clientId: null })).toEqual(['personal']);
  });

  it('returns a client-prefixed scope for coaching mode with a clientId', () => {
    expect(subjectScope({ mode: 'coaching', clientId: 'tenant-123' })).toEqual([
      'client',
      'tenant-123',
    ]);
  });

  it('falls back to personal when coaching mode is missing a clientId', () => {
    expect(subjectScope({ mode: 'coaching', clientId: null })).toEqual(['personal']);
  });
});

describe('setActiveSubject / getActiveSubjectHeader', () => {
  it('defaults to personal before any subject is set', () => {
    setActiveSubject({ mode: 'personal', clientId: null });
    expect(getActiveSubjectHeader()).toBe('personal');
  });

  it('reflects the last subject set, formatted for the X-Active-Subject header', () => {
    setActiveSubject({ mode: 'coaching', clientId: 'tenant-456' });
    expect(getActiveSubjectHeader()).toBe('client:tenant-456');

    setActiveSubject({ mode: 'personal', clientId: null });
    expect(getActiveSubjectHeader()).toBe('personal');
  });

  it('walkthrough fix FB-1: stays personal at the /coach hub (mode coaching, no clientId)', () => {
    setActiveSubject({ mode: 'coaching', clientId: null });
    expect(getActiveSubjectHeader()).toBe('personal');
  });
});

/**
 * Phase 35 (NEW-M2): `subjectSegment` is the ONE place the `client:` literal
 * is spelled anywhere in the app — `getActiveSubjectHeader` above and every
 * subject-scoped storage key (`analyticsSelectionStorageKey`, and 35-03's
 * `analyticsFilterStorageKey`/`rangeAutoWidenSessionKey`) compose through it
 * instead of re-spelling the branch themselves.
 */
describe('subjectSegment', () => {
  it('returns "personal" for a null clientId', () => {
    expect(subjectSegment(null)).toBe('personal');
  });

  it('returns "client:<id>" for a non-null clientId', () => {
    expect(subjectSegment('c1')).toBe('client:c1');
  });
});
