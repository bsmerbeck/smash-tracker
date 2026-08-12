import { describe, expect, it } from 'vitest';
import {
  isSourceOwnedVodValue,
  resolveEnrichedMatchMembers,
  type EnrichedMatchMembersInput,
  type EnrichmentOwnershipWitness,
} from './researchEnrichmentProjection.js';
import { UNKNOWN_STAGE } from './stageData.js';

const RESOLVED_PROVIDER_STAGE = { id: 1, name: 'Battlefield' };
const CANONICAL_STAGE = { id: 3, name: 'Final Destination' };

function baseInput(overrides: Partial<EnrichedMatchMembersInput> = {}): EnrichedMatchMembersInput {
  return {
    providerStage: UNKNOWN_STAGE,
    ...overrides,
  };
}

const VOD_SOURCE = { observationId: 'obs-1', sourceRevisionId: 10, parserVersion: 'p@1' };
const STAGE_SOURCE = { observationId: 'obs-2', sourceRevisionId: 11, parserVersion: 'p@1' };

describe('isSourceOwnedVodValue', () => {
  it('is false for an absent stored value', () => {
    expect(isSourceOwnedVodValue(undefined, { projectedVodUrl: 'https://a' })).toBe(false);
  });

  it('is false when the witness is null/undefined', () => {
    expect(isSourceOwnedVodValue('https://a', null)).toBe(false);
    expect(isSourceOwnedVodValue('https://a', undefined)).toBe(false);
  });

  it('is true when the value matches the committed witness value', () => {
    expect(isSourceOwnedVodValue('https://a', { projectedVodUrl: 'https://a' })).toBe(true);
  });

  it('is true when the value matches the pending witness value', () => {
    expect(isSourceOwnedVodValue('https://a', { pendingVodUrl: 'https://a' })).toBe(true);
  });

  it('is false when the value matches neither witness value', () => {
    expect(
      isSourceOwnedVodValue('https://a', {
        projectedVodUrl: 'https://b',
        pendingVodUrl: 'https://c',
      }),
    ).toBe(false);
  });
});

describe('resolveEnrichedMatchMembers - VOD', () => {
  it('fills an empty existing VOD from the enrichment source', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({ enrichmentVodUrl: 'https://liquipedia/vod', enrichmentVodSource: VOD_SOURCE }),
    );
    expect(result.vodUrl).toBe('https://liquipedia/vod');
    expect(result.vodOutcome).toBe('filled-empty');
    expect(result.witnessPatch.vodPreWrite).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/vod', ...VOD_SOURCE },
    });
    expect(result.witnessPatch.vodCommit).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/vod', ...VOD_SOURCE },
    });
  });

  it('a user-entered URL matching neither witness value is returned unchanged with the user-owned skip outcome and no witness patch', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedVodUrl: 'https://liquipedia/old',
      pendingVodUrl: 'https://liquipedia/pending-other',
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        existingVodUrl: 'https://user-typed.example/clip',
        enrichmentVodUrl: 'https://liquipedia/new',
        enrichmentVodSource: VOD_SOURCE,
        witness,
      }),
    );
    expect(result.vodUrl).toBe('https://user-typed.example/clip');
    expect(result.vodOutcome).toBe('skipped-user-owned');
    expect(result.witnessPatch.vodPreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'none' });
  });

  it('a stored value equal to the PENDING witness value resolves as source-owned, not user-owned, and completes the interrupted transition', () => {
    const witness: EnrichmentOwnershipWitness = {
      pendingVodUrl: 'https://liquipedia/vod',
      pendingVodObservationId: VOD_SOURCE.observationId,
      pendingVodSourceRevisionId: VOD_SOURCE.sourceRevisionId,
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        existingVodUrl: 'https://liquipedia/vod',
        enrichmentVodUrl: 'https://liquipedia/vod',
        enrichmentVodSource: VOD_SOURCE,
        witness,
      }),
    );
    expect(result.vodOutcome).toBe('unchanged');
    expect(result.vodUrl).toBe('https://liquipedia/vod');
    expect(result.witnessPatch.vodCommit).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/vod', ...VOD_SOURCE },
    });
  });

  it('an empty existing VOD with a pending witness value resolves to that pending value with the filled-empty outcome (interrupted before the row write)', () => {
    const witness: EnrichmentOwnershipWitness = {
      pendingVodUrl: 'https://liquipedia/vod',
      pendingVodObservationId: 'obs-9',
      pendingVodSourceRevisionId: 5,
    };
    const result = resolveEnrichedMatchMembers(baseInput({ witness }));
    expect(result.vodUrl).toBe('https://liquipedia/vod');
    expect(result.vodOutcome).toBe('filled-empty');
    expect(result.witnessPatch.vodPreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.vodCommit).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/vod', observationId: 'obs-9', sourceRevisionId: 5 },
    });
  });

  it('a source-owned URL is replaced when the source value changes (source-corrected)', () => {
    const witness: EnrichmentOwnershipWitness = { projectedVodUrl: 'https://liquipedia/old' };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        existingVodUrl: 'https://liquipedia/old',
        enrichmentVodUrl: 'https://liquipedia/new',
        enrichmentVodSource: VOD_SOURCE,
        witness,
      }),
    );
    expect(result.vodUrl).toBe('https://liquipedia/new');
    expect(result.vodOutcome).toBe('source-corrected');
    expect(result.witnessPatch.vodPreWrite).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/new', ...VOD_SOURCE },
    });
    expect(result.witnessPatch.vodCommit).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/new', ...VOD_SOURCE },
    });
  });

  it('a source-owned URL is removed when the source stops supplying one (source-removed)', () => {
    const witness: EnrichmentOwnershipWitness = { projectedVodUrl: 'https://liquipedia/old' };
    const result = resolveEnrichedMatchMembers(
      baseInput({ existingVodUrl: 'https://liquipedia/old', witness }),
    );
    expect(result.vodUrl).toBeUndefined();
    expect(result.vodOutcome).toBe('source-removed');
    expect(result.witnessPatch.vodPreWrite).toEqual({ kind: 'mark-removal' });
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'clear', released: true });
  });

  it('a provider VOD is preferred over an enrichment VOD when the field is empty and both are available, and no enrichment ownership is recorded', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerVodUrl: 'https://provider/vod',
        enrichmentVodUrl: 'https://liquipedia/vod',
        enrichmentVodSource: VOD_SOURCE,
      }),
    );
    expect(result.vodUrl).toBe('https://provider/vod');
    expect(result.vodOutcome).toBe('skipped-provider-owned');
    expect(result.witnessPatch.vodPreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'none' });
  });

  it('a provider VOD winning over a STALE enrichment witness claim releases it', () => {
    const witness: EnrichmentOwnershipWitness = { projectedVodUrl: 'https://liquipedia/stale' };
    const result = resolveEnrichedMatchMembers(
      baseInput({ providerVodUrl: 'https://provider/vod', witness }),
    );
    expect(result.vodOutcome).toBe('skipped-provider-owned');
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'clear', released: true });
  });

  it('absent VOD inputs never produce an empty string or null — the resolved VOD is absent', () => {
    const result = resolveEnrichedMatchMembers(baseInput());
    expect(result.vodUrl).toBeUndefined();
    expect(result.vodOutcome).toBe('unchanged');
    expect(result.witnessPatch.vodPreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'none' });
  });

  it('an identical replay of an already-committed value is a true no-op (no witness write)', () => {
    const witness: EnrichmentOwnershipWitness = { projectedVodUrl: 'https://liquipedia/vod' };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        existingVodUrl: 'https://liquipedia/vod',
        enrichmentVodUrl: 'https://liquipedia/vod',
        enrichmentVodSource: VOD_SOURCE,
        witness,
      }),
    );
    expect(result.vodOutcome).toBe('unchanged');
    expect(result.witnessPatch.vodCommit).toEqual({ kind: 'none' });
  });
});

describe('resolveEnrichedMatchMembers - stage', () => {
  it('a provider-resolved stage is never replaced by an enrichment stage', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerStage: RESOLVED_PROVIDER_STAGE,
        enrichmentStage: { canonicalStageId: CANONICAL_STAGE.id, ...STAGE_SOURCE },
      }),
    );
    expect(result.stage).toEqual(RESOLVED_PROVIDER_STAGE);
    expect(result.stageOutcome).toBe('provider-authoritative');
    expect(result.witnessPatch.stagePreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.stageCommit).toEqual({ kind: 'none' });
  });

  it('a provider stage resolving over a prior enrichment stage clears the stale stage witness (cycle-2 review HIGH 2)', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedStageId: CANONICAL_STAGE.id,
      projectedStageName: CANONICAL_STAGE.name,
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({ providerStage: RESOLVED_PROVIDER_STAGE, witness }),
    );
    expect(result.stageOutcome).toBe('provider-authoritative');
    expect(result.witnessPatch.stageCommit).toEqual({ kind: 'clear' });
  });

  it('an unresolved provider stage with an enrichment canonical id yields the enrichment stage with an enriched outcome', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerStage: UNKNOWN_STAGE,
        enrichmentStage: { canonicalStageId: CANONICAL_STAGE.id, raw: 'FD', ...STAGE_SOURCE },
      }),
    );
    expect(result.stage).toEqual(CANONICAL_STAGE);
    expect(result.stageOutcome).toBe('enriched');
    expect(result.witnessPatch.stagePreWrite).toEqual({
      kind: 'set',
      write: {
        stageId: CANONICAL_STAGE.id,
        stageName: CANONICAL_STAGE.name,
        raw: 'FD',
        ...STAGE_SOURCE,
      },
    });
    expect(result.witnessPatch.stageCommit).toEqual({
      kind: 'set',
      write: {
        stageId: CANONICAL_STAGE.id,
        stageName: CANONICAL_STAGE.name,
        raw: 'FD',
        ...STAGE_SOURCE,
      },
    });
  });

  it('an unresolved provider stage with NO canonical id leaves unknown in place, still recording the raw source text on the witness', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerStage: UNKNOWN_STAGE,
        enrichmentStage: { raw: 'Φ (unrecognized symbol)', ...STAGE_SOURCE },
      }),
    );
    expect(result.stage).toEqual(UNKNOWN_STAGE);
    expect(result.stageOutcome).toBe('unknown');
    expect(result.witnessPatch.stagePreWrite).toEqual({
      kind: 'set-raw-only',
      write: { raw: 'Φ (unrecognized symbol)', ...STAGE_SOURCE },
    });
  });

  it('an unresolved provider stage with no enrichment stage data at all writes nothing to the witness', () => {
    const result = resolveEnrichedMatchMembers(baseInput({ providerStage: UNKNOWN_STAGE }));
    expect(result.stage).toEqual(UNKNOWN_STAGE);
    expect(result.stageOutcome).toBe('unknown');
    expect(result.witnessPatch.stagePreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.stageCommit).toEqual({ kind: 'none' });
  });

  it('an identical replay of an already-enriched stage is a no-op (no witness write)', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedStageId: CANONICAL_STAGE.id,
      projectedStageName: CANONICAL_STAGE.name,
      projectedStageRaw: 'FD',
      projectedStageForm: undefined,
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerStage: UNKNOWN_STAGE,
        enrichmentStage: { canonicalStageId: CANONICAL_STAGE.id, raw: 'FD', ...STAGE_SOURCE },
        witness,
      }),
    );
    expect(result.stageOutcome).toBe('enriched');
    expect(result.witnessPatch.stagePreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.stageCommit).toEqual({ kind: 'none' });
  });

  it('an unmapped canonical stage id (not in the shared stage table) falls back to unknown with the raw text still recorded', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        providerStage: UNKNOWN_STAGE,
        enrichmentStage: {
          canonicalStageId: 999_999,
          raw: 'Unrecognized Custom Stage',
          ...STAGE_SOURCE,
        },
      }),
    );
    expect(result.stage).toEqual(UNKNOWN_STAGE);
    expect(result.stageOutcome).toBe('unknown');
    expect(result.witnessPatch.stagePreWrite).toEqual({
      kind: 'set-raw-only',
      write: { raw: 'Unrecognized Custom Stage', ...STAGE_SOURCE },
    });
  });
});

describe('resolveEnrichedMatchMembers - purity and totality', () => {
  it('is total and pure: identical inputs always produce identical outputs', () => {
    const input = baseInput({
      existingVodUrl: 'https://liquipedia/vod',
      enrichmentVodUrl: 'https://liquipedia/vod',
      enrichmentVodSource: VOD_SOURCE,
      providerStage: UNKNOWN_STAGE,
      enrichmentStage: { canonicalStageId: CANONICAL_STAGE.id, raw: 'FD', ...STAGE_SOURCE },
      witness: { projectedVodUrl: 'https://liquipedia/vod' },
    });
    const first = resolveEnrichedMatchMembers(input);
    const second = resolveEnrichedMatchMembers(input);
    expect(second).toEqual(first);
  });

  it('handles a fully absent witness the same as a null witness', () => {
    const withUndefined = resolveEnrichedMatchMembers(baseInput({ existingVodUrl: 'https://a' }));
    const withNull = resolveEnrichedMatchMembers(
      baseInput({ existingVodUrl: 'https://a', witness: null }),
    );
    expect(withUndefined).toEqual(withNull);
  });
});
