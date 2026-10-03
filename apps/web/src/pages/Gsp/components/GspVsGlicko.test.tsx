import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GspPoint, GspSettings, Match } from '@smash-tracker/shared';
import { computeRatingHistory } from '@/lib/glicko';
import { toMmrSeries } from '../lib/gspMmrModel';
import { buildGspVsGlickoPanels } from '../lib/gspVsGlicko';
import { GspVsGlicko } from './GspVsGlicko';

vi.mock('@/hooks/useGspLive', () => ({
  useGspLive: () => ({ data: undefined }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 0, 6, 18);
const settings: GspSettings = { eliteThreshold: 10_500_000, updatedAt: START_MS };

/** One quickplay match per day, each carrying a GSP reading (so the GSP series and the sessions line up). */
function makeMatches(count: number, stepDays = 1): Match[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    fighter_id: 8,
    opponent_id: 1,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'quickplay' as const,
    win: i % 3 !== 0,
    time: START_MS + i * stepDays * DAY_MS,
    gsp: 9_800_000 + i * 40_000,
  }));
}

function seriesOf(matches: Match[]): GspPoint[] {
  return matches.map((m) => ({ time: m.time, gsp: m.gsp!, win: m.win }));
}

function renderCard(matches: Match[], props: Partial<Parameters<typeof GspVsGlicko>[0]> = {}) {
  return render(
    <GspVsGlicko
      gspSeries={seriesOf(matches)}
      allMatches={matches}
      settings={settings}
      chartWidth={830}
      {...props}
    />,
  );
}

describe('GspVsGlicko as two stacked panels (plan 41-07, A3)', () => {
  it('renders the two panels on one time axis inside a compact card, with no canvas', () => {
    const { container } = renderCard(makeMatches(12));
    expect(screen.getByText('Est. MMR vs Glicko-2')).toBeInTheDocument();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelectorAll('[data-slot="multiples-panel"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="trend-value-plot"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="trend-value-x-axis"]')).toHaveLength(1);
    const titles = Array.from(
      container.querySelectorAll('[data-slot="multiples-panel-title"]'),
    ).map((el) => el.textContent);
    expect(titles).toEqual(['Est. MMR', 'Glicko-2']);
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      '2 panels sharing one time axis',
    );
  });

  it('names the shared grain in the head and states the two-scale caption twice-honestly', () => {
    const { container } = renderCard(makeMatches(12));
    expect(container.querySelector('[data-slot="gsp-vs-glicko-grain"]')?.textContent).toBe(
      'By reading',
    );
    expect(
      screen.getByText(/Each panel keeps its own scale, so compare the shapes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/compare the shapes, not the heights/)).toBeInTheDocument();
  });

  it('keeps each panel on its own fitted y: the two y domains differ (T-41-20, never normalised)', () => {
    const { container } = renderCard(makeMatches(12));
    const domains = Array.from(container.querySelectorAll('[data-slot="trend-line-value"]')).map(
      (root) => root.getAttribute('data-y-domain'),
    );
    expect(domains).toHaveLength(2);
    expect(new Set(domains).size).toBe(2);
    // Neither domain is the 0-100 the old overlay squeezed both series into.
    domains.forEach((domain) => expect(domain).not.toBe('0,100'));
  });

  it('draws the crosshair in both panels and lists both ratings, value first, in the one readout', () => {
    const matches = makeMatches(12);
    const { container } = renderCard(matches);
    const periods = computeRatingHistory(matches).periods;
    const hit = container.querySelectorAll('[data-slot="trend-value-hit"]')[0]!;
    const lastMmr = container.querySelector('[data-slot="trend-value-dot"]')!;
    fireEvent.pointerMove(hit, {
      clientX: Number(lastMmr.getAttribute('cx')),
      pointerType: 'mouse',
    });
    expect(container.querySelectorAll('[data-slot="trend-value-crosshair"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="multiples-readout"]')).toHaveLength(1);
    const lines = Array.from(
      container.querySelectorAll('[data-slot="multiples-readout-line"]'),
    ).map((el) => el.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Est\. MMR · [\d,]+$/);
    const last = periods[periods.length - 1]!;
    expect(lines[1]).toBe(
      `Glicko-2 · ${last.rating.toLocaleString('en')} ±${last.rd.toLocaleString('en')}`,
    );
  });

  it('raises onSelectReading with the reading index when an MMR reading is clicked, and nothing from the Glicko panel', () => {
    const matches = makeMatches(12);
    const onSelectReading = vi.fn();
    const onSelectPeriod = vi.fn();
    const { container } = renderCard(matches, { onSelectReading, onSelectPeriod });
    const hits = container.querySelectorAll('[data-slot="trend-value-hit"]');
    const marks = container.querySelectorAll('[data-slot="trend-value-dot"]');
    expect(hits).toHaveLength(2);

    // Each panel draws its last point as the one dot: [0] is the MMR panel's, [1] the Glicko panel's.
    fireEvent.click(hits[0]!, { clientX: Number(marks[0]!.getAttribute('cx')), clientY: 60 });
    expect(onSelectReading).toHaveBeenCalledTimes(1);
    expect(onSelectReading).toHaveBeenLastCalledWith(11);

    fireEvent.click(hits[1]!, { clientX: Number(marks[1]!.getAttribute('cx')), clientY: 60 });
    expect(onSelectReading).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).not.toHaveBeenCalled();
  });

  it('puts both panels on the coarser shared grain and routes an MMR close click to onSelectPeriod (DD-41-12)', () => {
    const matches = makeMatches(240);
    const onSelectReading = vi.fn();
    const onSelectPeriod = vi.fn();
    const { container } = renderCard(matches, { onSelectReading, onSelectPeriod });
    const periods = computeRatingHistory(matches).periods;
    const built = buildGspVsGlickoPanels({ mmr: toMmrSeries(seriesOf(matches)), periods });

    expect(built.grain).not.toBe('reading');
    expect(built.mmr.grain).toBe(built.glicko.grain);
    expect(container.querySelector('[data-slot="gsp-vs-glicko-grain"]')?.textContent).not.toBe(
      'By reading',
    );

    const target = built.mmr.points[3]!;
    expect(target.memberIndexes.length).toBeGreaterThan(1);
    const mark = container.querySelector(`[data-point-key="${target.key}"]`)!;
    const hit = container.querySelectorAll('[data-slot="trend-value-hit"]')[0]!;
    fireEvent.click(hit, { clientX: Number(mark.getAttribute('cx')), clientY: 60 });
    expect(onSelectPeriod).toHaveBeenCalledTimes(1);
    expect(onSelectPeriod).toHaveBeenCalledWith(target.memberIndexes);
    expect(onSelectReading).not.toHaveBeenCalled();
  });

  it('renders nothing when either series is below the shared minimum (one gate)', () => {
    const matches = makeMatches(12);
    // Fewer than 3 GSP readings for the fighter, plenty of rating periods.
    const thinGsp = renderCard(matches, { gspSeries: seriesOf(matches).slice(0, 2) });
    expect(thinGsp.container.firstChild).toBeNull();
    thinGsp.unmount();
    // Plenty of GSP readings, but only 2 rating periods (all matches inside two sessions).
    const twoSessions = makeMatches(12).map((m, i) => ({
      ...m,
      time: START_MS + (i < 6 ? i * 60_000 : 30 * DAY_MS + i * 60_000),
    }));
    const thinPeriods = renderCard(twoSessions, { gspSeries: seriesOf(makeMatches(12)) });
    expect(computeRatingHistory(twoSessions).periods.length).toBe(2);
    expect(thinPeriods.container.firstChild).toBeNull();
  });
});
