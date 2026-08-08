import { describe, expect, it } from 'vitest';
import type { StartggResearchSet } from './client.js';
import {
  compareEntrantSizeProbe,
  estimateResponseNodeLowerBound,
  formatResearchProbeReport,
  summarizeResearchSetsProbe,
} from './researchProbe.js';

/**
 * Phase 30 Plan 02, Task 3 — fixture-driven tests for the probe's pure
 * folding/summarizing logic. Hand-built fixtures stand in for real
 * `fetchResearchSetsPage` responses; the live network call itself is not
 * unit-tested (see `probeResearchSetsSchema.ts`'s human-check verify step).
 */

function makeSet(overrides: Partial<StartggResearchSet> = {}): StartggResearchSet {
  return {
    id: 1,
    ...overrides,
  } as StartggResearchSet;
}

describe('summarizeResearchSetsProbe', () => {
  it('returns an all-zero, non-throwing summary for an empty page list', () => {
    const summary = summarizeResearchSetsProbe([]);

    expect(summary.pageCount).toBe(0);
    expect(summary.setCount).toBe(0);
    expect(summary.observedStates).toEqual([]);
    for (const counts of Object.values(summary.fieldPresence)) {
      expect(counts).toEqual({ present: 0, absent: 0 });
    }
  });

  it('reports isDisqualified present on sets that carry it (including `false`) and absent on sets that omit it', () => {
    const sets: StartggResearchSet[] = [
      makeSet({ id: 1, slots: [{ entrant: { id: 10, isDisqualified: false } as never }] }),
      makeSet({ id: 2, slots: [{ entrant: { id: 20, isDisqualified: false } as never }] }),
      makeSet({ id: 3, slots: [{ entrant: { id: 30 } as never }] }),
    ];

    const summary = summarizeResearchSetsProbe([{ requestedPerPage: 10, sets }]);

    expect(summary.fieldPresence['entrant.isDisqualified']).toEqual({ present: 2, absent: 1 });
  });

  it('reports an ascending distinct state histogram', () => {
    const sets: StartggResearchSet[] = [
      makeSet({ id: 1, state: 1 }),
      makeSet({ id: 2, state: 3 }),
      makeSet({ id: 3, state: 3 }),
    ];

    const summary = summarizeResearchSetsProbe([{ requestedPerPage: 10, sets }]);

    expect(summary.observedStates).toEqual([
      { value: 1, count: 1 },
      { value: 3, count: 2 },
    ]);
  });

  it('counts a bye-shaped slot when a slot carries a null entrant', () => {
    const sets: StartggResearchSet[] = [
      makeSet({
        id: 1,
        slots: [{ entrant: null }, { entrant: { id: 20 } as never }],
      }),
    ];

    const summary = summarizeResearchSetsProbe([{ requestedPerPage: 10, sets }]);

    expect(summary.byeShapedSlots).toBe(1);
  });

  it('counts a non-singles-shaped entrant when its participants array has more than one member', () => {
    const sets: StartggResearchSet[] = [
      makeSet({
        id: 1,
        slots: [
          {
            entrant: {
              id: 10,
              participants: [
                { player: { id: 1, gamerTag: 'A' } },
                { player: { id: 2, gamerTag: 'B' } },
              ],
            } as never,
          },
        ],
      }),
    ];

    const summary = summarizeResearchSetsProbe([{ requestedPerPage: 10, sets }]);

    expect(summary.nonSinglesEntrants).toBe(1);
  });

  it('counts an absent-videogame set separately from a non-SSBU set (review C-H3)', () => {
    const sets: StartggResearchSet[] = [
      makeSet({ id: 1, event: { videogame: null } as never }),
      makeSet({ id: 2, event: { videogame: { id: 999 } } as never }),
    ];

    const summary = summarizeResearchSetsProbe([{ requestedPerPage: 10, sets }]);

    expect(summary.absentVideogameSets).toBe(1);
    expect(summary.nonSsbuSets).toBe(1);
    expect(summary.distinctVideogameIds).toEqual([999]);
  });

  it('records setsPerPageRequested/Returned separately so a truncated page is visible', () => {
    const summary = summarizeResearchSetsProbe([
      { requestedPerPage: 10, sets: [makeSet({ id: 1 }), makeSet({ id: 2 })] },
      { requestedPerPage: 10, sets: [makeSet({ id: 3 })] },
    ]);

    expect(summary.setsPerPageRequested).toEqual([10, 10]);
    expect(summary.setsPerPageReturned).toEqual([2, 1]);
  });
});

describe('estimateResponseNodeLowerBound', () => {
  it('is deterministic and grows with set/game/slot count', () => {
    const smallSet = makeSet({ id: 1 });
    const largerSet = makeSet({
      id: 2,
      slots: [{ entrant: { id: 10 } as never }, { entrant: { id: 20 } as never }],
      games: [
        {
          id: 1,
          winnerId: 10,
          selections: [{ character: { id: 1 }, entrant: { id: 10 } }],
        } as never,
      ],
    });

    const smallEstimate = estimateResponseNodeLowerBound([smallSet]);
    const largerEstimate = estimateResponseNodeLowerBound([largerSet]);
    const repeatedEstimate = estimateResponseNodeLowerBound([largerSet]);

    expect(largerEstimate).toBeGreaterThan(smallEstimate);
    expect(largerEstimate).toBe(repeatedEstimate);
  });
});

describe('compareEntrantSizeProbe', () => {
  it('reports the filter-usable verdict with the excluded ids when filtered is a strict subset', () => {
    const unfiltered = [1, 2, 3, 4, 5].map((id) => makeSet({ id }));
    const filtered = [1, 2, 3].map((id) => makeSet({ id }));

    const result = compareEntrantSizeProbe(unfiltered, filtered);

    expect(result.verdict).toBe('filter-usable');
    expect(result.unfilteredCount).toBe(5);
    expect(result.filteredCount).toBe(3);
    expect(result.onlyInUnfiltered.sort()).toEqual(['4', '5']);
    expect(result.onlyInFiltered).toEqual([]);
  });

  it('reports the filter-changes-nothing verdict when both sides have the same set ids', () => {
    const sets = [1, 2, 3].map((id) => makeSet({ id }));

    const result = compareEntrantSizeProbe(sets, sets);

    expect(result.verdict).toBe('filter-changes-nothing');
  });

  it('reports the filter-unavailable verdict from a null filtered page without throwing', () => {
    const unfiltered = [1, 2].map((id) => makeSet({ id }));

    const result = compareEntrantSizeProbe(unfiltered, null);

    expect(result.verdict).toBe('filter-unavailable');
    expect(result.unfilteredCount).toBe(2);
    expect(result.filteredCount).toBe(0);
  });
});

describe('formatResearchProbeReport', () => {
  it('renders a plain-text report including the not-probed entrant-size line', () => {
    const summary = summarizeResearchSetsProbe([]);
    const report = formatResearchProbeReport(summary);

    expect(report).toContain('Pages fetched: 0');
    expect(report).toContain('not probed');
    expect(report).toContain('not applicable');
  });

  it('renders the entrant-size verdict when a comparison was run', () => {
    const summary = summarizeResearchSetsProbe([]);
    const comparison = compareEntrantSizeProbe(
      [makeSet({ id: 1 }), makeSet({ id: 2 })],
      [makeSet({ id: 1 })],
    );
    const report = formatResearchProbeReport({ ...summary, entrantSizeComparison: comparison });

    expect(report).toContain('filter-usable');
  });
});
