import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import {
  ACCOUNT_SCOPE,
  TRENDS_READ_TEMPLATES,
  buildSessionBucketsMark,
  buildTrendsBackfillInsights,
  type Insight,
  type Match,
} from '@smash-tracker/shared';
import { TrendsReadMark } from './TrendsReadMarks';

/**
 * Plan 39.1-40 (sketch 002-C "Pro desk", D-09, D-13, DD-12, UI-SPEC §7.10 /
 * §7.11 / §7.12): each Trends read card's evidence mark, drawn from the
 * insight the engine built — never ranked or recomputed here.
 */

const NOW_MS = Date.UTC(2026, 8, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GAMES_HREF = '?claim=tiltCost%3Aaccount%3Alast30#games';

function mk(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return { fighter_id: 8, opponent_id: 23, matchType: 'none', ...overrides } as Match;
}

function ownRead(templateId: string, matches: Match[]): Insight {
  const template = TRENDS_READ_TEMPLATES.find((t) => t.id === templateId)!;
  const [insight] = template.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return insight!;
}

/** 8 wins then 5 losses, three times: a TiltCost trend (tiltCost.test.ts's UNDERPERFORM_BLOCK). */
function tiltFixture(): Match[] {
  const block = [...Array(8).fill(true), ...Array(5).fill(false)] as boolean[];
  const outcomes = [...block, ...block, ...block];
  return outcomes.map((win, i) => mk({ id: `tc-${i}`, time: NOW_MS - (40 - i) * MINUTE, win }));
}

/** 10 sessions of 21 games: games 1-10 won, the rest lost — a SessionFatigue trend. */
function fatigueFixture(): Match[] {
  const matches: Match[] = [];
  let t = NOW_MS - 30 * 24 * HOUR;
  for (let s = 0; s < 10; s += 1) {
    for (let g = 0; g < 21; g += 1) {
      matches.push(mk({ id: `sf-${s}-${g}`, time: t, win: g < 10 }));
      t += MINUTE;
    }
    t += 4 * HOUR;
  }
  return matches;
}

/** Two opponents (distinct best / toughest) plus a trailing three-set event. */
function backfillFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 20; i += 1) {
    matches.push(
      mk({
        id: `bw-${i}`,
        time: NOW_MS - (200 - i) * HOUR,
        win: i % 2 === 0,
        opponent_id: i % 2 === 0 ? 1 : 10,
      }),
    );
  }
  // Set 1: won 2-0 vs rival; set 2: lost 1-2 vs rival; set 3: won 2-1 (no name).
  const sets: { won: boolean[]; opponent?: string }[] = [
    { won: [true, true], opponent: 'rival' },
    { won: [true, false, false], opponent: 'rival' },
    { won: [false, true, true] },
  ];
  let t = NOW_MS - 10 * HOUR;
  sets.forEach((set, s) => {
    set.won.forEach((win, g) => {
      t += 10 * MINUTE;
      matches.push(
        mk({
          id: `ev-${s}-${g}`,
          time: t,
          win,
          eventName: 'Genesis 12',
          externalId: `sgg:gen12-set${s}:g${g + 1}`,
          ...(set.opponent ? { opponent: set.opponent } : {}),
        }),
      );
    });
  });
  return matches;
}

function backfill(templateId: string): Insight {
  return buildTrendsBackfillInsights({
    matches: backfillFixture(),
    horizon: 'last30',
    nowMs: NOW_MS,
  }).find((insight) => insight.templateId === templateId)!;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
  );
}

function renderMark(insight: Insight, { probe = false } = {}) {
  return render(
    <MemoryRouter initialEntries={['/trends']}>
      <TrendsReadMark insight={insight} gamesHref={GAMES_HREF} />
      {probe && <LocationProbe />}
    </MemoryRouter>,
  );
}

function rateOf(claim: Insight['recent']): number {
  if (claim.kind !== 'evidenced') throw new Error('expected an evidenced claim');
  return claim.value.rate * 100;
}

describe('TrendsReadMark (39.1-40)', () => {
  it("TiltCost: one 'Next game' dumbbell row linking to the card's games, the spot rate against the baseline tick, on a 0 / 50 / 100% scale", () => {
    const insight = ownRead('tiltCost', tiltFixture());
    expect(['trend', 'suggestion']).toContain(insight.state);
    const { container } = renderMark(insight);

    const dumbbell = container.querySelector('[data-slot="comparison-bars-dumbbell"]');
    expect(dumbbell).not.toBeNull();
    const rows = dumbbell!.querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Next game');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe(GAMES_HREF);

    const dot = container.querySelector<HTMLElement>('[data-slot="dumbbell-recent-dot"]')!;
    const tick = container.querySelector<HTMLElement>('[data-slot="dumbbell-baseline-tick"]')!;
    expect(parseFloat(dot.style.left)).toBeCloseTo(rateOf(insight.recent), 5);
    expect(parseFloat(tick.style.left)).toBeCloseTo(rateOf(insight.baseline), 5);

    const scale = container.querySelector('[data-slot="trends-read-scale"]');
    expect(scale?.textContent?.replace(/\s+/g, '')).toBe('0%50%100%');
  });

  it("TiltCost (002-C): 'Next game' is a meta label and the rate-vs-baseline sits flush right in the row's trailing slot", () => {
    const insight = ownRead('tiltCost', tiltFixture());
    const { container } = renderMark(insight);
    // The innermost element carrying the label text (the kit wraps it in its truncating slot).
    const label = [...container.querySelectorAll('[data-slot="comparison-bars-dumbbell"] span')]
      .filter((el) => el.textContent === 'Next game')
      .pop()!;
    expect(label.className).toMatch(/\btext-xs\b/);
    expect(label.className).toMatch(/\btext-muted-foreground\b/);
    const trailing = container.querySelector('[data-slot="dumbbell-delta"]');
    expect(trailing?.textContent).toMatch(/^\d+% vs \d+%$/);
    expect(container.querySelector('[data-slot="dumbbell-record"]')?.textContent).toBe('');
  });

  it("TiltCost: following the 'Next game' row stays in the app (same route, the card's claim)", () => {
    renderMark(ownRead('tiltCost', tiltFixture()), { probe: true });
    fireEvent.click(document.querySelector('[data-slot="comparison-bars-dumbbell"] a')!);
    expect(screen.getByTestId('location').textContent).toBe(
      '/trends?claim=tiltCost%3Aaccount%3Alast30#games',
    );
  });

  it('SessionFatigue: three rows Games 1–10 / 11–20 / 21+ with rate and n', () => {
    const insight = ownRead('sessionFatigue', fatigueFixture());
    expect(['trend', 'suggestion']).toContain(insight.state);
    const { container } = renderMark(insight);

    const list = container.querySelector('[data-slot="trends-session-buckets"]');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('aria-label')).toBe('Win rate by game number within a session');
    const rows = [...list!.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Games 1–10');
    expect(rows[0]).toContain('100% · 100');
    expect(rows[1]).toContain('Games 11–20');
    expect(rows[1]).toContain('0% · 100');
    expect(rows[2]).toContain('Games 21+');
    expect(rows[2]).toContain('0% · 10');
    // The rows are text, never controls.
    expect(list!.querySelectorAll('a, button')).toHaveLength(0);
  });

  it('SessionFatigue: a bucket count is locale-formatted', () => {
    const base = ownRead('sessionFatigue', fatigueFixture());
    const insight: Insight = {
      ...base,
      mark: buildSessionBucketsMark([
        { fromGame: 1, toGame: 10, wins: 1000, losses: 234, total: 1234 },
        { fromGame: 11, toGame: 20, wins: 5, losses: 5, total: 10 },
        { fromGame: 21, toGame: null, wins: 1, losses: 9, total: 10 },
      ]),
    };
    const { container } = renderMark(insight);
    const first = container.querySelector('[data-slot="trends-session-buckets"] li');
    expect(first?.textContent).toContain('1,234');
  });

  it.each(['bestMatchup', 'worstMatchup'])('%s: a RecordBar of its record', (templateId) => {
    const insight = backfill(templateId);
    expect(insight.state).toBe('fact');
    const { container } = renderMark(insight);
    expect(container.querySelectorAll('[data-slot="record-bar"]')).toHaveLength(1);
  });

  it('LastEventRecap: a SetStrip with one tick per set', () => {
    const insight = backfill('lastEventRecap');
    expect(insight.state).toBe('fact');
    const { container } = renderMark(insight);
    const strip = container.querySelector('[data-slot="set-strip"]');
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute('aria-label')).toBe('3 sets — 2 won, 1 lost.');
    expect(strip!.children).toHaveLength(3);
    const titles = [...strip!.children].map((tick) => tick.getAttribute('title'));
    expect(titles).toEqual(['vs rival · 2–0', 'vs rival · 1–2', 'Set · 2–1']);
  });

  it('renders nothing for RatingMove, for a steady / locked / hidden / collapsed read, and for a malformed mark', () => {
    const tilt = ownRead('tiltCost', tiltFixture());
    const fatigue = ownRead('sessionFatigue', fatigueFixture());
    const rating = ownRead('ratingMove', tiltFixture());
    const cases: Insight[] = [
      rating,
      { ...tilt, state: 'steady' },
      { ...tilt, state: 'locked' },
      { ...fatigue, state: 'hidden' },
      { ...backfill('bestMatchup'), state: 'collapsed' },
      { ...fatigue, mark: { kind: 'sessionBuckets', data: { buckets: [] } } },
      { ...backfill('lastEventRecap'), mark: { kind: 'setStrip', data: { sets: 'x' } } },
    ];
    for (const insight of cases) {
      const { container, unmount } = renderMark(insight);
      expect(container.innerHTML, `${insight.templateId}/${insight.state}`).toBe('');
      unmount();
    }
  });
});
