import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { buildCareerTimeline, type Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { AuthProvider } from '@/context/AuthContext';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { CareerTimeline, type CareerTimelineLabels } from '@/components/charts/CareerTimeline';
import { sortMatchesNewestFirst, type DrillDownAxes } from '@/lib/drillDownParams';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 't@example.com' }) },
    matches: { remove: vi.fn().mockResolvedValue(undefined) },
  },
}));

/**
 * Plan 39.1-35 (UI-SPEC §10.3 one URL contract, §12.1 "click a period →
 * from / to → FilteredMatchList"): the career timeline's same-n oracle. For
 * EVERY strip cell (wide and narrow) and EVERY rating point of a committed
 * fixture, the drill the kit ACTUALLY emits when that target is clicked
 * (`onSelectPeriod`, which the page writes as the inclusive `from` / `to`
 * axes) narrows the Trends terminus to exactly the readout's `total` —
 * proven by rendering `FilteredMatchList` itself and reading its
 * `data-total-rows`, one render per target.
 *
 * Fixture: ~300 games over 8 calendar months (Jan–Aug 2025) with April empty
 * (a one-month hole — the line breaks there), small sessions so the ladder
 * leaves the per-session grain for calendar weeks: the point drills exercise
 * the calendar bucket rule, not only session spans.
 */
const NOW_MS = Date.UTC(2025, 8, 15);
const COMMON = {
  sessionSizeRange: [1, 3] as [number, number],
  sessionGapMs: 38 * 60 * 60 * 1000,
  winRate: 0.56,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1, 3],
};
const BEFORE_HOLE = generateSyntheticMatches({
  ...COMMON,
  seed: 39_135_101,
  count: 110,
  startMs: Date.UTC(2025, 0, 2, 18),
}).filter((m) => m.time < Date.UTC(2025, 3, 1));
const AFTER_HOLE = generateSyntheticMatches({
  ...COMMON,
  seed: 39_135_102,
  count: 190,
  startMs: Date.UTC(2025, 4, 2, 18),
}).filter((m) => m.time < Date.UTC(2025, 8, 1));
const MATCHES: Match[] = [...BEFORE_HOLE, ...AFTER_HOLE];
const SORTED = sortMatchesNewestFirst(MATCHES);
const TIMELINE = buildCareerTimeline({ matches: MATCHES, horizon: 'last30', nowMs: NOW_MS });

interface Target {
  name: string;
  kind: 'cell' | 'point';
  width: number;
  index: number;
  fromMs: number;
  toMs: number;
  total: number;
}

const LABELS: CareerTimelineLabels = {
  rate: 'rate',
  games: 'games',
  aria: 'Career timeline',
  value: (rating) => String(rating),
  rd: (rd) => `±${rd}`,
  peakClose: (rating) => `${rating} · peak close`,
  lowClose: (rating) => `${rating} · low close`,
  peak: (rating) => `${rating} · peak`,
  low: (rating) => `${rating} · low`,
  readout: (target) => ({
    title: target.kind,
    lines: [target.kind === 'point' ? String(target.point.total) : ''],
  }),
};

/** Clicks the target on the rendered kit chart and returns the range the kit emitted. */
function clickedRange(target: Target): { fromMs: number; toMs: number } | undefined {
  const onSelectPeriod = vi.fn();
  const { container } = render(
    <CareerTimeline
      timeline={TIMELINE}
      labels={LABELS}
      width={target.width}
      onSelectPeriod={onSelectPeriod}
    />,
  );
  const hit = container.querySelector('[data-slot="career-timeline-hit"]');
  expect(hit, 'the timeline hit rect').not.toBeNull();
  if (target.kind === 'cell') {
    const cellEl = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]')[
      target.index
    ]!;
    fireEvent.click(hit!, {
      clientX: Number(cellEl.getAttribute('x')) + Number(cellEl.getAttribute('width')) / 2,
      clientY: Number(cellEl.getAttribute('y')) + 7,
    });
  } else {
    const anchor = container.querySelectorAll('[data-slot="career-timeline-point"]')[target.index]!;
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    fireEvent.click(hit!, {
      clientX: Number(anchor.getAttribute('cx')),
      clientY: Number(plot.getAttribute('y')) + 20,
    });
  }
  cleanup();
  expect(onSelectPeriod).toHaveBeenCalledTimes(1);
  return onSelectPeriod.mock.calls[0]?.[0];
}

const CELL_TARGETS: Target[] = (TIMELINE.strips?.wide.cells ?? []).map((cell, index) => ({
  name: `cell ${cell.key}`,
  kind: 'cell',
  width: 1000,
  index,
  fromMs: cell.startMs,
  toMs: cell.endMs - 1,
  total: cell.total,
}));
const NARROW_CELL_TARGETS: Target[] = (TIMELINE.strips?.narrow.cells ?? []).map((cell, index) => ({
  name: `narrow cell ${cell.key}`,
  kind: 'cell',
  width: 400,
  index,
  fromMs: cell.startMs,
  toMs: cell.endMs - 1,
  total: cell.total,
}));
const POINT_TARGETS: Target[] = TIMELINE.rating.points.map((point, index) => ({
  name: `point ${point.key}`,
  kind: 'point',
  width: 1000,
  index,
  fromMs: point.startMs,
  toMs: point.endMs - 1,
  total: point.total,
}));

function totalRowsAt(range: { fromMs: number; toMs: number }): number {
  const axes: DrillDownAxes = { from: range.fromMs, to: range.toMs };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
        <AuthProvider>
          <FilteredMatchList matches={SORTED} axes={axes} layout="stack" />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const list = container.querySelector('[data-total-rows]');
  const rows = list ? Number(list.getAttribute('data-total-rows')) : Number.NaN;
  cleanup();
  return rows;
}

describe('career timeline same-n (plan 39.1-35): every cell and period drills to exactly its games', () => {
  it('the fixture is non-vacuous: a full timeline, ≥ 7 month cells, ≥ 10 calendar points and a line break at the hole', () => {
    expect(TIMELINE.state).toBe('full');
    expect(CELL_TARGETS.length).toBeGreaterThanOrEqual(7);
    expect(POINT_TARGETS.length).toBeGreaterThanOrEqual(10);
    expect(TIMELINE.rating.grain).not.toBe('session');
    expect(TIMELINE.rating.points.some((point) => point.gapBefore)).toBe(true);
    expect(CELL_TARGETS.some((cell) => cell.name.includes('2025-04'))).toBe(false);
  });

  it.each([...CELL_TARGETS, ...NARROW_CELL_TARGETS, ...POINT_TARGETS])(
    'drill $name (from $fromMs to $toMs) lists exactly $total games',
    (target) => {
      expect(target.total).toBeGreaterThan(0);
      const range = clickedRange(target);
      expect(range).toEqual({ fromMs: target.fromMs, toMs: target.toMs });
      expect(totalRowsAt(range!)).toBe(target.total);
    },
    60_000,
  );

  it('the targets together cover every game once per strip set (the cells partition the account)', () => {
    const sum = (targets: Target[]) => targets.reduce((acc, t) => acc + t.total, 0);
    expect(sum(CELL_TARGETS)).toBe(MATCHES.length);
    expect(sum(NARROW_CELL_TARGETS)).toBe(MATCHES.length);
  });
});
