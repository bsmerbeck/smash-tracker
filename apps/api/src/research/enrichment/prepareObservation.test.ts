import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import {
  EnrichmentObservationInvalidError,
  computeObservationPersistenceHash,
  prepareAndValidateObservation,
} from './prepareObservation.js';

function makeObservation(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-parity-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'TestCup/2026/Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/TestCup/2026/Bracket',
    sourceRevisionId: 20,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1_000,
    observedAtMs: 1_000,
    matchingStatus: 'unmatched',
    players: [{ rawTag: 'MkLeo' }, { rawTag: 'Sparg0' }],
    ...overrides,
  };
}

describe('prepareAndValidateObservation', () => {
  it('returns the schema-parsed record for a valid observation', () => {
    const record = makeObservation();
    expect(prepareAndValidateObservation(record)).toEqual(record);
  });

  it('throws a named, page-identifying error for the production rawTag "" defect — at extraction time, never the write boundary', () => {
    const record = makeObservation({
      players: [{ rawTag: '' }, { rawTag: '' }],
    } as Partial<ResearchEnrichmentObservationRecord>);
    let caught: unknown;
    try {
      prepareAndValidateObservation(record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnrichmentObservationInvalidError);
    const err = caught as EnrichmentObservationInvalidError;
    expect(err.observationId).toBe('obs-parity-1');
    expect(err.sourcePageTitle).toBe('TestCup/2026/Bracket');
    expect(err.message).toContain('players');
  });

  it('throws for a whitespace-only rawTag (the tightened trim bound)', () => {
    const record = makeObservation({
      players: [{ rawTag: '   ' }, { rawTag: 'Sparg0' }],
    } as Partial<ResearchEnrichmentObservationRecord>);
    expect(() => prepareAndValidateObservation(record)).toThrow(EnrichmentObservationInvalidError);
  });

  it('accepts an extraction-failure record without players', () => {
    const record = makeObservation({ extractionFailed: true });
    delete (record as { players?: unknown }).players;
    expect(() => prepareAndValidateObservation(record)).not.toThrow();
  });
});

describe('computeObservationPersistenceHash', () => {
  it('is a 64-hex digest, deterministic over the empty set', () => {
    expect(computeObservationPersistenceHash([])).toMatch(/^[0-9a-f]{64}$/);
    expect(computeObservationPersistenceHash([])).toBe(computeObservationPersistenceHash([]));
  });

  it('ignores gather order and the two volatile clock stamps but covers every content member', () => {
    const a = makeObservation({ observationId: 'obs-a' });
    const b = makeObservation({ observationId: 'obs-b' });
    const baseline = computeObservationPersistenceHash([a, b]);
    expect(computeObservationPersistenceHash([b, a])).toBe(baseline);
    expect(
      computeObservationPersistenceHash([{ ...a, fetchedAtMs: 9_999, observedAtMs: 9_999 }, b]),
    ).toBe(baseline);
    expect(computeObservationPersistenceHash([{ ...a, vodUrl: 'https://youtu.be/x' }, b])).not.toBe(
      baseline,
    );
  });
});
