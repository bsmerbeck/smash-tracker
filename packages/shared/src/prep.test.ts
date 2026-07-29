import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, X_EVENT_ALLOWLIST } from './events.js';
import {
  normalizePrepBriefRecord,
  PREP_CHECKLIST_ITEM_IDS,
  prepBriefRecordSchema,
  prepOpenRequestSchema,
  type PrepBriefRecord,
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
