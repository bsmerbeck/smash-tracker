import { describe, expect, it, vi } from 'vitest';
import {
  buildEnrichmentObservationId,
  normalizeResearchEnrichmentCohortCounts,
  normalizeResearchEnrichmentCounts,
  RESEARCH_ENRICHMENT_MATCH_STATUSES,
  RESEARCH_LIQUIPEDIA_STAGE_FORMS,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentAttributionResponseSchema,
  researchEnrichmentCohortCountsSchema,
  researchEnrichmentConfirmRequestSchema,
  researchEnrichmentCountsSchema,
  researchEnrichmentCoverageResponseSchema,
  researchEnrichmentCoverageSnapshotSchema,
  researchEnrichmentObservationRecordSchema,
  researchEnrichmentReviewQueueResponseSchema,
  researchEnrichmentProjectionStateRecordSchema,
  researchEnrichmentResolutionReceiptRecordSchema,
} from './researchEnrichment.js';

/**
 * A dependency-free, deterministic pseudo-hash (FNV-1a-style), producing a
 * 64-char lowercase-hex digest that changes whenever the input changes. This
 * shared package must stay platform-agnostic (imported by both the browser
 * bundle and the API), so this test avoids `node:crypto` for the same
 * reason `researchIngestion.test.ts`'s `makeUuidLikeProbe` does — the test
 * only needs a hex digest with the right SHAPE and change-sensitivity, not
 * cryptographic strength.
 */
function fakeHashHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return hex.repeat(8).slice(0, 64);
}

function makeFullObservation(overrides: Record<string, unknown> = {}) {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles_Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 12345,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-match2@1',
    templateFamily: 'match2',
    fetchedAtMs: 1_000,
    observedAtMs: 1_000,
    matchingStatus: 'matched',
    sourceSha1: 'b'.repeat(40),
    bracketTemplate: 'Bracket/32',
    bracketKey: 'R1M1',
    game: 'ultimate',
    tournamentPageTitle: 'Supernova/2026',
    tournamentPageUrl: 'https://liquipedia.net/smash/Supernova/2026',
    tournamentDisplayName: 'Supernova 2026',
    tournamentStartggSlug: 'tournament/supernova-2026',
    sectionHeading: 'Singles Bracket',
    derivedRoundLabel: 'Grand Final',
    rawDate: 'May 17, 2026',
    date: '2026-05-17',
    rawScores: ['3', '2'],
    scores: [3, 2],
    setWinnerSeat: 1,
    setWinnerDerived: true,
    isBracketReset: false,
    vodInheritedFromBracketKey: 'R1M1',
    rawVodUrl: 'https://youtu.be/abc',
    vodUrl: 'https://youtu.be/abc',
    players: [
      { rawTag: 'Sparg0', canonicalPage: 'Sparg0', flag: 'us' },
      { rawTag: 'Tweek', canonicalPage: 'Tweek', flag: 'us' },
    ],
    games: [
      {
        ordinal: 1,
        rawStage: 'Battlefield',
        stageForm: 'normal',
        canonicalStageId: 3,
        rawChars: ['Cloud', 'Wolf'],
        stocks: [3, 0],
        winnerSeat: 1,
      },
    ],
    candidateTargetSetIds: ['set-1'],
    resolutionReasons: ['unique high-confidence match on event/date/players/score'],
    sourcePageMissing: false,
    extractionFailed: false,
    ...overrides,
  };
}

function makeMinimalObservation(overrides: Record<string, unknown> = {}) {
  return {
    observationId: 'obs-2',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'vod-reference',
    sourcePageTitle: 'Sparg0/VODs',
    sourcePageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
    sourceRevisionId: 1,
    sourceContentHash: 'c'.repeat(64),
    parserVersion: 'liquipedia-vodlist@1',
    templateFamily: 'vodlist',
    fetchedAtMs: 1_000,
    observedAtMs: 1_000,
    matchingStatus: 'unmatched',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// researchEnrichmentObservationRecordSchema
// ---------------------------------------------------------------------------

describe('researchEnrichmentObservationRecordSchema', () => {
  it('parses a fully populated observation record and round-trips every member', () => {
    const input = makeFullObservation();
    const parsed = researchEnrichmentObservationRecordSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('parses a record missing an optional member, leaving that member absent (never null)', () => {
    const parsed = researchEnrichmentObservationRecordSchema.parse(makeMinimalObservation());
    expect('bracketTemplate' in parsed).toBe(false);
    expect(parsed.bracketTemplate).toBeUndefined();
  });

  it('accepts sourceProvider liquipedia', () => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ sourceProvider: 'liquipedia' }),
      ).success,
    ).toBe(true);
  });

  it('rejects sourceProvider manual', () => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ sourceProvider: 'manual' }),
      ).success,
    ).toBe(false);
  });

  it.each(['stage-observation', 'vod-reference'])('accepts contentType %s', (contentType) => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(makeMinimalObservation({ contentType }))
        .success,
    ).toBe(true);
  });

  it('rejects contentType note (a manual-only content type)', () => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ contentType: 'note' }),
      ).success,
    ).toBe(false);
  });

  it.each(RESEARCH_ENRICHMENT_MATCH_STATUSES)('accepts matchingStatus %s', (matchingStatus) => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ matchingStatus }),
      ).success,
    ).toBe(true);
  });

  it('rejects an unrecognized matchingStatus', () => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ matchingStatus: 'bogus' }),
      ).success,
    ).toBe(false);
  });

  it.each(RESEARCH_LIQUIPEDIA_STAGE_FORMS)('accepts stageForm %s on a game entry', (stageForm) => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ games: [{ ordinal: 1, stageForm }] }),
      ).success,
    ).toBe(true);
  });

  it('rejects an unrecognized stageForm on a game entry', () => {
    expect(
      researchEnrichmentObservationRecordSchema.safeParse(
        makeMinimalObservation({ games: [{ ordinal: 1, stageForm: 'bogus' }] }),
      ).success,
    ).toBe(false);
  });

  it('parses a game entry with rawStage present and canonicalStageId absent (unknown stays unknown)', () => {
    const parsed = researchEnrichmentObservationRecordSchema.parse(
      makeMinimalObservation({ games: [{ ordinal: 1, rawStage: 'Φ' }] }),
    );
    expect(parsed.games?.[0]?.rawStage).toBe('Φ');
    expect('canonicalStageId' in (parsed.games?.[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// researchEnrichmentAttachmentRecordSchema
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    observationId: 'obs-1',
    targetSetId: 'set-1',
    attachmentSource: 'admin',
    attachedAtMs: 1_000,
    sourceRevisionId: 1,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-match2@1',
    ...overrides,
  };
}

describe('researchEnrichmentAttachmentRecordSchema', () => {
  it('accepts an admin attachment with confirmedByUid and confirmedAtMs', () => {
    expect(
      researchEnrichmentAttachmentRecordSchema.safeParse(
        makeAttachment({ confirmedByUid: 'admin-1', confirmedAtMs: 1_000 }),
      ).success,
    ).toBe(true);
  });

  it('rejects an admin attachment missing confirmedByUid', () => {
    expect(
      researchEnrichmentAttachmentRecordSchema.safeParse(makeAttachment({ confirmedAtMs: 1_000 }))
        .success,
    ).toBe(false);
  });

  it('rejects an admin attachment missing confirmedAtMs', () => {
    expect(
      researchEnrichmentAttachmentRecordSchema.safeParse(
        makeAttachment({ confirmedByUid: 'admin-1' }),
      ).success,
    ).toBe(false);
  });

  it('accepts a resolver attachment with a receiptId', () => {
    expect(
      researchEnrichmentAttachmentRecordSchema.safeParse(
        makeAttachment({ attachmentSource: 'resolver', receiptId: 'receipt-1' }),
      ).success,
    ).toBe(true);
  });

  it('rejects a resolver attachment without a receiptId', () => {
    expect(
      researchEnrichmentAttachmentRecordSchema.safeParse(
        makeAttachment({ attachmentSource: 'resolver' }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildEnrichmentObservationId
// ---------------------------------------------------------------------------

describe('buildEnrichmentObservationId', () => {
  const base = {
    sourcePageTitle: 'Supernova/2026',
    parserVersion: 'liquipedia-bracket-match2@1',
    discriminator: 'R1M1',
  };

  it('returns the identical id for identical source coordinates', () => {
    expect(buildEnrichmentObservationId(base, fakeHashHex)).toBe(
      buildEnrichmentObservationId({ ...base }, fakeHashHex),
    );
  });

  it('returns a different id when any coordinate changes', () => {
    const baseId = buildEnrichmentObservationId(base, fakeHashHex);
    expect(buildEnrichmentObservationId({ ...base, discriminator: 'R1M2' }, fakeHashHex)).not.toBe(
      baseId,
    );
    expect(
      buildEnrichmentObservationId(
        { ...base, parserVersion: 'liquipedia-bracket-legacy@1' },
        fakeHashHex,
      ),
    ).not.toBe(baseId);
    expect(
      buildEnrichmentObservationId({ ...base, sourcePageTitle: 'Supernova/2025' }, fakeHashHex),
    ).not.toBe(baseId);
  });

  it('returns an id containing only lowercase hex characters, 32 characters long', () => {
    const id = buildEnrichmentObservationId(base, fakeHashHex);
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// researchEnrichmentProjectionStateRecordSchema
// ---------------------------------------------------------------------------

function makeProjectionState(overrides: Record<string, unknown> = {}) {
  return {
    matchKey: 'match-1',
    targetSetId: 'set-1',
    ...overrides,
  };
}

describe('researchEnrichmentProjectionStateRecordSchema', () => {
  it('parses a record with a stage witness but no VOD witness', () => {
    expect(
      researchEnrichmentProjectionStateRecordSchema.safeParse(
        makeProjectionState({
          projectedStageId: 3,
          projectedStageName: 'Battlefield',
          stageObservationId: 'obs-1',
          stageSourceRevisionId: 1,
          stageParserVersion: 'liquipedia-bracket-match2@1',
          stageProjectedAtMs: 1_000,
        }),
      ).success,
    ).toBe(true);
  });

  it('parses a record carrying only the pending half of the witness', () => {
    expect(
      researchEnrichmentProjectionStateRecordSchema.safeParse(
        makeProjectionState({
          pendingVodUrl: 'https://youtu.be/x',
          pendingVodObservationId: 'obs-1',
          pendingWriteStartedAtMs: 1_000,
        }),
      ).success,
    ).toBe(true);
  });

  it('parses a record carrying both the committed and the pending half', () => {
    expect(
      researchEnrichmentProjectionStateRecordSchema.safeParse(
        makeProjectionState({
          projectedVodUrl: 'https://youtu.be/x',
          vodObservationId: 'obs-1',
          pendingVodUrl: 'https://youtu.be/y',
          pendingVodObservationId: 'obs-2',
          pendingWriteStartedAtMs: 1_000,
        }),
      ).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// researchEnrichmentResolutionReceiptRecordSchema
// ---------------------------------------------------------------------------

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-1',
    observationId: 'obs-1',
    targetSetId: 'set-1',
    confidence: 'high',
    resolvedAtMs: 1_000,
    resolverVersion: 'resolver@1',
    sourceRevisionId: 1,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-match2@1',
    candidateTargetSetIds: ['set-1'],
    ...overrides,
  };
}

describe('researchEnrichmentResolutionReceiptRecordSchema', () => {
  it('parses a receipt whose sole candidate equals its own targetSetId', () => {
    expect(researchEnrichmentResolutionReceiptRecordSchema.safeParse(makeReceipt()).success).toBe(
      true,
    );
  });

  it('rejects a receipt with more than one candidate', () => {
    expect(
      researchEnrichmentResolutionReceiptRecordSchema.safeParse(
        makeReceipt({ candidateTargetSetIds: ['set-1', 'set-2'] }),
      ).success,
    ).toBe(false);
  });

  it('rejects a receipt naming a target outside its own candidate list', () => {
    expect(
      researchEnrichmentResolutionReceiptRecordSchema.safeParse(
        makeReceipt({ candidateTargetSetIds: ['set-2'] }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// researchEnrichmentCoverageSnapshotSchema
// ---------------------------------------------------------------------------

function makeCoverageSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    asOfMs: 1_000,
    runId: 'run-1',
    counts: {},
    cohortCounts: {},
    ...overrides,
  };
}

describe('researchEnrichmentCoverageSnapshotSchema', () => {
  it('accepts a perSourcePage entry that carries sourcePageUrl', () => {
    expect(
      researchEnrichmentCoverageSnapshotSchema.safeParse(
        makeCoverageSnapshot({
          perSourcePage: {
            'Supernova/2026': {
              sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026',
              revisionId: 1,
              contentHash: 'a'.repeat(64),
              fetchedAtMs: 1_000,
              observationCount: 5,
            },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects a perSourcePage entry missing sourcePageUrl (cycle-1 review HIGH 5)', () => {
    expect(
      researchEnrichmentCoverageSnapshotSchema.safeParse(
        makeCoverageSnapshot({
          perSourcePage: {
            'Supernova/2026': {
              revisionId: 1,
              contentHash: 'a'.repeat(64),
              fetchedAtMs: 1_000,
              observationCount: 5,
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// researchEnrichmentCoverageResponseSchema
// ---------------------------------------------------------------------------

describe('researchEnrichmentCoverageResponseSchema', () => {
  it('parses a response carrying counts, cohort counts, freshness and notes', () => {
    expect(
      researchEnrichmentCoverageResponseSchema.safeParse(
        makeCoverageSnapshot({
          counts: { matched: 3, stageEnriched: 2 },
          cohortCounts: { startggOnly: 1, liquipediaSupplemented: 2, missing: 0 },
          perSourcePage: {
            'Supernova/2026': {
              sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026',
              revisionId: 1,
              contentHash: 'a'.repeat(64),
              fetchedAtMs: 1_000,
              observationCount: 5,
            },
          },
          notes: ['izaw: no Liquipedia VOD page found'],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects a perSourcePage entry missing sourcePageUrl, same as the stored snapshot schema (cycle-1 review HIGH 5)', () => {
    expect(
      researchEnrichmentCoverageResponseSchema.safeParse(
        makeCoverageSnapshot({
          perSourcePage: {
            'Supernova/2026': {
              revisionId: 1,
              contentHash: 'a'.repeat(64),
              fetchedAtMs: 1_000,
              observationCount: 5,
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

describe('researchEnrichmentCountsSchema / normalizeResearchEnrichmentCounts', () => {
  it('parses an empty counts object (every member absent)', () => {
    expect(researchEnrichmentCountsSchema.safeParse({}).success).toBe(true);
  });

  it('normalizes every counter to 0 when undefined', () => {
    const normalized = normalizeResearchEnrichmentCounts(undefined);
    expect(normalized.matched).toBe(0);
    expect(normalized.vodEnriched).toBe(0);
    expect(normalized.adminConfirmed).toBe(0);
  });
});

describe('researchEnrichmentCohortCountsSchema / normalizeResearchEnrichmentCohortCounts', () => {
  it('parses an empty cohort counts object and normalizes to zeros', () => {
    expect(researchEnrichmentCohortCountsSchema.safeParse({}).success).toBe(true);
    expect(normalizeResearchEnrichmentCohortCounts(undefined)).toEqual({
      startggOnly: 0,
      liquipediaSupplemented: 0,
      missing: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Admin review-queue / confirm / self-attribution HTTP contracts
// ---------------------------------------------------------------------------

describe('researchEnrichmentReviewQueueResponseSchema', () => {
  it('parses an empty queue with all-zero counts', () => {
    expect(
      researchEnrichmentReviewQueueResponseSchema.safeParse({
        observations: [],
        counts: { ambiguous: 0, conflicting: 0, unmatched: 0, total: 0 },
      }).success,
    ).toBe(true);
  });

  it('rejects a response whose counts member is absent', () => {
    expect(
      researchEnrichmentReviewQueueResponseSchema.safeParse({ observations: [] }).success,
    ).toBe(false);
  });
});

describe('researchEnrichmentConfirmRequestSchema', () => {
  it('accepts a request naming a targetSetId', () => {
    expect(researchEnrichmentConfirmRequestSchema.safeParse({ targetSetId: 'set-1' }).success).toBe(
      true,
    );
  });

  it('rejects a request with no targetSetId', () => {
    expect(researchEnrichmentConfirmRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('researchEnrichmentAttributionResponseSchema', () => {
  it('accepts an attribution entry with only witness-derived fields (no observation lookup available)', () => {
    expect(
      researchEnrichmentAttributionResponseSchema.safeParse({
        attributions: [
          {
            matchKey: 'set-1-1',
            rawStage: 'Battlefield',
            stageForm: 'normal',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts an attribution entry carrying the full source-page identity', () => {
    expect(
      researchEnrichmentAttributionResponseSchema.safeParse({
        attributions: [
          {
            matchKey: 'set-1-1',
            sourcePageTitle: 'Supernova/2026',
            sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026',
            sourceRevisionId: 12345,
            rawStage: 'Battlefield',
            stageForm: 'normal',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a response with more than 200 attribution entries', () => {
    expect(
      researchEnrichmentAttributionResponseSchema.safeParse({
        attributions: Array.from({ length: 201 }, (_, i) => ({ matchKey: `set-${i}-1` })),
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Module load order (cycle-1 review HIGH 1) — the defect this test catches:
// putting the provenance vocabulary directly inside a module that also sits
// on the other side of an ESM cycle leaves one side observing `undefined` at
// module-evaluation time. `vi.resetModules()` forces a genuinely fresh
// module graph, so this proves `researchEnrichment.js` fully initializes its
// runtime vocabularies even when it is the very first module of that fresh
// graph to be evaluated.
// ---------------------------------------------------------------------------

describe('module load order (cycle-1 review HIGH 1)', () => {
  it('fully initializes runtime vocabularies when researchEnrichment.js is imported first in a fresh module graph', async () => {
    vi.resetModules();
    const mod = await import('./researchEnrichment.js');
    expect(mod.RESEARCH_ENRICHMENT_PROVIDERS).toEqual(['liquipedia']);
    expect(mod.RESEARCH_ENRICHMENT_MATCH_STATUSES).toEqual([
      'matched',
      'ambiguous',
      'unmatched',
      'conflicting',
    ]);
    expect(mod.researchEnrichmentObservationRecordSchema).toBeDefined();
    expect(
      mod.researchEnrichmentObservationRecordSchema.safeParse(makeMinimalObservation()).success,
    ).toBe(true);
  });
});
