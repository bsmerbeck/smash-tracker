import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import {
  EnrichmentObservationCollisionError,
  EnrichmentObservationInvalidError,
  computeObservationPersistenceHash,
  createObservationIdCollisionGuard,
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

  // 30.2 defect C: the parity seam must make an under-keyed discriminator
  // impossible to miss — a duplicate id means persistence can only ever hold
  // FEWER records than the manifest claims to cover.
  it('refuses to hash a list containing a duplicate observationId, naming both source pages', () => {
    const a = makeObservation({ observationId: 'obs-colliding' });
    const twin = makeObservation({
      observationId: 'obs-colliding',
      sourcePageTitle: 'OtherCup/2026/Bracket',
    });
    let caught: unknown;
    try {
      computeObservationPersistenceHash([a, twin]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnrichmentObservationCollisionError);
    const err = caught as EnrichmentObservationCollisionError;
    expect(err.observationId).toBe('obs-colliding');
    expect(err.firstSourcePageTitle).toBe('TestCup/2026/Bracket');
    expect(err.secondSourcePageTitle).toBe('OtherCup/2026/Bracket');
  });
});

describe('createObservationIdCollisionGuard', () => {
  it('accepts distinct ids and throws on the second sighting of an id — dry-run and apply share this gather-time guard', () => {
    const guard = createObservationIdCollisionGuard();
    guard(makeObservation({ observationId: 'obs-1' }));
    guard(makeObservation({ observationId: 'obs-2' }));
    expect(() =>
      guard(makeObservation({ observationId: 'obs-1', sourcePageTitle: 'Twin/Page' })),
    ).toThrow(EnrichmentObservationCollisionError);
  });
});
