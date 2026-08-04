import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, X_EVENT_ALLOWLIST } from './events.js';
import {
  deriveReviewAtCandidate,
  entryKeyInputSchema,
  isReportReadyBinding,
  normalizePrepBriefRecord,
  normalizeScoutBindingRecord,
  PREP_CHECKLIST_ITEM_IDS,
  prepBriefRecordSchema,
  prepBriefStatusSchema,
  prepOpenRequestSchema,
  prepScoutBindingConfirmRequestSchema,
  REVIEW_CHECKLIST_ITEM_IDS,
  scoutBindingMapRecordSchema,
  scoutBindingRecordSchema,
  type PrepBriefRecord,
  type ScoutBinding,
  type ScoutBindingRecord,
} from './prep.js';

/** Same helper style as the house colocated-schema tests: states only each test's delta. */
function makeStoredRecord(overrides: Partial<PrepBriefRecord> = {}): PrepBriefRecord {
  return {
    eventDate: 1,
    activatedAt: 2,
    lastOpenedAt: 3,
    ...overrides,
  };
}

// 260725-juj incident class: a `.nullable()`-only stored-read schema threw
// on a null-stripped subtree and took a production surface down. These
// tests lock the `.nullish()` tolerance that prevents the same class of
// outage from recurring against the prep-brief record.
describe('prepBriefRecordSchema (260725-juj null-strip tolerance)', () => {
  it('parses a stored record with both maps absent, and normalizePrepBriefRecord yields {} for each', () => {
    const parsed = prepBriefRecordSchema.parse(makeStoredRecord());
    expect(parsed.checklist).toBeUndefined();
    expect(parsed.likelyOpponents).toBeUndefined();

    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.checklist).toEqual({});
    expect(normalized.likelyOpponents).toEqual({});
  });

  it('parses a stored record with both maps explicitly null (RTDB explicit-null read)', () => {
    const result = prepBriefRecordSchema.safeParse(
      makeStoredRecord({ checklist: null, likelyOpponents: null }),
    );
    expect(result.success).toBe(true);
  });

  it('normalizes a populated checklist to the same map, unchanged', () => {
    const populated = makeStoredRecord({
      checklist: { confirmRegistration: true, chargeGear: true },
      likelyOpponents: { rival: true },
    });
    const parsed = prepBriefRecordSchema.parse(populated);
    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.checklist).toEqual({ confirmRegistration: true, chargeGear: true });
    expect(normalized.likelyOpponents).toEqual({ rival: true });
  });
});

describe('PREP_CHECKLIST_ITEM_IDS', () => {
  it('has exactly 7 unique entries', () => {
    expect(PREP_CHECKLIST_ITEM_IDS).toHaveLength(7);
    expect(new Set(PREP_CHECKLIST_ITEM_IDS).size).toBe(7);
  });
});

describe('prepOpenRequestSchema', () => {
  it('rejects an empty openId', () => {
    expect(prepOpenRequestSchema.safeParse({ openId: '' }).success).toBe(false);
  });

  it('accepts a 36-char UUID openId', () => {
    const result = prepOpenRequestSchema.safeParse({
      openId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });
});

describe('EVENT_CATALOG prep-brief entries', () => {
  it('classifies prep_brief_activated and prep_brief_reopened as D, prep_offer_viewed as X', () => {
    expect(EVENT_CATALOG.prep_brief_activated).toBe('D');
    expect(EVENT_CATALOG.prep_brief_reopened).toBe('D');
    expect(EVENT_CATALOG.prep_offer_viewed).toBe('X');
    expect(X_EVENT_ALLOWLIST).toContain('prep_offer_viewed');
  });

  it('leaves the Phase 13 tournament_prep_activated row untouched (D-11 non-regression)', () => {
    expect(EVENT_CATALOG.tournament_prep_activated).toBe('D');
  });
});

// Phase 27: the scoutBinding contract, the shared entryKey validator, and
// paidReportsAvailable (RPT-01..04, EVT-05, 27-CONTEXT.md "Report grounding").
describe('entryKeyInputSchema', () => {
  it('rejects an entryKey containing an RTDB-illegal path character', () => {
    for (const value of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b']) {
      expect(entryKeyInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects a control character', () => {
    expect(entryKeyInputSchema.safeParse('ab').success).toBe(false);
  });

  it('accepts a normal entry key unchanged (no trim/lowercase, unlike opponentNameInputSchema)', () => {
    expect(entryKeyInputSchema.parse('Evo-2026-Ult')).toBe('Evo-2026-Ult');
  });
});

function makeStoredBinding(overrides: Partial<ScoutBindingRecord> = {}): ScoutBindingRecord {
  return {
    provider: 'startgg',
    startggUserSlug: 'user/07dc2239',
    displayTag: 'Pandem1c',
    method: 'matchHistory',
    confirmedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('scoutBindingRecordSchema (null-strip tolerance)', () => {
  it('parses a stored binding whose optional identity fields were RTDB-stripped (absent)', () => {
    const result = scoutBindingRecordSchema.safeParse(makeStoredBinding());
    expect(result.success).toBe(true);
  });

  it('parses a stored binding with explicit-null optional identity fields', () => {
    const result = scoutBindingRecordSchema.safeParse(
      makeStoredBinding({ startggPlayerId: null, parryUserId: null }),
    );
    expect(result.success).toBe(true);
  });
});

describe('normalizeScoutBindingRecord', () => {
  it('drops null identity fields entirely (never survives as null in the normalized object)', () => {
    const record = makeStoredBinding({ startggPlayerId: null, parryUserId: null });
    const normalized = normalizeScoutBindingRecord(scoutBindingRecordSchema.parse(record));
    expect('parryUserId' in normalized).toBe(false);
    expect('startggPlayerId' in normalized).toBe(false);
    expect(normalized.startggUserSlug).toBe('user/07dc2239');
  });
});

describe('isReportReadyBinding', () => {
  it('is false for a combined binding missing parryUserId', () => {
    const binding: ScoutBinding = {
      provider: 'combined',
      startggUserSlug: 'user/x',
      displayTag: 'x',
      method: 'matchHistory',
      confirmedAt: 1,
    };
    expect(isReportReadyBinding(binding)).toBe(false);
  });

  it('is false for a parrygg binding missing parryUserId', () => {
    const binding: ScoutBinding = {
      provider: 'parrygg',
      displayTag: 'x',
      method: 'matchHistory',
      confirmedAt: 1,
    };
    expect(isReportReadyBinding(binding)).toBe(false);
  });

  it('is true for a startgg binding with only startggUserSlug', () => {
    const binding: ScoutBinding = {
      provider: 'startgg',
      startggUserSlug: 'user/x',
      displayTag: 'x',
      method: 'matchHistory',
      confirmedAt: 1,
    };
    expect(isReportReadyBinding(binding)).toBe(true);
  });

  it('is true for a combined binding with both a start.gg identity and parryUserId', () => {
    const binding: ScoutBinding = {
      provider: 'combined',
      startggUserSlug: 'user/x',
      parryUserId: 'parry-uuid',
      displayTag: 'x',
      method: 'matchHistory',
      confirmedAt: 1,
    };
    expect(isReportReadyBinding(binding)).toBe(true);
  });
});

describe('scoutBindingMapRecordSchema', () => {
  it('parses an empty map', () => {
    expect(scoutBindingMapRecordSchema.safeParse({}).success).toBe(true);
  });

  it('parses a populated map keyed by canonical opponent name', () => {
    const result = scoutBindingMapRecordSchema.safeParse({ rival: makeStoredBinding() });
    expect(result.success).toBe(true);
  });
});

describe('prepBriefRecordSchema.scoutBindings (260725-juj null-strip tolerance)', () => {
  it('parses a stored record with scoutBindings absent, and normalizePrepBriefRecord yields {}', () => {
    const parsed = prepBriefRecordSchema.parse({ eventDate: 1, activatedAt: 2, lastOpenedAt: 3 });
    expect(parsed.scoutBindings).toBeUndefined();
    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.scoutBindings).toEqual({});
  });

  it('parses a stored record with scoutBindings explicitly null, and normalizePrepBriefRecord yields {}', () => {
    const parsed = prepBriefRecordSchema.parse({
      eventDate: 1,
      activatedAt: 2,
      lastOpenedAt: 3,
      scoutBindings: null,
    });
    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.scoutBindings).toEqual({});
  });

  it('normalizes a populated scoutBindings map through normalizeScoutBindingRecord', () => {
    const parsed = prepBriefRecordSchema.parse({
      eventDate: 1,
      activatedAt: 2,
      lastOpenedAt: 3,
      scoutBindings: { rival: makeStoredBinding() },
    });
    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.scoutBindings.rival?.displayTag).toBe('Pandem1c');
  });
});

describe('prepBriefStatusSchema.paidReportsAvailable', () => {
  it('succeeds with paidReportsAvailable absent (deploy-order compatibility)', () => {
    const result = prepBriefStatusSchema.safeParse({ activated: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paidReportsAvailable).toBeUndefined();
    }
  });

  it('accepts an explicit paidReportsAvailable: true', () => {
    const result = prepBriefStatusSchema.safeParse({ activated: true, paidReportsAvailable: true });
    expect(result.success).toBe(true);
  });
});

describe('prepScoutBindingConfirmRequestSchema', () => {
  it('requires at least one of startgg/parrygg', () => {
    expect(prepScoutBindingConfirmRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a startgg-only query', () => {
    const result = prepScoutBindingConfirmRequestSchema.safeParse({
      startgg: { query: 'user/07dc2239' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts both startgg and parrygg queries (combined confirmation)', () => {
    const result = prepScoutBindingConfirmRequestSchema.safeParse({
      startgg: { query: 'user/07dc2239' },
      parrygg: { query: 'Pandem1c' },
    });
    expect(result.success).toBe(true);
  });
});

// Phase 28 (REV-01/REV-02): review conversion contract — reviewAt/
// reviewCompletedAt/reviewChecklist on the stored brief, the review
// checklist tuple, and deriveReviewAtCandidate (the owner's corrected
// trigger). RESEARCH Pitfall 2: a numeric default on reviewAt would
// instantly convert every legacy brief — these tests lock the `.nullish()`
// no-default tolerance the same way the 260725-juj tests above lock it for
// `checklist`/`likelyOpponents`.
describe('prepBriefRecordSchema.review fields (Phase 28, 260725-juj null-strip tolerance)', () => {
  it('parses a stored record with reviewAt/reviewCompletedAt/reviewChecklist all absent', () => {
    const parsed = prepBriefRecordSchema.parse(makeStoredRecord());
    expect(parsed.reviewAt).toBeUndefined();
    expect(parsed.reviewCompletedAt).toBeUndefined();
    expect(parsed.reviewChecklist).toBeUndefined();
  });

  it('parses a stored record with reviewAt/reviewCompletedAt/reviewChecklist all explicitly null', () => {
    const result = prepBriefRecordSchema.safeParse(
      makeStoredRecord({ reviewAt: null, reviewCompletedAt: null, reviewChecklist: null }),
    );
    expect(result.success).toBe(true);
  });

  it('parses a stored record with reviewAt/reviewCompletedAt/reviewChecklist all present', () => {
    const parsed = prepBriefRecordSchema.parse(
      makeStoredRecord({
        reviewAt: 1_700_000_000_000,
        reviewCompletedAt: 1_700_100_000_000,
        reviewChecklist: { attachVods: true },
      }),
    );
    expect(parsed.reviewAt).toBe(1_700_000_000_000);
    expect(parsed.reviewCompletedAt).toBe(1_700_100_000_000);
    expect(parsed.reviewChecklist).toEqual({ attachVods: true });
  });

  it('normalizePrepBriefRecord({..., reviewAt: null}) yields an object with NO reviewAt own-property (envelope wire-safety)', () => {
    const parsed = prepBriefRecordSchema.parse({
      eventDate: 1,
      activatedAt: 1,
      lastOpenedAt: 1,
      reviewAt: null,
    });
    const normalized = normalizePrepBriefRecord(parsed);
    expect('reviewAt' in normalized).toBe(false);
  });

  it('normalizePrepBriefRecord yields no reviewAt/reviewCompletedAt own-property when absent, and {} for reviewChecklist', () => {
    const parsed = prepBriefRecordSchema.parse(makeStoredRecord());
    const normalized = normalizePrepBriefRecord(parsed);
    expect('reviewAt' in normalized).toBe(false);
    expect('reviewCompletedAt' in normalized).toBe(false);
    expect(normalized.reviewChecklist).toEqual({});
  });

  it('normalizePrepBriefRecord carries reviewAt/reviewCompletedAt through when present', () => {
    const parsed = prepBriefRecordSchema.parse(
      makeStoredRecord({ reviewAt: 5, reviewCompletedAt: 6 }),
    );
    const normalized = normalizePrepBriefRecord(parsed);
    expect(normalized.reviewAt).toBe(5);
    expect(normalized.reviewCompletedAt).toBe(6);
  });
});

describe('REVIEW_CHECKLIST_ITEM_IDS', () => {
  it('is the fixed five-item tuple, in exact order', () => {
    expect(REVIEW_CHECKLIST_ITEM_IDS).toEqual([
      'attachVods',
      'addTimestamps',
      'tagTurningPoints',
      'reviewLosses',
      'updateOpponentNotes',
    ]);
  });
});

describe('deriveReviewAtCandidate (Phase 28, REV-01 owner-corrected trigger)', () => {
  it('synced entries (source: startgg) use lastSetAt exactly', () => {
    expect(
      deriveReviewAtCandidate({ source: 'startgg', firstSetAt: 1, lastSetAt: 1_700_000_000_000 }),
    ).toBe(1_700_000_000_000);
  });

  it('synced entries with source ABSENT (legacy startgg row) use lastSetAt exactly', () => {
    expect(
      deriveReviewAtCandidate({ source: undefined, firstSetAt: 1, lastSetAt: 1_700_000_000_000 }),
    ).toBe(1_700_000_000_000);
  });

  it('synced entries (source: parrygg) use lastSetAt exactly', () => {
    expect(
      deriveReviewAtCandidate({ source: 'parrygg', firstSetAt: 1, lastSetAt: 1_700_000_000_000 }),
    ).toBe(1_700_000_000_000);
  });

  it('manual entries use lastSetAt + 24h', () => {
    expect(
      deriveReviewAtCandidate({ source: 'manual', firstSetAt: 1, lastSetAt: 1_700_000_000_000 }),
    ).toBe(1_700_000_000_000 + 86_400_000);
  });

  it('degenerate lastSetAt 0 falls back to firstSetAt', () => {
    expect(
      deriveReviewAtCandidate({ source: 'startgg', firstSetAt: 1_600_000_000_000, lastSetAt: 0 }),
    ).toBe(1_600_000_000_000);
  });

  it('degenerate lastSetAt 0 with firstSetAt also 0 converts immediately (accepted, documented)', () => {
    expect(deriveReviewAtCandidate({ source: 'startgg', firstSetAt: 0, lastSetAt: 0 })).toBe(0);
  });
});

describe('prepBriefStatusSchema.reviewAt (Phase 28 deploy-order compatibility)', () => {
  it('accepts reviewAt absent', () => {
    const result = prepBriefStatusSchema.safeParse({ activated: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewAt).toBeUndefined();
    }
  });

  it('accepts reviewAt present', () => {
    const result = prepBriefStatusSchema.safeParse({ activated: true, reviewAt: 123 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewAt).toBe(123);
    }
  });
});
