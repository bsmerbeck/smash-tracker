import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { buildCareerTimeline, type Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { formatPercent } from '@/lib/formatPercent';
import { CareerTimelineCard } from './CareerTimelineCard';

/**
 * Plan 39.1-34 (UI-SPEC §12.1, sketch 002-C `RatingCard`): the Trends host —
 * real i18n (en), the kit rendered at an explicit `chartWidth` (the D-04 test
 * affordance). Header: title, the grain meta (hidden below xl) and the
 * GlickoExplainer; footer: one element per whole caption key.
 */
const PRO_MATCHES: Match[] = generateSyntheticMatches({
  seed: 39_134_001,
  count: 8_400,
  startMs: Date.UTC(2018, 11, 18, 18),
  sessionSizeRange: [6, 28],
  sessionGapMs: 135 * 60 * 60 * 1000,
  winRate: 0.73,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1],
});

/** 60 games in one month -> the thin state (session grain, no strips). */
const THIN_MATCHES: Match[] = generateSyntheticMatches({
  seed: 39_134_002,
  count: 60,
  startMs: Date.UTC(2026, 5, 1, 18),
  sessionSizeRange: [4, 8],
  sessionGapMs: 2 * 24 * 60 * 60 * 1000,
  winRate: 0.6,
});

function renderCard(matches: Match[]) {
  return render(<CareerTimelineCard matches={matches} horizon="last30" chartWidth={1000} />);
}

function captionItems(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="career-timeline-caption-item"]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('CareerTimelineCard (plan 39.1-34)', () => {
  const pro = buildCareerTimeline({ matches: PRO_MATCHES, horizon: 'last30', nowMs: Date.now() });

  it('titles the card "Career timeline" and renders the kit chart', () => {
    const { container } = renderCard(PRO_MATCHES);
    expect(screen.getByText('Career timeline')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="career-timeline"]')).not.toBeNull();
  });

  it('puts the grain meta in the header, hidden below xl (1280px)', () => {
    renderCard(PRO_MATCHES);
    const meta = screen.getByText('close of quarter · band = ±RD');
    expect(meta.className).toMatch(/\bhidden\b/);
    expect(meta.className).toMatch(/\bxl:inline\b/);
  });

  it('puts the GlickoExplainer trigger in the header', () => {
    const { container } = renderCard(PRO_MATCHES);
    const header = container.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'What is Glicko-2?' })).toBeInTheDocument();
  });

  it('captions the grain, the sessions, the ladder, the strip legend and the model — one element per whole key', () => {
    const { container } = renderCard(PRO_MATCHES);
    expect(captionItems(container)).toEqual([
      `${pro.rating.points.length} quarterly closes`,
      `${pro.rating.sessionCount} rated sessions`,
      `a monthly line would draw ${pro.rating.finerGrainPointCount} points`,
      `rate = win rate vs the ${Math.round(pro.baseline.rate * 100)}% all-time rate — blue above, amber below, no colour under 8 games`,
      'Glicko-2, unofficial.',
    ]);
  });

  it("labels the recent-window band with the active horizon's full name", () => {
    const { container } = renderCard(PRO_MATCHES);
    const band = container.querySelector('[data-slot="career-timeline-recent-band"]');
    expect(band?.textContent).toBe('Last 30 games');
  });

  it('separates caption items with a trailing middot, so a wrapped line never starts with one', () => {
    const { container } = renderCard(PRO_MATCHES);
    const items = Array.from(
      container.querySelectorAll('[data-slot="career-timeline-caption-item"]'),
    );
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) {
      expect(item.className).not.toMatch(/before:/);
      expect(item.className).toContain("[&:not(:last-child)]:after:content-['·']");
    }
  });

  it('is plural-correct at count 1 and drops the strip legend on a thin timeline', () => {
    const oneSession = generateSyntheticMatches({
      seed: 39_134_003,
      count: 6,
      startMs: Date.UTC(2026, 5, 1, 18),
      sessionSizeRange: [6, 6],
      winRate: 0.5,
    });
    const { container, unmount } = renderCard(oneSession);
    const items = captionItems(container);
    expect(items).toContain('1 rated session');
    expect(items).toContain('1 per-session close');
    expect(items.some((text) => text.startsWith('rate = win rate'))).toBe(false);
    unmount();
    const thin = renderCard(THIN_MATCHES);
    expect(captionItems(thin.container).some((text) => text.startsWith('rate = win rate'))).toBe(
      false,
    );
    expect(screen.getByText('close of session · band = ±RD')).toBeInTheDocument();
  });
});

/**
 * Plan 39.1-35 Task 1 (UI-SPEC §10.2 value leads, §12.1 one readout): the
 * host composes every readout line from whole keys. The pro fixture is
 * reshaped so three months are known exactly: March 2024 holds 5 games (3-2,
 * under the 8-game floor), May 2024 holds 12 straight wins (capped under 20
 * games), October 2024 holds a single win (plural at 1). Quarter grain, so a
 * month's rating in force is its quarter's close.
 */
describe('CareerTimelineCard (plan 39.1-35) — the readout copy', () => {
  const template = PRO_MATCHES[0]!;
  function crafted(prefix: string, startMs: number, wins: boolean[]): Match[] {
    return wins.map((win, i) => ({
      ...template,
      id: `${prefix}-${i}`,
      time: startMs + i * 5 * 60 * 1000,
      win,
    }));
  }
  const REMOVED_MONTHS = [
    [Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1)],
    [Date.UTC(2024, 4, 1), Date.UTC(2024, 5, 1)],
    [Date.UTC(2024, 9, 1), Date.UTC(2024, 10, 1)],
  ] as const;
  const READOUT_MATCHES: Match[] = [
    ...PRO_MATCHES.filter(
      (m) => !REMOVED_MONTHS.some(([from, to]) => m.time >= from && m.time < to),
    ),
    ...crafted('mar', Date.UTC(2024, 2, 10, 18), [true, true, true, false, false]),
    ...crafted(
      'may',
      Date.UTC(2024, 4, 10, 18),
      Array.from({ length: 12 }, () => true),
    ),
    ...crafted('oct', Date.UTC(2024, 9, 10, 18), [true]),
  ].sort((a, b) => a.time - b.time);
  const timeline = buildCareerTimeline({
    matches: READOUT_MATCHES,
    horizon: 'last30',
    nowMs: Date.now(),
  });
  const baseline = formatPercent(timeline.baseline.rate, 'en');
  const cells = timeline.strips!.wide.cells;
  const cellAt = (ms: number) => cells.find((c) => c.startMs === ms)!;

  function renderReadoutCard(matches: Match[] = READOUT_MATCHES) {
    const onSelectPeriod = vi.fn();
    const utils = render(
      <CareerTimelineCard
        matches={matches}
        horizon="last30"
        chartWidth={1000}
        onSelectPeriod={onSelectPeriod}
      />,
    );
    return { ...utils, onSelectPeriod };
  }

  function readoutLines(container: HTMLElement): string[] {
    const el = container.querySelector('[data-slot="career-timeline-readout"]');
    expect(el, 'a readout is shown').not.toBeNull();
    return [
      el!.querySelector('[data-slot="career-timeline-readout-title"]')?.textContent ?? '',
      ...Array.from(el!.querySelectorAll('[data-slot="career-timeline-readout-line"]')).map(
        (line) => line.textContent ?? '',
      ),
    ];
  }

  function hoverCell(container: HTMLElement, startMs: number) {
    const cellEl = container.querySelector(
      `[data-slot="career-timeline-rate-cell"][data-start-ms="${startMs}"]`,
    );
    expect(cellEl, `a rate cell starting at ${new Date(startMs).toISOString()}`).not.toBeNull();
    const hit = container.querySelector('[data-slot="career-timeline-hit"]');
    expect(hit, 'the hit rect').not.toBeNull();
    fireEvent.pointerMove(hit!, {
      clientX: Number(cellEl!.getAttribute('x')) + Number(cellEl!.getAttribute('width')) / 2,
      clientY: Number(cellEl!.getAttribute('y')) + 7,
    });
    return cellEl!;
  }

  function hoverPoint(container: HTMLElement, index: number) {
    const anchor = container.querySelectorAll('[data-slot="career-timeline-point"]')[index];
    expect(anchor, `anchor ${index}`).not.toBeUndefined();
    const plot = container.querySelector('[data-slot="career-timeline-plot-area"]')!;
    const hit = container.querySelector('[data-slot="career-timeline-hit"]');
    expect(hit, 'the hit rect').not.toBeNull();
    fireEvent.pointerMove(hit!, {
      clientX: Number(anchor!.getAttribute('cx')),
      clientY: Number(plot.getAttribute('y')) + 30,
    });
  }

  function ptsLine(deltaPoints: number): string {
    const magnitude = new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(
      Math.abs(deltaPoints),
    );
    if (Math.abs(deltaPoints) < 0.5) return `level with the ${baseline} all-time rate`;
    return deltaPoints > 0
      ? `+${magnitude} pts vs the ${baseline} all-time rate`
      : `−${magnitude} pts vs the ${baseline} all-time rate`;
  }

  it('a month cell reads its UTC month, the rating at its quarter close, its record and its points vs the all-time rate — in that order', () => {
    const aug = cellAt(Date.UTC(2024, 7, 1));
    expect(aug.total).toBeGreaterThanOrEqual(20);
    expect(aug.ratingAtClose?.key).toBe('quarter:2024-Q3');
    const { container } = renderReadoutCard();
    hoverCell(container, aug.startMs);
    expect(readoutLines(container)).toEqual([
      'Aug 2024',
      `Rating at the 2024 Q3 close · ${aug.ratingAtClose!.rating} ±${aug.ratingAtClose!.rd}`,
      `${aug.wins}–${aug.losses} · ${formatPercent(aug.rate, 'en')} · ${aug.total} games`,
      ptsLine(aug.deltaPoints),
    ]);
  });

  it('a 5-game month shows the under-8 reason INSTEAD of a points line', () => {
    const mar = cellAt(Date.UTC(2024, 2, 1));
    expect(mar.total).toBe(5);
    const { container } = renderReadoutCard();
    hoverCell(container, mar.startMs);
    expect(readoutLines(container)).toEqual([
      'Mar 2024',
      `Rating at the 2024 Q1 close · ${mar.ratingAtClose!.rating} ±${mar.ratingAtClose!.rd}`,
      '3–2 · 60% · 5 games',
      '5 games — under 8, no colour step',
    ]);
  });

  it('a capped 12-game month adds "under 20 games — colour capped"', () => {
    const may = cellAt(Date.UTC(2024, 4, 1));
    expect(may.total).toBe(12);
    expect(may.rateStepReason).toBe('capped');
    const { container } = renderReadoutCard();
    hoverCell(container, may.startMs);
    expect(readoutLines(container)).toEqual([
      'May 2024',
      `Rating at the 2024 Q2 close · ${may.ratingAtClose!.rating} ±${may.ratingAtClose!.rd}`,
      '12–0 · 100% · 12 games',
      ptsLine(may.deltaPoints),
      'under 20 games — colour capped',
    ]);
  });

  it('is plural-correct at 1 game', () => {
    const oct = cellAt(Date.UTC(2024, 9, 1));
    expect(oct.total).toBe(1);
    const { container } = renderReadoutCard();
    hoverCell(container, oct.startMs);
    const lines = readoutLines(container);
    expect(lines).toContain('1–0 · 100% · 1 game');
    expect(lines).toContain('1 game — under 8, no colour step');
  });

  it('a quarter point reads its period, "Rating r ±rd", its record and its points line', () => {
    const index = timeline.rating.points.findIndex((p) => p.key === 'quarter:2024-Q3');
    expect(index).toBeGreaterThanOrEqual(0);
    const point = timeline.rating.points[index]!;
    const { container } = renderReadoutCard();
    hoverPoint(container, index);
    const delta = Math.round((point.wins / point.total - timeline.baseline.rate) * 1000) / 10;
    expect(readoutLines(container)).toEqual([
      '2024 Q3',
      `Rating ${point.rating} ±${point.rd}`,
      `${point.wins}–${point.losses} · ${formatPercent(point.wins / point.total, 'en')} · ${point.total} games`,
      ptsLine(delta),
    ]);
  });

  it('a session point is titled by its local session date', () => {
    const thin = buildCareerTimeline({
      matches: THIN_MATCHES,
      horizon: 'last30',
      nowMs: Date.now(),
    });
    const point = thin.rating.points[0]!;
    const { container } = renderReadoutCard(THIN_MATCHES);
    hoverPoint(container, 0);
    const lines = readoutLines(container);
    expect(lines[0]).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(point.startMs)),
    );
    expect(lines[1]).toBe(`Rating ${point.rating} ±${point.rd}`);
    expect(lines[2]).toBe(
      `${point.wins}–${point.losses} · ${formatPercent(point.wins / point.total, 'en')} · ${point.total} ${point.total === 1 ? 'game' : 'games'}`,
    );
  });

  it('passes a click on a month through as onSelectPeriod({ fromMs, toMs = end - 1 })', () => {
    const aug = cellAt(Date.UTC(2024, 7, 1));
    const { container, onSelectPeriod } = renderReadoutCard();
    const cellEl = hoverCell(container, aug.startMs);
    fireEvent.click(container.querySelector('[data-slot="career-timeline-hit"]')!, {
      clientX: Number(cellEl.getAttribute('x')) + Number(cellEl.getAttribute('width')) / 2,
      clientY: Number(cellEl.getAttribute('y')) + 7,
    });
    expect(onSelectPeriod).toHaveBeenCalledWith({ fromMs: aug.startMs, toMs: aug.endMs - 1 });
  });
});
