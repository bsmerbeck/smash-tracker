import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from './client.js';

/**
 * Phase 30 Plan 02, Task 3 — the pure folding/summarizing logic behind
 * `apps/api/scripts/probeResearchSetsSchema.ts`'s live schema smoke probe.
 * Every function here is a pure function of fixture data (or, in
 * production, of pages already fetched via `fetchResearchSetsPage`) so the
 * probe's classification logic is unit-tested even though the live network
 * call it summarizes is not.
 *
 * Answers 30-RESEARCH.md's Open Questions before wave 3 wires anything to a
 * live token:
 * 1. Do the added fields (`isDisqualified`, `state`, `identifier`, …) exist
 *    on the live schema, and what does `state` actually contain?
 *    -> `summarizeResearchSetsProbe`'s `fieldPresence`/`observedStates`.
 * 2. What is this system's own lower-bound node count per page?
 *    -> `estimateResponseNodeLowerBound` (see its doc comment — this is
 *    OUR OWN estimate, never start.gg's undocumented complexity metric).
 * 3. Is `SetFilters.entrantSize` a usable singles pre-filter?
 *    -> `compareEntrantSizeProbe` (review C-M1 / C2-A1).
 */

const PROBED_FIELD_NAMES = [
  'state',
  'identifier',
  'createdAt',
  'updatedAt',
  'completedAt',
  'displayScore',
  'totalGames',
  'vodUrl',
  'entrant.isDisqualified',
  'entrant.initialSeedNum',
  'game.id',
  'game.stage',
  'game.selections',
  'event.type',
  'event.videogame',
  'event.tournament.id',
] as const;

type ProbedFieldName = (typeof PROBED_FIELD_NAMES)[number];

export interface FieldPresenceCounts {
  present: number;
  absent: number;
}

export type EntrantSizeProbeVerdict =
  'filter-usable' | 'filter-changes-nothing' | 'filter-unavailable';

export interface EntrantSizeProbeComparison {
  verdict: EntrantSizeProbeVerdict;
  unfilteredCount: number;
  filteredCount: number;
  onlyInUnfiltered: string[];
  onlyInFiltered: string[];
}

export interface ResearchProbeSummary {
  pageCount: number;
  setCount: number;
  /** Requested `perPage` for each fetched page, in fetch order. */
  setsPerPageRequested: number[];
  /** Actual returned set count for each fetched page, in fetch order — a returned count below the requested one is a possible (unconfirmed) complexity-triggered-truncation signal (30-RESEARCH.md Pitfall 7). */
  setsPerPageReturned: number[];
  fieldPresence: Record<ProbedFieldName, FieldPresenceCounts>;
  /** Ascending distinct `state` values observed, with per-value counts (30-RESEARCH.md Open Question 1 / Assumption A2). */
  observedStates: { value: number; count: number }[];
  /** Slots observed with a null/absent entrant — proves the `showByes: true` filter took effect. */
  byeShapedSlots: number;
  /** Entrants observed with more than one participant — doubles/teams shape (30-RESEARCH.md Pitfall 2 evidence). */
  nonSinglesEntrants: number;
  /** Sets whose `event.videogame.id` is PRESENT and differs from `SSBU_VIDEOGAME_ID`. */
  nonSsbuSets: number;
  /** Sets whose `event.videogame` (or its `id`) is entirely ABSENT — counted separately from `nonSsbuSets` (review C-H3): a missing id is not evidence the set is non-SSBU. */
  absentVideogameSets: number;
  distinctVideogameIds: number[];
  /** OUR OWN lower-bound node estimate — see `estimateResponseNodeLowerBound`'s doc comment. Never a measurement of start.gg's undocumented complexity metric. */
  estimatedNodeLowerBound: number;
  /** Result of `compareEntrantSizeProbe`, or null when `--probe-entrant-size` was not passed. */
  entrantSizeComparison: EntrantSizeProbeComparison | null;
  /** Whether a live rate-limit rejection this run carried a `Retry-After` header — null when no rejection occurred this run (nothing to observe), never a default guess. */
  retryAfterObserved: boolean | null;
}

const FIELD_PRESENCE_CHECKERS: Record<ProbedFieldName, (set: StartggResearchSet) => boolean> = {
  state: (set) => set.state != null,
  identifier: (set) => set.identifier != null,
  createdAt: (set) => set.createdAt != null,
  updatedAt: (set) => set.updatedAt != null,
  completedAt: (set) => set.completedAt != null,
  displayScore: (set) => set.displayScore != null,
  totalGames: (set) => set.totalGames != null,
  vodUrl: (set) => set.vodUrl != null,
  'entrant.isDisqualified': (set) =>
    (set.slots ?? []).some((slot) => slot?.entrant != null && slot.entrant.isDisqualified != null),
  'entrant.initialSeedNum': (set) =>
    (set.slots ?? []).some((slot) => slot?.entrant != null && slot.entrant.initialSeedNum != null),
  'game.id': (set) => (set.games ?? []).some((game) => game.id != null),
  'game.stage': (set) => (set.games ?? []).some((game) => game.stage != null),
  'game.selections': (set) => (set.games ?? []).some((game) => (game.selections ?? []).length > 0),
  'event.type': (set) => set.event?.type != null,
  'event.videogame': (set) => set.event?.videogame != null,
  'event.tournament.id': (set) => set.event?.tournament?.id != null,
};

function buildFieldPresence(
  sets: StartggResearchSet[],
): Record<ProbedFieldName, FieldPresenceCounts> {
  const result = {} as Record<ProbedFieldName, FieldPresenceCounts>;
  for (const field of PROBED_FIELD_NAMES) {
    result[field] = { present: 0, absent: 0 };
  }
  for (const set of sets) {
    for (const field of PROBED_FIELD_NAMES) {
      if (FIELD_PRESENCE_CHECKERS[field](set)) {
        result[field].present += 1;
      } else {
        result[field].absent += 1;
      }
    }
  }
  return result;
}

function buildObservedStates(sets: StartggResearchSet[]): { value: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const set of sets) {
    if (set.state != null) {
      counts.set(set.state, (counts.get(set.state) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count }));
}

/**
 * Folds one or more fetched research-sets pages into a `ResearchProbeSummary`.
 * An empty page list is a valid, non-throwing result (every counter zero,
 * `observedStates` an empty array) — the probe script's `--pages` argument
 * can legitimately return zero sets for a brand-new/inactive player.
 */
export function summarizeResearchSetsProbe(
  pages: { requestedPerPage: number; sets: StartggResearchSet[] }[],
): ResearchProbeSummary {
  const allSets = pages.flatMap((page) => page.sets);

  let byeShapedSlots = 0;
  let nonSinglesEntrants = 0;
  let nonSsbuSets = 0;
  let absentVideogameSets = 0;
  const videogameIds = new Set<number>();

  for (const set of allSets) {
    const videogame = set.event?.videogame;
    if (videogame == null || videogame.id == null) {
      // Present-and-differs is the classifier's own test (review C-H3):
      // an ABSENT videogame id is a distinct "unresolved" case, not evidence
      // the set is non-SSBU — counting it as non-SSBU would misrepresent
      // both this probe's numbers and 30-03's classifier numbers.
      absentVideogameSets += 1;
    } else {
      videogameIds.add(videogame.id);
      if (videogame.id !== SSBU_VIDEOGAME_ID) {
        nonSsbuSets += 1;
      }
    }

    for (const slot of set.slots ?? []) {
      if (slot == null) {
        continue;
      }
      if (slot.entrant == null) {
        byeShapedSlots += 1;
        continue;
      }
      const participants = (slot.entrant.participants ?? []).filter((p) => p != null);
      if (participants.length > 1) {
        nonSinglesEntrants += 1;
      }
    }
  }

  return {
    pageCount: pages.length,
    setCount: allSets.length,
    setsPerPageRequested: pages.map((page) => page.requestedPerPage),
    setsPerPageReturned: pages.map((page) => page.sets.length),
    fieldPresence: buildFieldPresence(allSets),
    observedStates: buildObservedStates(allSets),
    byeShapedSlots,
    nonSinglesEntrants,
    nonSsbuSets,
    absentVideogameSets,
    distinctVideogameIds: [...videogameIds].sort((a, b) => a - b),
    estimatedNodeLowerBound: estimateResponseNodeLowerBound(allSets),
    entrantSizeComparison: null,
    retryAfterObserved: null,
  };
}

/**
 * A deterministic count of the nodes THIS system requested: one per set,
 * plus one per slot, per entrant, per participant, per seed, per standing,
 * per game, and per selection. This is OUR OWN lower bound on the objects
 * we asked for — it is NOT a measurement of start.gg's undocumented
 * complexity metric (review C-M2). The operator compares this number
 * against the observed accept/reject boundary from a live probe; nothing
 * downstream may describe it as an empirically confirmed per-page object
 * count, because the provider's own complexity formula (multiplicative,
 * per 30-RESEARCH.md Pitfall 7) is not published and may weight nested
 * selections differently than this flat count does.
 */
export function estimateResponseNodeLowerBound(sets: StartggResearchSet[]): number {
  let count = 0;
  for (const set of sets) {
    count += 1; // one per set
    for (const slot of set.slots ?? []) {
      if (slot == null) {
        continue;
      }
      count += 1; // one per slot
      const entrant = slot.entrant;
      if (entrant != null) {
        count += 1; // one per entrant
        count += (entrant.participants ?? []).filter((p) => p != null).length; // one per participant
        count += (entrant.seeds ?? []).filter((s) => s != null).length; // one per seed
        if (entrant.standing != null) {
          count += 1; // one per standing
        }
      }
    }
    for (const game of set.games ?? []) {
      count += 1; // one per game
      count += (game.selections ?? []).length; // one per selection
    }
  }
  return count;
}

/**
 * The pure half of the Open Question 3 answer (review C-M1): whether
 * `SetFilters.entrantSize` is a usable server-side singles pre-filter. A
 * null `filtered` argument means start.gg rejected the filter argument
 * outright (an unknown-argument `StartggApiError`) — the caller converts
 * that rejection to this function's null argument rather than throwing
 * through the comparison. Equal id sets yield `filter-changes-nothing`; a
 * filtered result that is a strict subset yields `filter-usable`, with the
 * excluded ids listed so the operator can eyeball whether they really are
 * the doubles sets.
 */
export function compareEntrantSizeProbe(
  unfiltered: StartggResearchSet[],
  filtered: StartggResearchSet[] | null,
): EntrantSizeProbeComparison {
  if (filtered === null) {
    return {
      verdict: 'filter-unavailable',
      unfilteredCount: unfiltered.length,
      filteredCount: 0,
      onlyInUnfiltered: [],
      onlyInFiltered: [],
    };
  }

  const unfilteredIds = unfiltered.map((set) => String(set.id));
  const filteredIds = filtered.map((set) => String(set.id));
  const unfilteredIdSet = new Set(unfilteredIds);
  const filteredIdSet = new Set(filteredIds);
  const onlyInUnfiltered = unfilteredIds.filter((id) => !filteredIdSet.has(id));
  const onlyInFiltered = filteredIds.filter((id) => !unfilteredIdSet.has(id));
  const verdict: EntrantSizeProbeVerdict =
    onlyInUnfiltered.length === 0 && onlyInFiltered.length === 0
      ? 'filter-changes-nothing'
      : 'filter-usable';

  return {
    verdict,
    unfilteredCount: unfilteredIds.length,
    filteredCount: filteredIds.length,
    onlyInUnfiltered,
    onlyInFiltered,
  };
}

/** A plain-text report for the probe CLI's stdout. */
export function formatResearchProbeReport(summary: ResearchProbeSummary): string {
  const lines: string[] = [];
  lines.push(`Pages fetched: ${summary.pageCount}`);
  lines.push(`Sets observed (this run): ${summary.setCount}`);
  lines.push(`Sets per page requested: ${summary.setsPerPageRequested.join(', ') || '(none)'}`);
  lines.push(`Sets per page returned: ${summary.setsPerPageReturned.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Field presence (present/absent):');
  for (const field of PROBED_FIELD_NAMES) {
    const counts = summary.fieldPresence[field];
    lines.push(`  ${field}: present=${counts.present} absent=${counts.absent}`);
  }
  lines.push('');
  lines.push(
    `Observed state histogram: ${
      summary.observedStates.length > 0
        ? summary.observedStates.map((entry) => `${entry.value}=${entry.count}`).join(', ')
        : '(no state values observed)'
    }`,
  );
  lines.push(`Bye-shaped slots (null entrant): ${summary.byeShapedSlots}`);
  lines.push(
    `Non-singles-shaped entrants (participants.length > 1): ${summary.nonSinglesEntrants}`,
  );
  lines.push(`Non-SSBU sets (videogame id present, differs from SSBU): ${summary.nonSsbuSets}`);
  lines.push(`Absent-videogame sets (no videogame id at all): ${summary.absentVideogameSets}`);
  lines.push(
    `Distinct videogame ids observed: ${summary.distinctVideogameIds.join(', ') || '(none)'}`,
  );
  lines.push(
    `Estimated node lower bound (OUR OWN estimate — NOT start.gg's undocumented complexity metric): ${summary.estimatedNodeLowerBound}`,
  );
  lines.push(
    `Entrant-size filter comparison (Open Question 3): ${
      summary.entrantSizeComparison
        ? `${summary.entrantSizeComparison.verdict} (unfiltered=${summary.entrantSizeComparison.unfilteredCount}, filtered=${summary.entrantSizeComparison.filteredCount}, onlyInUnfiltered=[${summary.entrantSizeComparison.onlyInUnfiltered.join(', ')}], onlyInFiltered=[${summary.entrantSizeComparison.onlyInFiltered.join(', ')}])`
        : 'not probed (pass --probe-entrant-size to answer this)'
    }`,
  );
  lines.push(
    `Retry-After header observed on a rate-limit rejection: ${
      summary.retryAfterObserved === null
        ? 'not applicable (no rate-limit rejection this run)'
        : summary.retryAfterObserved
          ? 'yes'
          : 'no'
    }`,
  );
  return lines.join('\n');
}
