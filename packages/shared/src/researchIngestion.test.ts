import { describe, expect, it } from 'vitest';
import {
  deriveSupplementProvenance,
  isPathSafeProviderId,
  isValidSupplementField,
  normalizeResearchClassificationCounts,
  normalizeResearchCounters,
  normalizeResearchNamedGaps,
  providerSecondsToMs,
  RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS,
  RESEARCH_PROJECTED_CLASSIFICATIONS,
  RESEARCH_SET_CLASSIFICATIONS,
  researchApiIdsSchema,
  researchCoveragePlayerSectionSchema,
  researchCoverageSnapshotSchema,
  researchIdentityConfirmedPlayerSchema,
  researchIdentityMappingSchema,
  researchIngestionCursorSchema,
  researchIngestionRunSchema,
  researchPageReceiptSchema,
  researchSourceSetRecordSchema,
  researchSupplementRecordSchema,
  researchTenantIngestionStateSchema,
  selectPrimaryConfirmedPlayerId,
} from './researchIngestion.js';

/**
 * A UUID-v4-SHAPED probe string (five hyphen-separated hex groups) generated
 * without `node:crypto` — this shared package must stay platform-agnostic
 * (imported by both the browser bundle and the API), so this test avoids a
 * node-only import for a case that only needs the SHAPE, not cryptographic
 * randomness.
 */
function makeUuidLikeProbe(): string {
  const hex = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  return `${hex().slice(0, 8)}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`;
}

function makeMinimalSourceSet(overrides: Record<string, unknown> = {}) {
  return {
    providerSetId: 'set-1',
    classification: 'complete',
    ruleId: 'rule-complete',
    apiIds: { setId: 'set-1' },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1_000,
    lastObservedAtMs: 1_000,
    ...overrides,
  };
}

function makeEmptyCounters() {
  return {};
}

function makeMinimalReceipt(overrides: Record<string, unknown> = {}) {
  return {
    page: 1,
    attempt: 0,
    stagedAtMs: 1_000,
    counters: makeEmptyCounters(),
    namedGaps: {},
    classificationCounts: {},
    uniqueCounters: {},
    uniqueNamedGaps: {},
    uniqueClassificationCounts: {},
    ...overrides,
  };
}

function makeMinimalRun(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    mode: 'full',
    playerId: 'player-1',
    requestedByUid: 'uid-1',
    startedAtMs: 1_000,
    ...overrides,
  };
}

function makeMinimalCoverageSection(overrides: Record<string, unknown> = {}) {
  return {
    playerId: 'player-1',
    runId: 'run-1',
    runCompletedAtMs: 1_000,
    asOfMs: 1_000,
    counters: {},
    namedGaps: {},
    dateCoverage: {},
    classificationCounts: {},
    uniqueCounters: {},
    uniqueNamedGaps: {},
    uniqueClassificationCounts: {},
    ...overrides,
  };
}

function makeMinimalTotals() {
  return { counters: {}, namedGaps: {}, dateCoverage: {}, classificationCounts: {} };
}

// ---------------------------------------------------------------------------
// isPathSafeProviderId (review C-H1)
// ---------------------------------------------------------------------------

describe('isPathSafeProviderId', () => {
  it('returns true for a randomUUID()-shaped string', () => {
    expect(isPathSafeProviderId(makeUuidLikeProbe())).toBe(true);
  });

  it('returns true for a fixed hyphen-bearing UUID literal', () => {
    expect(isPathSafeProviderId('a3f1c9d2-1111-4a2b-9c3d-000000000001')).toBe(true);
  });

  it('returns true for a numeric provider id', () => {
    expect(isPathSafeProviderId('12345')).toBe(true);
  });

  it('returns true for a 200-character safe string', () => {
    expect(isPathSafeProviderId('a'.repeat(200))).toBe(true);
  });

  it('returns true for a string containing a single space', () => {
    expect(isPathSafeProviderId('foo bar')).toBe(true);
  });

  it.each(['.', '#', '$', '[', ']', '/'])('returns false for the illegal character %s', (char) => {
    expect(isPathSafeProviderId(`foo${char}bar`)).toBe(false);
  });

  it('returns false for a U+0001 control character', () => {
    expect(isPathSafeProviderId(`foo${String.fromCharCode(0x01)}bar`)).toBe(false);
  });

  it('returns false for U+007F (DEL)', () => {
    expect(isPathSafeProviderId(`foo${String.fromCharCode(0x7f)}bar`)).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(isPathSafeProviderId('')).toBe(false);
  });

  it('returns false for a 201-character string', () => {
    expect(isPathSafeProviderId('a'.repeat(201))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidSupplementField (review C-H11)
// ---------------------------------------------------------------------------

describe('isValidSupplementField', () => {
  it('accepts "vodUrl" and "stage_note"', () => {
    expect(isValidSupplementField('vodUrl')).toBe(true);
    expect(isValidSupplementField('stage_note')).toBe(true);
  });

  it.each(['vod.url', 'a/b', 'a b', '', 'a'.repeat(65)])(
    'rejects the invalid field name %s',
    (value) => {
      expect(isValidSupplementField(value)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// providerSecondsToMs (review C-M3)
// ---------------------------------------------------------------------------

describe('providerSecondsToMs', () => {
  it('converts epoch seconds to epoch milliseconds', () => {
    expect(providerSecondsToMs(1_800_000_000)).toBe(1_800_000_000_000);
  });

  it('returns null for null', () => {
    expect(providerSecondsToMs(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(providerSecondsToMs(undefined)).toBeNull();
  });

  it('returns null for a non-finite value, never NaN or zero', () => {
    expect(providerSecondsToMs(Number.NaN)).toBeNull();
    expect(providerSecondsToMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// researchSourceSetRecordSchema
// ---------------------------------------------------------------------------

describe('researchSourceSetRecordSchema', () => {
  it('rejects {} (review C-H2a)', () => {
    expect(researchSourceSetRecordSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a minimally valid record with every optional member reported absent', () => {
    const parsed = researchSourceSetRecordSchema.parse(makeMinimalSourceSet());
    expect(parsed.storageKey).toBeUndefined();
    expect(parsed.subjectEntrantId).toBeUndefined();
    expect(parsed.opponentEntrantId).toBeUndefined();
    expect(parsed.games).toBeUndefined();
    expect(parsed.ingestionPage).toBeUndefined();
  });

  it.each([
    'classification',
    'ruleId',
    'providerSetId',
    'apiIds',
    'ingestionRunId',
    'fetchedAtMs',
    'lastObservedAtMs',
  ])('rejects a record missing %s', (member) => {
    const record = makeMinimalSourceSet();
    delete (record as Record<string, unknown>)[member];
    expect(researchSourceSetRecordSchema.safeParse(record).success).toBe(false);
  });

  it('accepts a record whose games is absent', () => {
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
  });

  it('accepts a record whose games is an empty array — a no-game set is valid, not an error', () => {
    expect(
      researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet({ games: [] })).success,
    ).toBe(true);
  });

  it('accepts subjectEntrantId/opponentEntrantId absent', () => {
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
  });

  it('accepts subjectEntrantId/opponentEntrantId present as strings', () => {
    const parsed = researchSourceSetRecordSchema.parse(
      makeMinimalSourceSet({ subjectEntrantId: 'e1', opponentEntrantId: 'e2' }),
    );
    expect(parsed.subjectEntrantId).toBe('e1');
    expect(parsed.opponentEntrantId).toBe('e2');
  });

  it('accepts ingestionPage as an integer >= 1 and as absent', () => {
    expect(
      researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet({ ingestionPage: 1 })).success,
    ).toBe(true);
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
  });

  it('rejects ingestionPage below 1', () => {
    expect(
      researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet({ ingestionPage: 0 })).success,
    ).toBe(false);
  });

  it('accepts baselineFingerprint absent and as a string', () => {
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
    expect(
      researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet({ baselineFingerprint: 'fp-1' }))
        .success,
    ).toBe(true);
  });

  it('accepts firstIngestionPlayerId absent and as a string, rejects one over 64 characters (review C3-A5)', () => {
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
    expect(
      researchSourceSetRecordSchema.safeParse(
        makeMinimalSourceSet({ firstIngestionPlayerId: 'p1' }),
      ).success,
    ).toBe(true);
    expect(
      researchSourceSetRecordSchema.safeParse(
        makeMinimalSourceSet({ firstIngestionPlayerId: 'a'.repeat(65) }),
      ).success,
    ).toBe(false);
  });

  it('accepts providerKeyDerived: true together with a storageKey that differs from providerSetId, and both absent for the ordinary case (review C2-A7)', () => {
    expect(
      researchSourceSetRecordSchema.safeParse(
        makeMinimalSourceSet({ providerKeyDerived: true, storageKey: 'derived-key' }),
      ).success,
    ).toBe(true);
    expect(researchSourceSetRecordSchema.safeParse(makeMinimalSourceSet()).success).toBe(true);
  });

  it('round-trips a record built by conditional spread (absent members simply not present)', () => {
    const includeVodUrl = false;
    const spread: Record<string, unknown> = {
      providerSetId: 'set-2',
      classification: 'dq',
      ruleId: 'rule-dq',
      apiIds: { setId: 'set-2' },
      ingestionRunId: 'run-2',
      fetchedAtMs: 2_000,
      lastObservedAtMs: 2_000,
      ...(includeVodUrl ? { vodUrl: 'https://example.com/vod' } : {}),
    };
    const first = researchSourceSetRecordSchema.parse(spread);
    const second = researchSourceSetRecordSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
  });

  it('accepts a provider crew-battle record with ten participants per entrant', () => {
    const participants = Array.from({ length: 10 }, (_, index) => ({
      playerId: String(index + 1),
      gamerTag: `Player ${index + 1}`,
    }));
    expect(
      researchSourceSetRecordSchema.safeParse(
        makeMinimalSourceSet({
          classification: 'non-ssbu',
          entrants: [
            { entrantId: 'team-1', participants },
            { entrantId: 'team-2', participants },
          ],
          apiIds: {
            setId: 'crew-battle',
            playerIds: Array.from({ length: 20 }, (_, index) => String(index + 1)),
          },
        }),
      ).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// researchApiIdsSchema
// ---------------------------------------------------------------------------

describe('researchApiIdsSchema', () => {
  it('requires setId', () => {
    expect(researchApiIdsSchema.safeParse({}).success).toBe(false);
    expect(researchApiIdsSchema.safeParse({ setId: 'x' }).success).toBe(true);
  });

  it('rejects an entrantIds array over 16 members', () => {
    expect(
      researchApiIdsSchema.safeParse({
        setId: 'x',
        entrantIds: Array.from({ length: 17 }, (_, i) => String(i)),
      }).success,
    ).toBe(false);
  });

  it('accepts the player-id fanout of a provider crew battle', () => {
    expect(
      researchApiIdsSchema.safeParse({
        setId: 'crew-battle',
        playerIds: Array.from({ length: 20 }, (_, index) => String(index + 1)),
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// researchIngestionRunSchema (leases, receipts, staged bundles)
// ---------------------------------------------------------------------------

describe('researchIngestionRunSchema', () => {
  it('accepts status: running with no cursor, stagedCounters, stagedClassificationCounts, or lease', () => {
    const parsed = researchIngestionRunSchema.parse(makeMinimalRun());
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.stagedCounters).toBeUndefined();
    expect(parsed.stagedClassificationCounts).toBeUndefined();
    expect(parsed.lease).toBeUndefined();
  });

  it('rejects an unrecognized status value', () => {
    expect(researchIngestionRunSchema.safeParse(makeMinimalRun({ status: 'bogus' })).success).toBe(
      false,
    );
  });

  it('accepts a lease of { ownerId, acquiredAtMs, expiresAtMs, fence } and rejects fence below 1', () => {
    expect(
      researchIngestionRunSchema.safeParse(
        makeMinimalRun({
          lease: { ownerId: 'holder-1', acquiredAtMs: 1, expiresAtMs: 2, fence: 1 },
        }),
      ).success,
    ).toBe(true);
    expect(
      researchIngestionRunSchema.safeParse(
        makeMinimalRun({
          lease: { ownerId: 'holder-1', acquiredAtMs: 1, expiresAtMs: 2, fence: 0 },
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts leaseFenceCounter as absent on a fresh run and as an integer >= 1 on a leased run; rejects negative (review C2-H1)', () => {
    expect(researchIngestionRunSchema.safeParse(makeMinimalRun()).success).toBe(true);
    expect(
      researchIngestionRunSchema.safeParse(makeMinimalRun({ leaseFenceCounter: 1 })).success,
    ).toBe(true);
    expect(
      researchIngestionRunSchema.safeParse(makeMinimalRun({ leaseFenceCounter: -1 })).success,
    ).toBe(false);
  });

  it('parses a run carrying leaseFenceCounter with NO lease member — the post-release state (review C2-H1)', () => {
    const parsed = researchIngestionRunSchema.parse(makeMinimalRun({ leaseFenceCounter: 7 }));
    expect(parsed.leaseFenceCounter).toBe(7);
    expect(parsed.lease).toBeUndefined();
  });

  it('accepts a pendingPageReceipt and rejects one whose page is below 1', () => {
    expect(
      researchIngestionRunSchema.safeParse(
        makeMinimalRun({ pendingPageReceipt: makeMinimalReceipt() }),
      ).success,
    ).toBe(true);
    expect(
      researchIngestionRunSchema.safeParse(
        makeMinimalRun({ pendingPageReceipt: makeMinimalReceipt({ page: 0 }) }),
      ).success,
    ).toBe(false);
  });

  it('accepts coveragePublishedAtMs as absent on a completed run (review C-H8)', () => {
    const parsed = researchIngestionRunSchema.parse(
      makeMinimalRun({ status: 'completed', completedAtMs: 5_000 }),
    );
    expect(parsed.coveragePublishedAtMs).toBeUndefined();
  });

  it('declares stagedClassificationCounts, stagedUniqueCounters, stagedUniqueNamedGaps, stagedUniqueClassificationCounts', () => {
    const parsed = researchIngestionRunSchema.parse(
      makeMinimalRun({
        stagedClassificationCounts: { complete: 1 },
        stagedUniqueCounters: { imported: 1 },
        stagedUniqueNamedGaps: { unknownStage: 1 },
        stagedUniqueClassificationCounts: { complete: 1 },
      }),
    );
    expect(parsed.stagedClassificationCounts).toEqual({ complete: 1 });
    expect(parsed.stagedUniqueCounters).toEqual({ imported: 1 });
    expect(parsed.stagedUniqueNamedGaps).toEqual({ unknownStage: 1 });
    expect(parsed.stagedUniqueClassificationCounts).toEqual({ complete: 1 });
  });
});

// ---------------------------------------------------------------------------
// researchIngestionCursorSchema (Dead-PREFIX extension, decided by Codex
// advisor as product-owner proxy, 2026-08-08 — the durable streak safeguard)
// ---------------------------------------------------------------------------

describe('researchIngestionCursorSchema', () => {
  it('accepts a cursor with consecutiveUnavailablePages absent (house convention: absent means zero)', () => {
    const parsed = researchIngestionCursorSchema.parse({ page: 1 });
    expect(parsed.consecutiveUnavailablePages).toBeUndefined();
  });

  it('accepts a nonnegative integer consecutiveUnavailablePages', () => {
    const parsed = researchIngestionCursorSchema.parse({
      page: 5,
      consecutiveUnavailablePages: 12,
    });
    expect(parsed.consecutiveUnavailablePages).toBe(12);
  });

  it('rejects a negative consecutiveUnavailablePages', () => {
    expect(
      researchIngestionCursorSchema.safeParse({ page: 1, consecutiveUnavailablePages: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer consecutiveUnavailablePages', () => {
    expect(
      researchIngestionCursorSchema.safeParse({ page: 1, consecutiveUnavailablePages: 1.5 })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// researchPageReceiptSchema (review C3-A4, C3-A5)
// ---------------------------------------------------------------------------

describe('researchPageReceiptSchema', () => {
  it('accepts a receipt with earliestSetAtMs, latestSetAtMs, and observedMaxUpdatedAtSeconds absent', () => {
    const parsed = researchPageReceiptSchema.parse(makeMinimalReceipt());
    expect(parsed.earliestSetAtMs).toBeUndefined();
    expect(parsed.latestSetAtMs).toBeUndefined();
    expect(parsed.observedMaxUpdatedAtSeconds).toBeUndefined();
  });

  it.each(['page', 'attempt', 'stagedAtMs'])('rejects a receipt missing %s', (member) => {
    const receipt = makeMinimalReceipt();
    delete (receipt as Record<string, unknown>)[member];
    expect(researchPageReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('accepts a receipt whose earliestSetAtMs and latestSetAtMs DIFFER — carrying both ends of one page (review C3-A4)', () => {
    const parsed = researchPageReceiptSchema.parse(
      makeMinimalReceipt({ earliestSetAtMs: 1_000, latestSetAtMs: 9_000 }),
    );
    expect(parsed.earliestSetAtMs).toBe(1_000);
    expect(parsed.latestSetAtMs).toBe(9_000);
  });

  it('has no single date-sample member — a grep for a singular date-sample name finds nothing', () => {
    const source = researchPageReceiptSchema.toString();
    expect(source).not.toMatch(/dateCoverageSampleMs/);
  });

  it('accepts a receipt whose three unique* bundles are absent, and one where they are present and element-wise no greater than the observation bundles', () => {
    expect(researchPageReceiptSchema.safeParse(makeMinimalReceipt()).success).toBe(true);
    const withUnique = researchPageReceiptSchema.parse(
      makeMinimalReceipt({
        counters: { imported: 5 },
        uniqueCounters: { imported: 3 },
      }),
    );
    expect(withUnique.uniqueCounters?.imported).toBeLessThanOrEqual(
      withUnique.counters?.imported ?? 0,
    );
  });
});

// ---------------------------------------------------------------------------
// researchTenantIngestionStateSchema
// ---------------------------------------------------------------------------

describe('researchTenantIngestionStateSchema', () => {
  it('parses when every optional field is absent', () => {
    expect(researchTenantIngestionStateSchema.safeParse({}).success).toBe(true);
  });

  it('parses a runs map keyed by runId', () => {
    const parsed = researchTenantIngestionStateSchema.parse({
      activeRunId: 'run-1',
      runs: { 'run-1': makeMinimalRun() },
    });
    expect(parsed.runs?.['run-1']?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// researchIdentityMappingSchema / selectPrimaryConfirmedPlayerId (D-10, D-11, review C-M4)
// ---------------------------------------------------------------------------

describe('researchIdentityMappingSchema', () => {
  it('parses when every optional field is absent', () => {
    expect(researchIdentityMappingSchema.safeParse({}).success).toBe(true);
  });

  it('parses multiple confirmed player ids', () => {
    const parsed = researchIdentityMappingSchema.parse({
      confirmedPlayerIds: {
        p1: {
          playerId: 'p1',
          primary: true,
          confirmedByUid: 'admin-1',
          confirmedAtMs: 1,
        },
        p2: {
          playerId: 'p2',
          confirmedByUid: 'admin-1',
          confirmedAtMs: 1,
        },
      },
    });
    expect(Object.keys(parsed.confirmedPlayerIds ?? {})).toHaveLength(2);
  });
});

describe('researchIdentityConfirmedPlayerSchema', () => {
  it('rejects a knownTagVariants array over 50 members', () => {
    expect(
      researchIdentityConfirmedPlayerSchema.safeParse({
        playerId: 'p1',
        confirmedByUid: 'admin-1',
        confirmedAtMs: 1,
        knownTagVariants: Array.from({ length: 51 }, (_, i) => `tag-${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('selectPrimaryConfirmedPlayerId', () => {
  it('returns the playerId of the entry marked primary', () => {
    expect(
      selectPrimaryConfirmedPlayerId({
        p1: { playerId: 'p1', confirmedByUid: 'a', confirmedAtMs: 1 },
        p2: { playerId: 'p2', primary: true, confirmedByUid: 'a', confirmedAtMs: 1 },
      }),
    ).toBe('p2');
  });

  it('returns null when absent or no entry is marked primary', () => {
    expect(selectPrimaryConfirmedPlayerId(undefined)).toBeNull();
    expect(
      selectPrimaryConfirmedPlayerId({
        p1: { playerId: 'p1', confirmedByUid: 'a', confirmedAtMs: 1 },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// researchSupplementRecordSchema (D-05, review C-H11, T-30-01-03)
// ---------------------------------------------------------------------------

describe('researchSupplementRecordSchema', () => {
  function makeSupplement(overrides: Record<string, unknown> = {}) {
    return {
      sourceKind: 'manual',
      targetSetId: 'set-1',
      field: 'vodUrl',
      value: 'https://youtu.be/abc',
      attributedToUid: 'admin-1',
      recordedAtMs: 1_000,
      ...overrides,
    };
  }

  // Deliberately RETAINED under the ENR-13 corrected model (Phase 30.2): the
  // enum still has no provider member — a Liquipedia observation lives on
  // `researchEnrichmentObservationRecordSchema` instead, never here.
  it('rejects sourceKind: startgg', () => {
    expect(
      researchSupplementRecordSchema.safeParse(makeSupplement({ sourceKind: 'startgg' })).success,
    ).toBe(false);
  });

  it.each(['vod.url', 'a/b', 'a b', '', 'a'.repeat(65)])(
    'rejects an invalid field of %s',
    (field) => {
      expect(researchSupplementRecordSchema.safeParse(makeSupplement({ field })).success).toBe(
        false,
      );
    },
  );

  it.each(['vodUrl', 'stage_note'])('accepts a valid field of %s', (field) => {
    expect(researchSupplementRecordSchema.safeParse(makeSupplement({ field })).success).toBe(true);
  });

  it('requires attributedToUid and recordedAtMs (never nullish)', () => {
    const supplement = makeSupplement();
    delete (supplement as Record<string, unknown>).attributedToUid;
    expect(researchSupplementRecordSchema.safeParse(supplement).success).toBe(false);
  });

  it('rejects a non-http(s) vodUrl', () => {
    expect(
      researchSupplementRecordSchema.safeParse(makeSupplement({ vodUrl: 'javascript:alert(1)' }))
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ENR-13 (Phase 30.2): supplement provenance/content-type correction —
// existing records preserved byte-for-byte at their existing keys, new
// members additive-only, no re-keying.
// ---------------------------------------------------------------------------

describe('ENR-13: supplement provenance/content-type correction', () => {
  /** The EXACT shape the shipped writer produces today — no sourceOrigin, no contentType, no rawValue, no canonicalValue, no observedAtMs. */
  function makeLegacySupplement(overrides: Record<string, unknown> = {}) {
    return {
      sourceKind: 'manual',
      targetSetId: 'set-1',
      field: 'notes',
      value: 'played it safe on stage 2',
      attributedToUid: 'admin-1',
      recordedAtMs: 1_000,
      ...overrides,
    };
  }

  it('parses a legacy manual record exactly as shipped, and deriveSupplementProvenance derives origin manual / contentType note / explicit false', () => {
    const parsed = researchSupplementRecordSchema.parse(makeLegacySupplement());
    expect(deriveSupplementProvenance(parsed)).toEqual({
      origin: 'manual',
      contentType: 'note',
      explicit: false,
    });
  });

  it('parses a legacy vod record exactly as shipped, and deriveSupplementProvenance derives origin manual / contentType vod-reference / explicit false', () => {
    const parsed = researchSupplementRecordSchema.parse(
      makeLegacySupplement({
        sourceKind: 'vod',
        field: 'vodUrl',
        value: 'https://youtu.be/abc',
      }),
    );
    expect(deriveSupplementProvenance(parsed)).toEqual({
      origin: 'manual',
      contentType: 'vod-reference',
      explicit: false,
    });
  });

  it('returns the explicit dimensions with explicit: true for a record that writes them itself', () => {
    const parsed = researchSupplementRecordSchema.parse(
      makeLegacySupplement({ sourceOrigin: 'manual', contentType: 'note' }),
    );
    expect(deriveSupplementProvenance(parsed)).toEqual({
      origin: 'manual',
      contentType: 'note',
      explicit: true,
    });
  });

  it('rejects an explicit contentType that disagrees with the value implied by sourceKind', () => {
    expect(
      researchSupplementRecordSchema.safeParse(
        makeLegacySupplement({ sourceKind: 'manual', contentType: 'vod-reference' }),
      ).success,
    ).toBe(false);
    expect(
      researchSupplementRecordSchema.safeParse(
        makeLegacySupplement({ sourceKind: 'vod', field: 'vodUrl', contentType: 'note' }),
      ).success,
    ).toBe(false);
  });

  it('rejects liquipedia as a sourceOrigin value — this tree cannot claim provider authorship', () => {
    expect(
      researchSupplementRecordSchema.safeParse(makeLegacySupplement({ sourceOrigin: 'liquipedia' }))
        .success,
    ).toBe(false);
  });

  it('parses a record carrying rawValue and canonicalValue, both absent-tolerant', () => {
    expect(
      researchSupplementRecordSchema.safeParse(
        makeLegacySupplement({ rawValue: 'raw text', canonicalValue: 'canonical text' }),
      ).success,
    ).toBe(true);
    expect(researchSupplementRecordSchema.safeParse(makeLegacySupplement()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// researchCoveragePlayerSectionSchema / researchCoverageSnapshotSchema (D-15, D-16, C2-H3, C2-H4, C3-A5)
// ---------------------------------------------------------------------------

describe('researchCoveragePlayerSectionSchema', () => {
  it('requires playerId, runId, runCompletedAtMs, and asOfMs', () => {
    for (const member of ['playerId', 'runId', 'runCompletedAtMs', 'asOfMs']) {
      const section = makeMinimalCoverageSection();
      delete (section as Record<string, unknown>)[member];
      expect(researchCoveragePlayerSectionSchema.safeParse(section).success).toBe(false);
    }
    expect(
      researchCoveragePlayerSectionSchema.safeParse(makeMinimalCoverageSection()).success,
    ).toBe(true);
  });

  it('requires BOTH the observation bundle and the unique bundle — a section missing either fails to parse (review C3-A5)', () => {
    for (const member of [
      'counters',
      'namedGaps',
      'classificationCounts',
      'uniqueCounters',
      'uniqueNamedGaps',
      'uniqueClassificationCounts',
    ]) {
      const section = makeMinimalCoverageSection();
      delete (section as Record<string, unknown>)[member];
      expect(researchCoveragePlayerSectionSchema.safeParse(section).success).toBe(false);
    }
  });

  it('accepts a classificationCounts record whose keys are members of RESEARCH_SET_CLASSIFICATIONS and rejects an unknown key', () => {
    expect(
      researchCoveragePlayerSectionSchema.safeParse(
        makeMinimalCoverageSection({ classificationCounts: { complete: 3, dq: 1 } }),
      ).success,
    ).toBe(true);
    expect(
      researchCoveragePlayerSectionSchema.safeParse(
        makeMinimalCoverageSection({ classificationCounts: { bogus: 1 } }),
      ).success,
    ).toBe(false);
  });
});

describe('researchCoverageSnapshotSchema', () => {
  it('accepts a players map with two playerId sections', () => {
    const parsed = researchCoverageSnapshotSchema.parse({
      asOfMs: 1_000,
      players: {
        p1: makeMinimalCoverageSection({ playerId: 'p1' }),
        p2: makeMinimalCoverageSection({ playerId: 'p2' }),
      },
      totals: makeMinimalTotals(),
    });
    expect(Object.keys(parsed.players)).toHaveLength(2);
  });

  it('rejects a snapshot whose players map is absent', () => {
    expect(
      researchCoverageSnapshotSchema.safeParse({ asOfMs: 1_000, totals: makeMinimalTotals() })
        .success,
    ).toBe(false);
  });

  it('rejects a snapshot whose totals member is absent (review C2-H3)', () => {
    expect(
      researchCoverageSnapshotSchema.safeParse({
        asOfMs: 1_000,
        players: { p1: makeMinimalCoverageSection({ playerId: 'p1' }) },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

describe('normalizeResearchCounters', () => {
  it('returns every counter as 0 for undefined', () => {
    expect(normalizeResearchCounters(undefined)).toEqual({
      discoveredAllGames: 0,
      discoveredEligible: 0,
      imported: 0,
      skipped: 0,
      unresolved: 0,
      corrected: 0,
      providerUnavailablePages: 0,
      providerUnavailableRowEstimate: 0,
    });
  });

  it('returns imported: 3 with the rest 0', () => {
    expect(normalizeResearchCounters({ imported: 3 })).toEqual({
      discoveredAllGames: 0,
      discoveredEligible: 0,
      imported: 3,
      skipped: 0,
      unresolved: 0,
      corrected: 0,
      providerUnavailablePages: 0,
      providerUnavailableRowEstimate: 0,
    });
  });

  it('returns providerUnavailablePages/providerUnavailableRowEstimate with the rest 0 (provider-dead-page carve-out)', () => {
    expect(
      normalizeResearchCounters({
        providerUnavailablePages: 1,
        providerUnavailableRowEstimate: 3,
      }),
    ).toEqual({
      discoveredAllGames: 0,
      discoveredEligible: 0,
      imported: 0,
      skipped: 0,
      unresolved: 0,
      corrected: 0,
      providerUnavailablePages: 1,
      providerUnavailableRowEstimate: 3,
    });
  });
});

describe('normalizeResearchNamedGaps', () => {
  it('returns every gap as 0 for undefined', () => {
    expect(normalizeResearchNamedGaps(undefined).unknownStage).toBe(0);
  });
});

describe('normalizeResearchClassificationCounts', () => {
  it('returns one member per RESEARCH_SET_CLASSIFICATIONS entry, zero for every absent classification', () => {
    const result = normalizeResearchClassificationCounts({ complete: 5 });
    expect(Object.keys(result)).toHaveLength(RESEARCH_SET_CLASSIFICATIONS.length);
    expect(result.complete).toBe(5);
    expect(result.dq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary invariants
// ---------------------------------------------------------------------------

describe('vocabulary invariants', () => {
  it('RESEARCH_PROJECTED_CLASSIFICATIONS contains exactly one member', () => {
    expect(RESEARCH_PROJECTED_CLASSIFICATIONS).toHaveLength(1);
  });

  it('every RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS member is a member of RESEARCH_SET_CLASSIFICATIONS and none is in RESEARCH_PROJECTED_CLASSIFICATIONS', () => {
    for (const classification of RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS) {
      expect((RESEARCH_SET_CLASSIFICATIONS as readonly string[]).includes(classification)).toBe(
        true,
      );
      expect(
        (RESEARCH_PROJECTED_CLASSIFICATIONS as readonly string[]).includes(classification),
      ).toBe(false);
    }
  });

  it('RESEARCH_SET_CLASSIFICATIONS contains no-game-detail (review C-H4)', () => {
    expect(RESEARCH_SET_CLASSIFICATIONS).toContain('no-game-detail');
  });
});

// ---------------------------------------------------------------------------
// Bounds (review C-M5)
// ---------------------------------------------------------------------------

describe('length bounds', () => {
  it('rejects an over-length provider name (gamerTag)', () => {
    expect(
      researchSourceSetRecordSchema.safeParse(
        makeMinimalSourceSet({
          entrants: [
            {
              entrantId: 'e1',
              participants: [{ gamerTag: 'a'.repeat(501) }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects an over-length supplement value', () => {
    expect(
      researchSupplementRecordSchema.safeParse({
        sourceKind: 'manual',
        targetSetId: 'set-1',
        field: 'stage_note',
        value: 'a'.repeat(2001),
        attributedToUid: 'admin-1',
        recordedAtMs: 1_000,
      }).success,
    ).toBe(false);
  });

  it('rejects a 51-member knownTagVariants array', () => {
    expect(
      researchIdentityConfirmedPlayerSchema.safeParse({
        playerId: 'p1',
        confirmedByUid: 'admin-1',
        confirmedAtMs: 1,
        knownTagVariants: Array.from({ length: 51 }, (_, i) => `tag-${i}`),
      }).success,
    ).toBe(false);
  });
});
