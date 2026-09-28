import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { buildCareerTimeline, type Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { formatPercent } from '@/lib/formatPercent';
import { buildFormStripSetKeys } from '@/lib/formStripEvents';
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
    // Sketch 002-C precision: whole points, one decimal only below 1 pt.
    const magnitude = new Intl.NumberFormat('en', {
      maximumFractionDigits: Math.abs(deltaPoints) < 1 ? 1 : 0,
    }).format(Math.abs(deltaPoints));
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
    // plan 39.1-35 fidelity: sketch 002-C prints whole points at 1 pt and above.
    if (Math.abs(aug.deltaPoints) >= 1) {
      expect(readoutLines(container)[3]).toMatch(/^[+−]\d+ pts /);
    }
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

/**
 * Plan 39.1-35 Task 2 (D-07, UI-SPEC §12.1 / §14.4, sketch 002-C 640): the
 * thin account's per-game FormStrip, the locked inset, the table twin, and
 * the owner's 2026-09-25 diamonds-off decision on the Trends host.
 */
describe('CareerTimelineCard (plan 39.1-35) — thin strip, locked inset, twin, no diamonds', () => {
  /** guard:layout's `casual` scale: 41 games over three months -> thin. */
  const CASUAL_MATCHES: Match[] = generateSyntheticMatches({
    seed: 39_135_001,
    count: 41,
    startMs: Date.UTC(2026, 6, 3, 19),
    sessionSizeRange: [2, 6],
    sessionGapMs: 156 * 60 * 60 * 1000,
    winRate: 0.56,
  });
  /** 150 games inside two months -> thin, more games than the strip's 60. */
  const THIN_150: Match[] = generateSyntheticMatches({
    seed: 39_135_002,
    count: 150,
    startMs: Date.UTC(2026, 5, 1, 18),
    sessionSizeRange: [4, 8],
    sessionGapMs: 2 * 24 * 60 * 60 * 1000,
    winRate: 0.55,
  });

  function renderThin(matches: Match[], onSelectSet = vi.fn()) {
    const utils = render(
      <CareerTimelineCard
        matches={matches}
        horizon="last30"
        chartWidth={1000}
        onSelectSet={onSelectSet}
      />,
    );
    return { ...utils, onSelectSet };
  }

  it('thin (41 games, 3 months): per-session dots, no month strips, the per-game FormStrip with "All 41 games · by session"', () => {
    const thin = buildCareerTimeline({
      matches: CASUAL_MATCHES,
      horizon: 'last30',
      nowMs: Date.now(),
    });
    expect(thin.state).toBe('thin');
    const { container } = renderThin(CASUAL_MATCHES);
    const root = container.querySelector('[data-slot="career-timeline"][data-state="thin"]');
    expect(root).not.toBeNull();
    expect(root!.querySelector('[data-slot="career-timeline-strips"]')).toBeNull();
    expect(root!.querySelectorAll('[data-slot="career-timeline-dot"]')).toHaveLength(
      thin.rating.points.length,
    );
    const slot = root!.querySelector('[data-slot="career-timeline-thin-strip"]');
    expect(slot).not.toBeNull();
    const strip = slot!.querySelector('[data-slot="form-strip-root"]');
    expect(strip).not.toBeNull();
    expect(strip!.querySelector('[data-slot="form-strip-overline"]')?.textContent).toBe(
      'All 41 games · by session — per-game grain replaces the month strips',
    );
    expect(strip!.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(41);
  });

  it('thin with more games than the strip draws: no "All N games" overline, the FormStrip states what it shows', () => {
    const { container } = renderThin(THIN_150);
    const slot = container.querySelector('[data-slot="career-timeline-thin-strip"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('[data-slot="form-strip-overline"]')).toBeNull();
    expect(slot!.textContent).not.toMatch(/All \d+ games/);
    // REWRITTEN by plan 39.1-42 (sketch 003 foot wording).
    expect(slot!.querySelector('[data-slot="form-strip-shown-of-total"]')?.textContent).toMatch(
      /^\d+ of 150 games shown · older events drop first · oldest → newest$/,
    );
  });

  // Plan 39.1-42 (PD-42-4 / PD-42-5, sketch 002-C: a play session is ONE set,
  // 5px phone ticks): the casual strip draws ALL 41 games at the strip
  // widths guard:layout measured on trends-casual (1094px at 1440; 324px at
  // 390, the phone class).
  it('casual-41-at-1440: at the 1094px strip width every one of the 41 games is drawn; no shown-of-total, the foot reads "all 41 games · oldest → newest"', () => {
    const { container } = render(
      <CareerTimelineCard
        matches={CASUAL_MATCHES}
        horizon="last30"
        chartWidth={1000}
        stripWidthPx={1094}
      />,
    );
    const slot = container.querySelector('[data-slot="career-timeline-thin-strip"]')!;
    expect(slot.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(41);
    expect(slot.querySelector('[data-slot="form-strip-shown-of-total"]')).toBeNull();
    expect(
      slot.querySelector('[data-slot="form-strip-foot"]')?.firstElementChild?.textContent,
    ).toBe('all 41 games · oldest → newest');
  });

  it('casual-41-at-324px: on a phone (5px ticks, 76px events) the 324px strip still draws every one of the 41 games', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: /max-width:\s*639/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const { container } = render(
        <CareerTimelineCard
          matches={CASUAL_MATCHES}
          horizon="last30"
          chartWidth={320}
          stripWidthPx={324}
        />,
      );
      const slot = container.querySelector('[data-slot="career-timeline-thin-strip"]')!;
      expect(slot.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(41);
      expect(slot.querySelectorAll('[data-slot="form-strip-set"]')).toHaveLength(10);
      expect(slot.querySelector('[data-slot="form-strip-shown-of-total"]')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('no-window (fidelity T1): the casual account at last 30 has no recent window (collapsed horizons), so no tick is dimmed — sketch 002-C draws the strip at full strength', () => {
    const { container } = renderThin(CASUAL_MATCHES);
    const ticks = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="career-timeline-thin-strip"] [data-slot="form-strip-tick"]',
      ),
    );
    expect(ticks).toHaveLength(41);
    expect(ticks.filter((tick) => tick.style.opacity === '0.32')).toHaveLength(0);
  });

  it('conditional title: the overline becomes the kit head title (with the swatch legend) exactly when every game is drawn, and no head otherwise', () => {
    const { container: casual } = renderThin(CASUAL_MATCHES);
    const head = casual.querySelector(
      '[data-slot="career-timeline-thin-strip"] [data-slot="form-strip-head"]',
    );
    expect(head).not.toBeNull();
    expect(head!.querySelector('[data-slot="form-strip-overline"]')?.textContent).toBe(
      'All 41 games · by session — per-game grain replaces the month strips',
    );
    expect(head!.querySelectorAll('[data-slot="form-strip-legend-item"]')).toHaveLength(4);
    const { container: many } = renderThin(THIN_150);
    expect(
      many.querySelector('[data-slot="career-timeline-thin-strip"] [data-slot="form-strip-head"]'),
    ).toBeNull();
  });

  it("a form-strip set click calls onSelectSet with that set's key", () => {
    const { container, onSelectSet } = renderThin(CASUAL_MATCHES);
    const set = container.querySelector(
      '[data-slot="career-timeline-thin-strip"] [data-slot="form-strip-set"]',
    );
    expect(set).not.toBeNull();
    fireEvent.click(set!);
    expect(onSelectSet).toHaveBeenCalledTimes(1);
    const key = onSelectSet.mock.calls[0]![0] as string;
    // REWRITTEN by plan 39.1-42 (PD-42-4): the key is a play-session set key
    // from the ONE strip derivation (was a per-game `game:<id>` key).
    expect([...buildFormStripSetKeys(CASUAL_MATCHES).values()]).toContain(key);
    expect(key).toMatch(/^manual-session:/);
  });

  it('locked (3 games): the inset names how many games unlock the chart, with a 3-of-5 meter and no chart', () => {
    const { container } = render(
      <CareerTimelineCard matches={PRO_MATCHES.slice(0, 3)} horizon="last30" chartWidth={1000} />,
    );
    const inset = container.querySelector('[data-slot="career-timeline-locked"]');
    expect(inset?.textContent).toContain('Career timeline — 2 more games unlock this chart');
    expect(
      within(inset as HTMLElement)
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('3 of 5 games');
    expect(container.querySelector('[data-slot="career-timeline"] svg')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View as table' })).toBeNull();
  });

  it('locked (0 games): "5 more games" and a 0-of-5 meter — never an empty frame', () => {
    const { container } = render(
      <CareerTimelineCard matches={[]} horizon="last30" chartWidth={1000} />,
    );
    const inset = container.querySelector('[data-slot="career-timeline-locked"]');
    expect(inset?.textContent).toContain('Career timeline — 5 more games unlock this chart');
    expect(
      within(inset as HTMLElement)
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('0 of 5 games');
  });

  it('is plural-correct at 1 game to unlock', () => {
    const { container } = render(
      <CareerTimelineCard matches={PRO_MATCHES.slice(0, 4)} horizon="last30" chartWidth={1000} />,
    );
    expect(container.querySelector('[data-slot="career-timeline-locked"]')?.textContent).toContain(
      'Career timeline — 1 more game unlocks this chart',
    );
  });

  it('table twin: "View as table" opens the rating-close and year x month tables', () => {
    const pro = buildCareerTimeline({ matches: PRO_MATCHES, horizon: 'last30', nowMs: Date.now() });
    const { container } = render(
      <CareerTimelineCard matches={PRO_MATCHES} horizon="last30" chartWidth={1000} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const tables = container.querySelectorAll('[data-slot="career-timeline-table"] table');
    expect(tables).toHaveLength(2);
    expect(tables[0]!.querySelector('caption')?.textContent).toBe(
      'Rating at the close of each period',
    );
    expect(tables[0]!.querySelectorAll('tbody tr')).toHaveLength(pro.rating.points.length);
    expect(tables[0]!.querySelector('tbody tr th, tbody tr td')?.textContent).toBe(
      periodTitleEn(pro.rating.points[0]!.startMs),
    );
    expect(tables[1]!.querySelector('caption')?.textContent).toBe('Win rate and games by month');
    const years = new Set(PRO_MATCHES.map((m) => new Date(m.time).getUTCFullYear()));
    expect(tables[1]!.querySelectorAll('tbody tr')).toHaveLength(years.size);
    expect(tables[1]!.querySelector('tbody tr th')?.textContent).toBe(String(Math.max(...years)));
  });

  it("passes NO event markers (owner decision 2026-09-25: diamonds are off until Phase 39.2's tier data)", () => {
    const { container } = renderCard(PRO_MATCHES);
    expect(container.querySelector('[data-slot="career-timeline"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="career-timeline-event"]')).toHaveLength(0);
  });
});

/** The pro fixture's quarter title in en ("2018 Q4"). */
function periodTitleEn(startMs: number): string {
  const d = new Date(startMs);
  return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
