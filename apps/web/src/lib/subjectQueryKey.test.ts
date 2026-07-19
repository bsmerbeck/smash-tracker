import { describe, expect, it } from 'vitest';
import { getActiveSubjectHeader, setActiveSubject, subjectScope } from './subjectQueryKey';

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
});
