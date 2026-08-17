import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON } from '../../liquipedia/adapters/vodList.js';
import {
  buildCompetitorPairKey,
  type CandidateIndex,
  type CandidateSetEntry,
} from './candidateIndex.js';
import {
  buildResolutionReceipt,
  RESOLUTION_DATE_TOLERANCE_DAYS,
  resolveObservation,
  RESOLVER_VERSION,
  VOD_ROW_DUPLICATE_PAIR_REASON_MARKER,
} from './resolution.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<CandidateSetEntry> = {}): CandidateSetEntry {
  return {
    targetSetId: 'set-1',
    normalizedCompetitorPair: ['sparg0', 'tweek'],
    rawCompetitorTags: ['TEAM | Sparg0', 'Tweek'],
    scorePair: [3, 1],
    totalGames: 4,
    completedAtMs: Date.parse('2026-08-09T00:00:00.000Z'),
    calendarDay: '2026-08-09',
    tournamentSlug: 'supernova-2026',
    tournamentName: 'Supernova 2026',
    eventName: 'Ultimate Singles',
    roundText: 'Grand Final',
    identifier: 'r3m1',
    ...overrides,
  };
}

function makeIndex(entries: CandidateSetEntry[]): CandidateIndex {
  const byTournamentSlug = new Map<string, CandidateSetEntry[]>();
  const byCompetitorPair = new Map<string, CandidateSetEntry[]>();
  const byCalendarDay = new Map<string, CandidateSetEntry[]>();
  const byTargetSetId = new Map<string, CandidateSetEntry>();

  for (const entry of entries) {
    byTargetSetId.set(entry.targetSetId, entry);
    if (entry.tournamentSlug) {
      const list = byTournamentSlug.get(entry.tournamentSlug) ?? [];
      list.push(entry);
      byTournamentSlug.set(entry.tournamentSlug, list);
    }
    if (entry.normalizedCompetitorPair.length === 2) {
      const key = buildCompetitorPairKey(
        entry.normalizedCompetitorPair[0]!,
        entry.normalizedCompetitorPair[1]!,
      );
      const list = byCompetitorPair.get(key) ?? [];
      list.push(entry);
      byCompetitorPair.set(key, list);
    }
    if (entry.calendarDay) {
      const list = byCalendarDay.get(entry.calendarDay) ?? [];
      list.push(entry);
      byCalendarDay.set(entry.calendarDay, list);
    }
  }

  return {
    byTournamentSlug,
    byCompetitorPair,
    byCalendarDay,
    getByTargetSetId: (id) => byTargetSetId.get(id),
    all: entries,
    size: entries.length,
    skippedCount: 0,
  };
}

function makeObservation(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 100,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1000,
    observedAtMs: 1000,
    matchingStatus: 'unmatched',
    tournamentStartggSlug: 'supernova-2026',
    game: 'ultimate',
    date: '2026-08-09',
    scores: [3, 1],
    players: [{ rawTag: 'TEAM | Sparg0' }, { rawTag: 'Tweek' }],
    games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }, { ordinal: 4 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Matched — full agreement with slug
// ---------------------------------------------------------------------------

describe('resolveObservation — matched with slug anchor', () => {
  it('resolves as matched, high confidence, with evidence naming every satisfied rung', () => {
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(makeObservation(), index);

    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      expect(outcome.targetSetId).toBe('set-1');
      expect(outcome.confidence).toBe('high');
      expect(outcome.evidence).toContain('slug-anchor');
      expect(outcome.evidence).toContain('competitor-pair');
      expect(outcome.evidence).toContain('date-window');
      expect(outcome.evidence).toContain('score-agreement');
    }
  });

  it('only the matched variant exposes a targetSetId; the ambiguous variant exposes a candidate array instead', () => {
    const index = makeIndex([
      makeCandidate({ targetSetId: 'set-1' }),
      makeCandidate({ targetSetId: 'set-2' }),
    ]);
    const outcome = resolveObservation(makeObservation(), index);

    expect(outcome.type).toBe('ambiguous');
    expect('targetSetId' in outcome).toBe(false);
    if (outcome.type === 'ambiguous') {
      expect(outcome.candidateTargetSetIds.sort()).toEqual(['set-1', 'set-2']);
    }
  });

  it('normalizes tags on both sides, matching across a sponsor-prefix change and a disambiguation-suffix change', () => {
    const index = makeIndex([
      makeCandidate({
        normalizedCompetitorPair: ['dany', 'sparg0'],
        rawCompetitorTags: ['TEAM | Dany', 'Sparg0'],
      }),
    ]);
    const outcome = resolveObservation(
      makeObservation({ players: [{ rawTag: 'Sparg0' }, { rawTag: 'Dany (American player)' }] }),
      index,
    );
    expect(outcome.type).toBe('matched');
  });

  it('round is never used to select a candidate: two candidates differing only by round still resolve as ambiguous', () => {
    const index = makeIndex([
      makeCandidate({ targetSetId: 'set-1', roundText: 'Grand Final', identifier: 'r3m1' }),
      makeCandidate({ targetSetId: 'set-2', roundText: 'Grand Final Reset', identifier: 'r3m2' }),
    ]);
    const outcome = resolveObservation(
      makeObservation({ derivedRoundLabel: 'Grand Final' }),
      index,
    );
    expect(outcome.type).toBe('ambiguous');
  });

  it('a date within the ±1 day tolerance still matches', () => {
    const index = makeIndex([makeCandidate({ calendarDay: '2026-08-10' })]);
    const outcome = resolveObservation(makeObservation({ date: '2026-08-09' }), index);
    expect(outcome.type).toBe('matched');
    expect(RESOLUTION_DATE_TOLERANCE_DAYS).toBe(1);
  });

  it('a date beyond the tolerance is not itself disqualifying when it is the ONLY disagreement (date is never the sole discriminator) — but combined with a distinct pair it correctly abstains', () => {
    // Two candidates: one within tolerance, one far outside — only the
    // in-tolerance one should survive the date rung, proving date DOES
    // still filter when other rungs cannot disambiguate alone.
    const index = makeIndex([
      makeCandidate({ targetSetId: 'set-near', calendarDay: '2026-08-09' }),
      makeCandidate({ targetSetId: 'set-far', calendarDay: '2020-01-01' }),
    ]);
    const outcome = resolveObservation(makeObservation({ date: '2026-08-09' }), index);
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      expect(outcome.targetSetId).toBe('set-near');
    }
  });
});

// ---------------------------------------------------------------------------
// Conflicting
// ---------------------------------------------------------------------------

describe('resolveObservation — conflicting', () => {
  it('a single survivor that disagrees on score resolves as conflicting, naming the field', () => {
    const index = makeIndex([makeCandidate({ scorePair: [3, 2] })]);
    const outcome = resolveObservation(makeObservation({ scores: [3, 1] }), index);
    expect(outcome.type).toBe('conflicting');
    if (outcome.type === 'conflicting') {
      expect(outcome.targetSetId).toBe('set-1');
      expect(outcome.conflicts).toContain('score');
    }
  });

  it('a single survivor whose game count differs from the observation resolves as conflicting, not matched', () => {
    const index = makeIndex([makeCandidate({ totalGames: 5 })]);
    const outcome = resolveObservation(
      makeObservation({ games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }, { ordinal: 4 }] }),
      index,
    );
    expect(outcome.type).toBe('conflicting');
    if (outcome.type === 'conflicting') {
      expect(outcome.conflicts).toContain('gameCount');
    }
  });

  it('a non-numeric raw score never coerces to zero and never compares equal to a numeric one — outcome is not matched', () => {
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(
      makeObservation({ scores: [null, 1], rawScores: ['DQ', '1'] }),
      index,
    );
    expect(outcome.type).not.toBe('matched');
    expect(['conflicting', 'unmatched']).toContain(outcome.type);
  });
});

// ---------------------------------------------------------------------------
// Unmatched
// ---------------------------------------------------------------------------

describe('resolveObservation — unmatched', () => {
  it('no surviving candidate but a matched event (slug found) resolves as unmatched with a reason distinguishing it from an unmatched event', () => {
    const index = makeIndex([
      makeCandidate({ normalizedCompetitorPair: ['someone-else', 'other'] }),
    ]);
    const outcome = resolveObservation(makeObservation(), index);
    expect(outcome.type).toBe('unmatched');
    if (outcome.type === 'unmatched') {
      expect(outcome.reasons).toContain('no-pair-match-in-event');
    }
  });

  it('no matched event at all (slug absent from the index) resolves as unmatched with a distinct reason', () => {
    const index = makeIndex([]);
    const outcome = resolveObservation(makeObservation(), index);
    expect(outcome.type).toBe('unmatched');
    if (outcome.type === 'unmatched') {
      expect(outcome.reasons).toContain('no-matched-event');
    }
  });

  it('a declared game other than ultimate abstains as unmatched', () => {
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(makeObservation({ game: 'melee' }), index);
    expect(outcome.type).toBe('unmatched');
  });
});

// ---------------------------------------------------------------------------
// Slug-less resolution
// ---------------------------------------------------------------------------

describe('resolveObservation — no tournament slug', () => {
  it('reaches high confidence only when date, pair, score AND game count all agree with a unique survivor', () => {
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(
      makeObservation({ tournamentStartggSlug: undefined }),
      index,
    );
    expect(outcome.type).toBe('matched');
  });

  it('a slug-less observation missing game-count agreement resolves as ambiguous, not matched', () => {
    const index = makeIndex([makeCandidate({ totalGames: 5 })]);
    const outcome = resolveObservation(
      makeObservation({ tournamentStartggSlug: undefined }),
      index,
    );
    expect(outcome.type).toBe('ambiguous');
  });

  it('a slug-less observation missing score agreement resolves as ambiguous, not matched', () => {
    const index = makeIndex([makeCandidate({ scorePair: [3, 2] })]);
    const outcome = resolveObservation(
      makeObservation({ tournamentStartggSlug: undefined }),
      index,
    );
    expect(outcome.type).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// The mandatory Supernova grand-final / reset fixture
// ---------------------------------------------------------------------------

describe('resolveObservation — Supernova 2026 grand final and reset', () => {
  it('resolves the grand final and the reset to two DIFFERENT start.gg target set ids', () => {
    const grandFinalCandidate = makeCandidate({
      targetSetId: 'startgg-set-r3m1',
      identifier: 'r3m1',
      roundText: 'Grand Final',
      totalGames: 3,
      scorePair: [3, 1],
    });
    const resetCandidate = makeCandidate({
      targetSetId: 'startgg-set-r3m2',
      identifier: 'r3m2',
      roundText: 'Grand Final Reset',
      totalGames: 5,
      scorePair: [3, 2],
    });
    const index = makeIndex([grandFinalCandidate, resetCandidate]);

    const grandFinalObservation = makeObservation({
      observationId: 'obs-gf',
      bracketKey: 'DEFinalSmwBracket r3m1',
      scores: [3, 1],
      games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
    });
    const resetObservation = makeObservation({
      observationId: 'obs-reset',
      bracketKey: 'DEFinalSmwBracket r3m2',
      isBracketReset: true,
      scores: [3, 2],
      games: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }, { ordinal: 4 }, { ordinal: 5 }],
    });

    const grandFinalOutcome = resolveObservation(grandFinalObservation, index);
    const resetOutcome = resolveObservation(resetObservation, index);

    expect(grandFinalOutcome.type).toBe('matched');
    expect(resetOutcome.type).toBe('matched');
    if (grandFinalOutcome.type === 'matched' && resetOutcome.type === 'matched') {
      expect(grandFinalOutcome.targetSetId).not.toBe(resetOutcome.targetSetId);
      expect(grandFinalOutcome.targetSetId).toBe('startgg-set-r3m1');
      expect(resetOutcome.targetSetId).toBe('startgg-set-r3m2');
    }
  });
});

// ---------------------------------------------------------------------------
// VOD-page discovery-index branch
// ---------------------------------------------------------------------------

describe('resolveObservation — VOD-page discovery-index rows', () => {
  function makeVodRowObservation(
    overrides: Partial<ResearchEnrichmentObservationRecord> = {},
  ): ResearchEnrichmentObservationRecord {
    return makeObservation({
      contentType: 'vod-reference',
      templateFamily: 'vodlist',
      resolutionReasons: [LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON],
      tournamentPageTitle: 'Supernova/2026/Ultimate',
      vodUrl: 'https://www.youtube.com/watch?v=abc123',
      date: undefined,
      scores: undefined,
      games: undefined,
      ...overrides,
    });
  }

  it('resolves ONLY through a bracket observation that already matched for the same tournament and VOD URL', () => {
    const matchedBracketVodUrls = new Map([
      ['Supernova/2026/Ultimate::https://www.youtube.com/watch?v=abc123', 'startgg-set-r3m1'],
    ]);
    const outcome = resolveObservation(makeVodRowObservation(), makeIndex([]), {
      matchedBracketVodUrls,
    });
    expect(outcome.type).toBe('matched');
    if (outcome.type === 'matched') {
      expect(outcome.targetSetId).toBe('startgg-set-r3m1');
    }
  });

  it('falls back from a timestamped or /live/ URL to one unique no-offset video identity within the same tournament', () => {
    const matchedBracketVodIdentities = new Map([
      ['Supernova/2026/Ultimate::https://www.youtube.com/watch?v=abc123', 'startgg-set-r3m1'],
    ]);
    for (const vodUrl of [
      'https://youtu.be/abc123?t=90',
      'https://www.youtube.com/live/abc123?start=90',
    ]) {
      const outcome = resolveObservation(makeVodRowObservation({ vodUrl }), makeIndex([]), {
        matchedBracketVodIdentities,
      });
      expect(outcome).toEqual(
        expect.objectContaining({ type: 'matched', targetSetId: 'startgg-set-r3m1' }),
      );
    }
  });

  it('abstains when the caller omits an ambiguous shared-video identity (GF/reset non-collapse)', () => {
    const outcome = resolveObservation(
      makeVodRowObservation({ vodUrl: 'https://youtu.be/abc123?t=90' }),
      makeIndex([]),
      { matchedBracketVodIdentities: new Map() },
    );
    expect(outcome.type).toBe('ambiguous');
  });

  it('resolves as ambiguous with no bracket corroboration', () => {
    const outcome = resolveObservation(makeVodRowObservation(), makeIndex([]));
    expect(outcome.type).toBe('ambiguous');
  });

  it('resolves as ambiguous when marked as part of a duplicated tournament-and-opponent pair, even with corroboration available', () => {
    const matchedBracketVodUrls = new Map([
      ['Supernova/2026/Ultimate::https://www.youtube.com/watch?v=abc123', 'startgg-set-r3m1'],
    ]);
    const outcome = resolveObservation(
      makeVodRowObservation({
        resolutionReasons: [
          LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON,
          VOD_ROW_DUPLICATE_PAIR_REASON_MARKER,
        ],
      }),
      makeIndex([]),
      { matchedBracketVodUrls },
    );
    expect(outcome.type).toBe('ambiguous');
  });

  it('a VOD-page row never resolves on its own, even when the candidate index would otherwise match it', () => {
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(makeVodRowObservation(), index);
    expect(outcome.type).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// buildResolutionReceipt
// ---------------------------------------------------------------------------

describe('buildResolutionReceipt', () => {
  it('returns a receipt for a matched outcome, with a single candidate equal to the target set id', () => {
    const observation = makeObservation();
    const index = makeIndex([makeCandidate()]);
    const outcome = resolveObservation(observation, index);
    const receipt = buildResolutionReceipt(observation, outcome, 5000);

    expect(receipt).not.toBeNull();
    expect(receipt?.candidateTargetSetIds).toEqual(['set-1']);
    expect(receipt?.targetSetId).toBe('set-1');
    expect(receipt?.confidence).toBe('high');
    expect(receipt?.resolverVersion).toBe(RESOLVER_VERSION);
  });

  it('returns null for the ambiguous, conflicting and unmatched variants', () => {
    const observation = makeObservation();
    expect(
      buildResolutionReceipt(
        observation,
        { type: 'ambiguous', candidateTargetSetIds: ['a', 'b'], evidence: [], reasons: [] },
        5000,
      ),
    ).toBeNull();
    expect(
      buildResolutionReceipt(
        observation,
        { type: 'conflicting', targetSetId: 'set-1', conflicts: ['score'] },
        5000,
      ),
    ).toBeNull();
    expect(
      buildResolutionReceipt(
        observation,
        { type: 'unmatched', reasons: ['no-matched-event'] },
        5000,
      ),
    ).toBeNull();
  });

  it("copies the fingerprint members from the OBSERVATION, and changing the observation's content hash changes the derived receiptId", () => {
    const index = makeIndex([makeCandidate()]);
    const observationA = makeObservation({ sourceContentHash: 'a'.repeat(64) });
    const outcomeA = resolveObservation(observationA, index);
    const receiptA = buildResolutionReceipt(observationA, outcomeA, 5000)!;

    expect(receiptA.sourceRevisionId).toBe(observationA.sourceRevisionId);
    expect(receiptA.sourceContentHash).toBe(observationA.sourceContentHash);
    expect(receiptA.parserVersion).toBe(observationA.parserVersion);

    const observationB = makeObservation({ sourceContentHash: 'b'.repeat(64) });
    const outcomeB = resolveObservation(observationB, index);
    const receiptB = buildResolutionReceipt(observationB, outcomeB, 5000)!;

    expect(receiptB.receiptId).not.toBe(receiptA.receiptId);
  });
});
