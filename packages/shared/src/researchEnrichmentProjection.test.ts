import { describe, expect, it } from 'vitest';
import {
  isSourceOwnedStageValue,
  isSourceOwnedVodValue,
  resolveEnrichedMatchMembers,
  resolveSeatOrientation,
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

describe('isSourceOwnedStageValue (30.3 Gate 5 commit 1)', () => {
  it('is false for the unknown sentinel, even when the witness claims it', () => {
    expect(
      isSourceOwnedStageValue(UNKNOWN_STAGE, {
        projectedStageId: 0,
        projectedStageName: 'unknown',
      }),
    ).toBe(false);
  });

  it('is false when the witness is null/undefined', () => {
    expect(isSourceOwnedStageValue(CANONICAL_STAGE, null)).toBe(false);
    expect(isSourceOwnedStageValue(CANONICAL_STAGE, undefined)).toBe(false);
  });

  it('is true when the stored stage matches the committed witness claim (id AND name)', () => {
    expect(
      isSourceOwnedStageValue(CANONICAL_STAGE, {
        projectedStageId: CANONICAL_STAGE.id,
        projectedStageName: CANONICAL_STAGE.name,
      }),
    ).toBe(true);
  });

  it('is true when the stored stage matches the pending witness claim', () => {
    expect(
      isSourceOwnedStageValue(CANONICAL_STAGE, {
        pendingStageId: CANONICAL_STAGE.id,
        pendingStageName: CANONICAL_STAGE.name,
      }),
    ).toBe(true);
  });

  it('is false when the id matches but the name does not (and vice versa)', () => {
    expect(
      isSourceOwnedStageValue(CANONICAL_STAGE, {
        projectedStageId: CANONICAL_STAGE.id,
        projectedStageName: 'Battlefield',
      }),
    ).toBe(false);
    expect(
      isSourceOwnedStageValue(CANONICAL_STAGE, {
        projectedStageId: 1,
        projectedStageName: CANONICAL_STAGE.name,
      }),
    ).toBe(false);
  });

  it('is false when the stored stage matches neither claim', () => {
    expect(
      isSourceOwnedStageValue(RESOLVED_PROVIDER_STAGE, {
        projectedStageId: CANONICAL_STAGE.id,
        projectedStageName: CANONICAL_STAGE.name,
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

  it('fills an empty existing VOD from an enrichment URL with no per-row provenance metadata (buildEnrichmentOverlay returns a plain string map)', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({ enrichmentVodUrl: 'https://liquipedia/vod' }),
    );
    expect(result.vodUrl).toBe('https://liquipedia/vod');
    expect(result.vodOutcome).toBe('filled-empty');
    expect(result.witnessPatch.vodPreWrite).toEqual({
      kind: 'set',
      write: { url: 'https://liquipedia/vod' },
    });
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

  it('a source that STOPS supplying a stage it once projected clears the stage witness (stage source-removed, 30.3 Gate 5 commit 1)', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedStageId: CANONICAL_STAGE.id,
      projectedStageName: CANONICAL_STAGE.name,
      projectedStageRaw: 'FD',
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({ providerStage: UNKNOWN_STAGE, witness }),
    );
    expect(result.stage).toEqual(UNKNOWN_STAGE);
    expect(result.stageOutcome).toBe('unknown');
    expect(result.witnessPatch.stagePreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.stageCommit).toEqual({ kind: 'clear' });
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

// ---------------------------------------------------------------------------
// 30.3 Gate 5 — seat orientation, character evidence, stocks
// ---------------------------------------------------------------------------

describe('resolveSeatOrientation', () => {
  it('proves subject seat 1 when seat 2 carries the opponent tag', () => {
    expect(resolveSeatOrientation('mkleo', ['sparg0', 'mkleo'])).toEqual({ subjectSeat: 1 });
  });

  it('proves subject seat 2 when seat 1 carries the opponent tag', () => {
    expect(resolveSeatOrientation('mkleo', ['mkleo', 'sparg0'])).toEqual({ subjectSeat: 2 });
  });

  it('abstains when BOTH seats match the opponent tag (mirror-tag edge)', () => {
    expect(resolveSeatOrientation('mkleo', ['mkleo', 'mkleo'])).toEqual({
      subjectSeat: null,
      reason: 'ambiguous',
    });
  });

  it('abstains when NEITHER seat matches the opponent tag', () => {
    expect(resolveSeatOrientation('mkleo', ['sparg0', 'hungrybox'])).toEqual({
      subjectSeat: null,
      reason: 'no-match',
    });
  });

  it('abstains when the seat tags are absent', () => {
    expect(resolveSeatOrientation('mkleo', undefined)).toEqual({
      subjectSeat: null,
      reason: 'no-seat-tags',
    });
    expect(resolveSeatOrientation('mkleo', [null, null])).toEqual({
      subjectSeat: null,
      reason: 'no-seat-tags',
    });
  });

  it("abstains when the row's opponent tag is absent, empty, or the normalizer's 'unknown' sentinel", () => {
    expect(resolveSeatOrientation(undefined, ['a', 'b']).subjectSeat).toBeNull();
    expect(resolveSeatOrientation('', ['a', 'b']).subjectSeat).toBeNull();
    expect(resolveSeatOrientation('unknown', ['unknown', 'b']).subjectSeat).toBeNull();
  });
});

const ULTIMATE_EVIDENCE = {
  game: 'ultimate',
  seatTags: ['sparg0', 'mkleo'] as [string | null, string | null],
  observationId: 'obs-ev',
  sourceRevisionId: 42,
  parserVersion: 'p@1',
};

describe('resolveEnrichedMatchMembers - character evidence (30.3 Gate 5)', () => {
  it('projects oriented characters onto the witness when orientation is proven and both names map', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          rawChars: ['cloud', 'joker'],
        },
      }),
    );
    // Subject is seat 1 (seat 2 carries the opponent tag).
    expect(result.charsOutcome).toBe('enriched');
    expect(result.chars).toEqual({
      subjectSeat: 1,
      subjectCharRaw: 'cloud',
      subjectFighterId: 65,
      opponentCharRaw: 'joker',
      opponentFighterId: 76,
    });
    expect(result.witnessPatch.charsCommit).toEqual({
      kind: 'set',
      write: {
        subjectSeat: 1,
        subjectCharRaw: 'cloud',
        subjectFighterId: 65,
        opponentCharRaw: 'joker',
        opponentFighterId: 76,
        observationId: 'obs-ev',
        sourceRevisionId: 42,
        parserVersion: 'p@1',
      },
    });
  });

  it('an unmapped raw name stays RAW and FLAGGED (no fighter id), never guessed', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          rawChars: ['definitely-not-a-fighter', 'joker'],
        },
      }),
    );
    expect(result.charsOutcome).toBe('partial-unmapped');
    expect(result.chars?.subjectCharRaw).toBe('definitely-not-a-fighter');
    expect(result.chars?.subjectFighterId).toBeUndefined();
    expect(result.chars?.opponentFighterId).toBe(76);
  });

  it('ABSTAINS with no witness write when orientation cannot be proven', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'someone-else',
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, rawChars: ['cloud', 'joker'] },
      }),
    );
    expect(result.charsOutcome).toBe('abstained-orientation');
    expect(result.chars).toBeUndefined();
    expect(result.witnessPatch.charsCommit).toEqual({ kind: 'none' });
  });

  it('REFUSES Melee-scoped evidence (the Hungrybox guard) and clears a lingering claim from it', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedSubjectSeat: 1,
      projectedSubjectCharRaw: 'jiggs',
      projectedSubjectFighterId: 13,
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          game: 'melee',
          rawChars: ['jiggs', 'fox'],
        },
        witness,
      }),
    );
    expect(result.charsOutcome).toBe('abstained-game-scope');
    expect(result.witnessPatch.charsCommit).toEqual({ kind: 'clear' });
  });

  it('an UNSTATED game scope abstains — unstated is never treated as Ultimate', () => {
    const { game: _omitted, ...withoutGame } = ULTIMATE_EVIDENCE;
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        enrichmentGameEvidence: { ...withoutGame, rawChars: ['cloud', 'joker'] },
      }),
    );
    expect(result.charsOutcome).toBe('abstained-game-scope');
  });

  it('is COMPLETELY INERT when the evidence universe was not consulted (the ingestion overlay path) — even with a lingering claim', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedSubjectSeat: 1,
      projectedSubjectFighterId: 65,
    };
    const result = resolveEnrichedMatchMembers(baseInput({ witness }));
    expect(result.charsOutcome).toBe('none');
    expect(result.witnessPatch.charsCommit).toEqual({ kind: 'none' });
  });

  it('a consulted universe with NO evidence for the row removes a lingering claim (chars source-removed)', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedSubjectSeat: 1,
      projectedSubjectFighterId: 65,
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({ enrichmentEvidenceConsulted: true, witness }),
    );
    expect(result.charsOutcome).toBe('source-removed');
    expect(result.witnessPatch.charsCommit).toEqual({ kind: 'clear' });
  });

  it('an identical replay of already-committed character evidence is a no-op', () => {
    const witness: EnrichmentOwnershipWitness = {
      projectedSubjectSeat: 1,
      projectedSubjectCharRaw: 'cloud',
      projectedSubjectFighterId: 65,
      projectedOpponentCharRaw: 'joker',
      projectedOpponentFighterId: 76,
      charsObservationId: 'obs-ev',
    };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, rawChars: ['cloud', 'joker'] },
        witness,
      }),
    );
    expect(result.charsOutcome).toBe('enriched');
    expect(result.witnessPatch.charsCommit).toEqual({ kind: 'none' });
  });
});

describe('resolveEnrichedMatchMembers - stocks (30.3 Gate 5)', () => {
  it('fills an empty stocksLeft ONLY when orientation is proven and the winner seat agrees with the row result', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          stocks: [2, 0],
          winnerSeat: 1,
        },
      }),
    );
    // Subject is seat 1; evidence says seat 1 won; row says subject won -> agree.
    expect(result.stocksOutcome).toBe('filled-empty');
    expect(result.stocksLeft).toBe(2);
    expect(result.witnessPatch.stocksPreWrite).toEqual({
      kind: 'set',
      write: { stocksLeft: 2, observationId: 'obs-ev', sourceRevisionId: 42, parserVersion: 'p@1' },
    });
    expect(result.witnessPatch.stocksCommit).toEqual({
      kind: 'set',
      write: { stocksLeft: 2, observationId: 'obs-ev', sourceRevisionId: 42, parserVersion: 'p@1' },
    });
  });

  it('REFUSES when the winner-seat evidence disagrees with the row result', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: false, // row says the subject LOST...
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          stocks: [2, 0],
          winnerSeat: 1, // ...but the source says the subject's seat won.
        },
      }),
    );
    expect(result.stocksOutcome).toBe('abstained-winner-disagreement');
    expect(result.stocksLeft).toBeUndefined();
    expect(result.witnessPatch.stocksPreWrite).toEqual({ kind: 'none' });
    expect(result.witnessPatch.stocksCommit).toEqual({ kind: 'none' });
  });

  it('abstains when the winner seat is missing, when orientation is unproven, and when the game scope is not Ultimate', () => {
    const noWinner = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [2, 0] },
      }),
    );
    expect(noWinner.stocksOutcome).toBe('abstained-winner-disagreement');

    const noOrientation = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'someone-else',
        rowWin: true,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [2, 0], winnerSeat: 1 },
      }),
    );
    expect(noOrientation.stocksOutcome).toBe('abstained-orientation');

    const melee = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        enrichmentGameEvidence: {
          ...ULTIMATE_EVIDENCE,
          game: 'melee',
          stocks: [2, 0],
          winnerSeat: 1,
        },
      }),
    );
    expect(melee.stocksOutcome).toBe('abstained-game-scope');
  });

  it('abstains on an out-of-range winner stock value', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [7, 0], winnerSeat: 1 },
      }),
    );
    expect(result.stocksOutcome).toBe('abstained-value');
    expect(result.stocksLeft).toBeUndefined();
  });

  it('an existing stocksLeft the witness does not vouch for is provider/user-owned and NEVER overwritten', () => {
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        existingStocksLeft: 3,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [2, 0], winnerSeat: 1 },
      }),
    );
    expect(result.stocksOutcome).toBe('skipped-owned');
    expect(result.stocksLeft).toBe(3);
    expect(result.witnessPatch.stocksCommit).toEqual({ kind: 'none' });
  });

  it('an identical replay of a witness-owned stocksLeft is a no-op; a changed source value corrects it', () => {
    const witness: EnrichmentOwnershipWitness = { projectedStocksLeft: 2 };
    const replay = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        existingStocksLeft: 2,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [2, 0], winnerSeat: 1 },
        witness,
      }),
    );
    expect(replay.stocksOutcome).toBe('unchanged');
    expect(replay.witnessPatch.stocksCommit).toEqual({ kind: 'none' });

    const corrected = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        rowOpponentTag: 'mkleo',
        rowWin: true,
        existingStocksLeft: 2,
        enrichmentGameEvidence: { ...ULTIMATE_EVIDENCE, stocks: [1, 0], winnerSeat: 1 },
        witness,
      }),
    );
    expect(corrected.stocksOutcome).toBe('source-corrected');
    expect(corrected.stocksLeft).toBe(1);
  });

  it('a witness-owned stocksLeft whose justification is GONE is removed and its witness half cleared', () => {
    const witness: EnrichmentOwnershipWitness = { projectedStocksLeft: 2 };
    const result = resolveEnrichedMatchMembers(
      baseInput({
        enrichmentEvidenceConsulted: true,
        existingStocksLeft: 2,
        witness,
      }),
    );
    expect(result.stocksOutcome).toBe('source-removed');
    expect(result.stocksLeft).toBeUndefined();
    expect(result.witnessPatch.stocksCommit).toEqual({ kind: 'clear' });
  });

  it('is COMPLETELY INERT when the evidence universe was not consulted — the existing member is echoed untouched', () => {
    const witness: EnrichmentOwnershipWitness = { projectedStocksLeft: 2 };
    const result = resolveEnrichedMatchMembers(baseInput({ existingStocksLeft: 2, witness }));
    expect(result.stocksOutcome).toBe('none');
    expect(result.stocksLeft).toBe(2);
    expect(result.witnessPatch.stocksCommit).toEqual({ kind: 'none' });
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
