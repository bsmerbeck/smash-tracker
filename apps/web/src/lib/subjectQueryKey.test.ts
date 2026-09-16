import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  getActiveSubjectClientId,
  getActiveSubjectHeader,
  getActiveSubjectSegment,
  setActiveSubject,
  subjectClientIdFromPathname,
  subjectScope,
  subjectSegment,
  subjectSegmentFromPathname,
  subscribeActiveSubject,
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

/**
 * Phase 35-03 (Task 3, H-3/NEW-H2): a subject reader that is correct on the
 * FIRST render of a hard load or deep link, for both `/coach/:clientId/*`
 * and `/workspace/:tenantId/*` — derived from `window.location.pathname` on
 * EVERY call, never from the module store. The module store stays the
 * change-NOTIFICATION channel only.
 */
describe('subjectClientIdFromPathname / subjectSegmentFromPathname', () => {
  it('resolves the coach clientId', () => {
    expect(subjectClientIdFromPathname('/coach/c1/matchups')).toBe('c1');
    expect(subjectSegmentFromPathname('/coach/c1/matchups')).toBe('client:c1');
  });

  it('resolves the owned-workspace tenantId, winning over any coach match', () => {
    expect(subjectClientIdFromPathname('/workspace/t1/trends')).toBe('t1');
    expect(subjectSegmentFromPathname('/workspace/t1/trends')).toBe('client:t1');
  });

  it('resolves personal for the coach hub, a personal route, and root', () => {
    expect(subjectSegmentFromPathname('/coach')).toBe('personal');
    expect(subjectSegmentFromPathname('/matchups')).toBe('personal');
    expect(subjectSegmentFromPathname('/')).toBe('personal');
  });
});

describe('getActiveSubjectClientId / getActiveSubjectSegment', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
    setActiveSubject({ mode: 'personal', clientId: null });
  });

  it('reflects window.location.pathname on every call, independent of the module store (H-3)', () => {
    window.history.pushState({}, '', '/coach/c1/matchups');
    expect(getActiveSubjectClientId()).toBe('c1');
    // The header value is whatever the store last received — deliberately
    // NOT updated by the pathname push alone. Pinning both in one case is
    // what proves the value source and the header source diverge.
    expect(getActiveSubjectHeader()).toBe('personal');

    setActiveSubject({ mode: 'coaching', clientId: 'c1' });
    expect(getActiveSubjectClientId()).toBe('c1');
    expect(getActiveSubjectHeader()).toBe('client:c1');
  });

  it('NEW-H2 boot sequence: /workspace/:tenantId stays client:<tenantId> through the ActiveSubjectSync-then-ClientOwnedWorkspaceLayout write order', () => {
    window.history.pushState({}, '', '/workspace/t1/trends');
    expect(getActiveSubjectSegment()).toBe('client:t1');

    // ActiveSubjectSync's /coach-blind write (personal, null) — the store
    // flips, but the pathname-derived segment must not.
    setActiveSubject({ mode: 'personal', clientId: null });
    expect(getActiveSubjectSegment()).toBe('client:t1');

    // ClientOwnedWorkspaceLayout's correction.
    setActiveSubject({ mode: 'personal', clientId: 't1' });
    expect(getActiveSubjectSegment()).toBe('client:t1');
  });
});

describe('subscribeActiveSubject notification semantics', () => {
  afterEach(() => {
    setActiveSubject({ mode: 'personal', clientId: null });
  });

  it('notifies exactly once per real segment change, not on an equal-but-not-identical object, and never after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveSubject(listener);

    setActiveSubject({ mode: 'coaching', clientId: 'c1' });
    expect(listener).toHaveBeenCalledTimes(1);

    // A different object, same store-derived segment — no notification.
    setActiveSubject({ mode: 'coaching', clientId: 'c1' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setActiveSubject({ mode: 'personal', clientId: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/**
 * Phase 35-03 (Task 4, NEW-M2): the three storage-key builders this phase
 * ships (`analyticsSelectionStorageKey` from 35-01, `analyticsFilterStorageKey`
 * and `rangeAutoWidenSessionKey` from Task 4) all take a RAW `clientId` and
 * must compose the identical `subjectSegment(clientId)` substring — never an
 * already-composed segment, and never a second re-spelling of `client:`.
 */
describe('cross-builder subject segment agreement (NEW-M2)', () => {
  it('all three key builders carry the identical segment substring for the same (uid, clientId) pair', async () => {
    const { analyticsSelectionStorageKey } = await import('./analyticsSelection');
    const { analyticsFilterStorageKey } = await import('@/context/AnalyticsFilterContext');
    const { rangeAutoWidenSessionKey } = await import('@/hooks/useAutoWidenEmptyRange');

    for (const clientId of ['c1', null]) {
      const segment = subjectSegment(clientId);
      expect(analyticsSelectionStorageKey('u1', clientId).endsWith(segment)).toBe(true);
      expect(analyticsFilterStorageKey('u1', clientId).endsWith(segment)).toBe(true);
      expect(rangeAutoWidenSessionKey('u1', clientId).endsWith(segment)).toBe(true);
    }
  });
});
