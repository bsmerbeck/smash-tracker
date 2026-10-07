import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FormStrip,
  SetStrip,
  type FormStripEvent,
  type FormStripGame,
  type FormStripSet,
} from './FormStrip';

function game(key: string, won: boolean): FormStripGame {
  return { key, won, label: `${won ? 'win' : 'loss'} ${key}` };
}

function twoEventFixture(inRecentWindow = true): FormStripEvent[] {
  return [
    {
      key: 'evt-1',
      label: 'Genesis 10',
      sets: [
        {
          key: 'set-1',
          label: 'Genesis 10, vs Alice, 2-1',
          inRecentWindow,
          games: [game('g1', true), game('g2', false), game('g3', true)],
        },
      ],
    },
    {
      key: 'evt-2',
      label: 'Weekly #12',
      sets: [
        {
          key: 'set-2',
          label: 'Weekly #12, vs Bob, 1-0',
          inRecentWindow,
          games: [game('g4', true)],
        },
      ],
    },
  ];
}

function ninetyGameFixture(): FormStripEvent[] {
  const sets = [];
  for (let s = 0; s < 18; s++) {
    const games: FormStripGame[] = [];
    for (let g = 0; g < 5; g++) {
      games.push(game(`s${s}-g${g}`, (s + g) % 2 === 0));
    }
    sets.push({
      key: `set-${s}`,
      label: `set ${s}`,
      inRecentWindow: true,
      games,
    });
  }
  return [{ key: 'evt-1', label: 'Long Event', sets }];
}

/** Plan 39.1-33: a formatter matching the three real hosts' wiring — `t('analytics.strip.shownOf', { shown, total })`'s English shape, without pulling in i18next for this kit-only test file. */
function shownOfTotalFormatter({ shown, total }: { shown: number; total: number }): string {
  return `${shown} of ${total} games shown`;
}

function singleGameSet(key: string, won: boolean): FormStripSet {
  return { key, label: `${key} set`, inRecentWindow: true, games: [game(key, won)] };
}

/**
 * Plan 39.1-33: three events (oldest A, middle B, newest C), each with four
 * single-game sets (12 games, well under the 30 limit used in the width-fit
 * cases below) — every set is `max(24, 1*8) = 24px` wide under jsdom's
 * fallback tick width, `+4` to the previously kept (newer) set's cost when
 * it shares an event, `+16` when it does not. Set/event ordering lets each
 * width-fit test assert exactly which sets/events survive.
 */
function threeEventFourSetFixture(): FormStripEvent[] {
  return ['A', 'B', 'C'].map((label) => ({
    key: `evt-${label}`,
    label: `Event ${label}`,
    sets: Array.from({ length: 4 }, (_, i) => singleGameSet(`${label}${i + 1}`, i % 2 === 0)),
  }));
}

/** Plan 39.1-33: one event, five three-game sets (15 games) — a three-game set is `max(24, 3*8 + 2*2) = 28px` wide, not the 24px single-game minimum. */
function oneEventFiveThreeGameSetsFixture(): FormStripEvent[] {
  return [
    {
      key: 'evt-solo',
      label: 'Solo Long Event',
      sets: Array.from({ length: 5 }, (_, i) => ({
        key: `solo-set-${i + 1}`,
        label: `solo set ${i + 1}`,
        inRecentWindow: true,
        games: [game(`g${i + 1}a`, true), game(`g${i + 1}b`, false), game(`g${i + 1}c`, true)],
      })),
    },
  ];
}

/** WR-03: the summary is a formatter of the DRAWN vs total game counts, like `shownOfTotal`. */
function summaryFormatter({ shown, total }: { shown: number; total: number }): string {
  return `summary ${shown} of ${total}`;
}

/** Plan 39.1-42: the structured legend (sketch 003 `stripLegend`) — was one ' · '-joined string. */
const LEGEND = {
  win: 'up = win',
  loss: 'down = loss',
  setGap: 'gap = new set',
  eventLabel: 'label = event · W–L',
};

/** Plan 39.1-42: the foot's all-shown formatter (sketch 003 `fitStrips` note). */
function allShownFormatter({ total }: { total: number }): string {
  return `all ${total} games · oldest → newest`;
}

const emptyLabels = {
  summary: summaryFormatter,
  legend: LEGEND,
  shownOfTotal: shownOfTotalFormatter,
  allShown: allShownFormatter,
  empty: <p>No games in this view yet.</p>,
};

describe('FormStrip', () => {
  it('renders tick count, group boundaries and event labels for a two-event fixture', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
    expect(ticks).toHaveLength(4);
    const eventGroups = container.querySelectorAll('[data-slot="form-strip-event"]');
    expect(eventGroups).toHaveLength(2);
    expect(screen.getByText('Genesis 10')).toBeInTheDocument();
    expect(screen.getByText('Weekly #12')).toBeInTheDocument();
  });

  it('renders exactly 60 ticks and the shown-of-total label for a 90-game fixture at limit 60 (no width prop -> only limit applies)', () => {
    const { container } = render(
      <FormStrip
        events={ninetyGameFixture()}
        limit={60}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
      />,
    );
    const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
    expect(ticks).toHaveLength(60);
    expect(screen.getByText('60 of 90 games shown')).toBeInTheDocument();
  });

  it('renders no form-strip-shown-of-total when the source held no more than limit (12-game fixture, no width prop)', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
      />,
    );
    expect(container.querySelector('[data-slot="form-strip-shown-of-total"]')).toBeNull();
  });

  it('distinguishes win and loss ticks by vertical position, not colour', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const winTick = container.querySelector('[data-slot="form-strip-tick"][title^="win"]');
    const lossTick = container.querySelector('[data-slot="form-strip-tick"][title^="loss"]');
    expect((winTick as HTMLElement).style.alignItems).toBe('flex-start');
    expect((lossTick as HTMLElement).style.alignItems).toBe('flex-end');
    // No assertion in this suite depends on a colour value.
  });

  // REWRITTEN by plan 39.1-42: the legend is a structured head (only with a
  // title); at 0 games neither the head nor a legend item renders.
  it('renders the empty node, zero ticks, no legend and no group role at 0 games', () => {
    const { container } = render(
      <FormStrip events={[]} limit={60} labels={{ ...emptyLabels, title: 'Form' }} />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(0);
    expect(container.querySelector('[data-slot="form-strip-head"]')).toBeNull();
    expect(container.querySelector('[data-slot="form-strip-legend-item"]')).toBeNull();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByText('No games in this view yet.')).toBeInTheDocument();
  });

  it('renders exactly 1 real tick at 1 game, no padding', () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Solo Event',
        sets: [
          { key: 'set-1', label: 'solo set', inRecentWindow: true, games: [game('g1', true)] },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(1);
  });

  it('renders exactly 2 real ticks at 2 games, no padding', () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Duo Event',
        sets: [
          {
            key: 'set-1',
            label: 'duo set',
            inRecentWindow: true,
            games: [game('g1', true), game('g2', false)],
          },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(2);
  });

  // REWRITTEN by plan 39.1-42: `windowEmpty` is replaced by the foot's
  // `windowNote` (any window state), printed on the foot line.
  it('dims every tick and highlights nothing when games exist but none are in the recent window', () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture(false)}
        limit={60}
        labels={{ ...emptyLabels, windowNote: 'No games in the last 90 days — all games shown.' }}
      />,
    );
    const ticks = Array.from(container.querySelectorAll('[data-slot="form-strip-tick"]'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect((tick as HTMLElement).style.opacity).toBe('0.32');
    }
    const note = screen.getByText('No games in the last 90 days — all games shown.');
    expect(note.closest('[data-slot="form-strip-foot"]')).not.toBeNull();
  });

  it('makes a set a tab stop and a tick not a tab stop', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const set = container.querySelector('[data-slot="form-strip-set"]') as HTMLElement;
    const tick = container.querySelector('[data-slot="form-strip-tick"]') as HTMLElement;
    expect(set.tabIndex).toBe(0);
    expect(tick.tabIndex).toBe(-1);
  });

  it('fires onSelectSet with the set key on activation', async () => {
    const user = userEvent.setup();
    const onSelectSet = vi.fn();
    const { container } = render(
      <FormStrip
        events={twoEventFixture()}
        limit={60}
        labels={emptyLabels}
        onSelectSet={onSelectSet}
      />,
    );
    const set = container.querySelector('[data-slot="form-strip-set"]') as HTMLElement;
    await user.click(set);
    expect(onSelectSet).toHaveBeenCalledWith('set-1');
  });

  it('SetStrip renders nothing at 0 sets', () => {
    const { container } = render(<SetStrip sets={[]} ariaLabel="no sets" />);
    expect(container.firstChild).toBeNull();
  });

  it('SetStrip renders one tick per set', () => {
    render(
      <SetStrip
        sets={[
          { key: 's1', won: true, label: 'set 1 won' },
          { key: 's2', won: false, label: 'set 2 lost' },
        ]}
        ariaLabel="Sets: 1-1"
      />,
    );
    expect(screen.getByRole('img', { name: 'Sets: 1-1' })).toBeInTheDocument();
  });
});

describe('FormStrip — single row, group names, caption (plan 39.1-33, R1)', () => {
  it('the row carries flex-nowrap, overflow-hidden and min-w-0, and never flex-wrap or a horizontal-scroll utility', () => {
    render(<FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />);
    const row = screen.getByRole('group', { name: /^summary / });
    expect(row.className).toMatch(/\bflex-nowrap\b/);
    expect(row.className).toMatch(/\boverflow-hidden\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    expect(row.className).not.toMatch(/\bflex-wrap\b/);
    expect(row.className).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
  });

  // REWRITTEN by plan 39.1-42 (sketch 003 `.strip-ev`): an event column is
  // its tick row (sets only) then its label row; the 80 / 76px minimum
  // lives in CSS classes, never an inline style.
  it('every form-strip-event is a column of a set-only tick row then its label row, with the 80 / 76px minimum in CSS classes (no inline min-width)', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls.length).toBeGreaterThan(0);
    for (const eventEl of eventEls) {
      const el = eventEl as HTMLElement;
      expect(el.style.minWidth).toBe('');
      expect(el.className).toMatch(/\bflex-col\b/);
      expect(el.className).toContain('min-w-20');
      expect(el.className).toContain('max-sm:min-w-[76px]');
      const children = Array.from(el.children) as HTMLElement[];
      expect(children.map((child) => child.dataset.slot)).toEqual([
        'form-strip-event-ticks',
        'form-strip-event-label',
      ]);
      for (const set of Array.from(children[0]!.children)) {
        expect((set as HTMLElement).dataset.slot).toBe('form-strip-set');
      }
    }
  });

  it('each event carries role="group" and an aria-label and title both equal to "<label> · <record>" (two-event fixture)', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls.map((el) => el.getAttribute('role'))).toEqual(['group', 'group']);
    expect(eventEls.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Genesis 10 · 2–1',
      'Weekly #12 · 1–0',
    ]);
    expect(eventEls.map((el) => el.getAttribute('title'))).toEqual([
      'Genesis 10 · 2–1',
      'Weekly #12 · 1–0',
    ]);
  });

  // REWRITTEN by plan 39.1-42 (sketch 003 `.strip-label`, PD-42-1): plan
  // 33's first / last caption is gone — EVERY shown event carries its own
  // label row: the label (truncating, title = full label) and the drawn W–L.
  it('per-event-label: every shown event renders a label row with its truncating label (title = full label) and the drawn W–L; no caption slot renders', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const rows = Array.from(container.querySelectorAll('[data-slot="form-strip-event-label"]'));
    expect(rows).toHaveLength(2);
    const texts = rows.map((row) => Array.from(row.children).map((child) => child.textContent));
    expect(texts).toEqual([
      ['Genesis 10', '2–1'],
      ['Weekly #12', '1–0'],
    ]);
    for (const row of rows) {
      const [name, record] = Array.from(row.children) as HTMLElement[];
      expect(name!.className).toMatch(/\bmin-w-0\b/);
      expect(name!.className).toMatch(/\btruncate\b/);
      expect(name!.hasAttribute('data-truncate-guard')).toBe(true);
      expect(name).toHaveAttribute('title', name!.textContent ?? '');
      expect(record!.className).toMatch(/\btabular-nums\b/);
      expect(record!.className).toMatch(/\bwhitespace-nowrap\b/);
    }
    expect(container.querySelector('[data-slot^="form-strip-caption"]')).toBeNull();
  });

  it('per-event-label: a one-event fixture renders exactly one label row and no caption slot', () => {
    const events: FormStripEvent[] = [
      { key: 'evt-1', label: 'Solo Event', sets: [singleGameSet('g1', true)] },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-event-label"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot^="form-strip-caption"]')).toBeNull();
  });
});

/**
 * Plan 39.1-42 (sketch 003 `fitStrips`, PD-42-1): the fit is EVENT-level —
 * an event costs max(80px, its tick run), events are 16px apart, older
 * events drop first and the newest is always kept. Under jsdom the fallback
 * tick is 8px; each event of `threeEventFourSetFixture` costs
 * 4 x 24 + 3 x 4 = 108px.
 */
describe('FormStrip — width fit via availableWidthPx (plan 39.1-33 R1, event-level since 39.1-42)', () => {
  it('at 240px, three events x four single-game sets (12 games, limit 30) keeps 8 ticks in 2 events, drops the oldest event, keeps the newest set as the LAST form-strip-set, and labels the middle (now-oldest-shown) event first', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
        availableWidthPx={240}
      />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(8);
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls).toHaveLength(2);
    expect(eventEls.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Event B · 2–2',
      'Event C · 2–2',
    ]);
    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]'));
    expect(sets[sets.length - 1]!.getAttribute('aria-label')).toBe('C4 set');
    // REWRITTEN by plan 39.1-42: the caption is gone — the label row of the
    // oldest shown event reads "Event B".
    const firstLabel = container.querySelector('[data-slot="form-strip-event-label"]');
    expect(firstLabel!.firstElementChild!.textContent).toBe('Event B');
    expect(screen.getByText('8 of 12 games shown')).toBeInTheDocument();
  });

  // REWRITTEN by plan 39.1-42 (oldest-dropped): the set-level fit used to
  // squeeze the oldest event's newest set in at 280px (9 ticks, 3 events).
  // Events now drop WHOLE: 108 + 16 + 108 = 232px fit, a third event needs
  // 356px, so 280px still shows 8 ticks in the two newest events.
  it('oldest-dropped: at 280px the same fixture still keeps 8 ticks in the 2 newest events — an older event drops whole, never as a partial group', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
        availableWidthPx={280}
      />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(8);
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Event B · 2–2',
      'Event C · 2–2',
    ]);
  });

  it('oldest-dropped: the root declares data-event-count and data-game-count, and the shown events carry the newest contiguous data-event-order run', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={240}
      />,
    );
    const root = container.querySelector('[data-slot="form-strip-root"]')!;
    expect(root.getAttribute('data-event-count')).toBe('3');
    expect(root.getAttribute('data-game-count')).toBe('12');
    const orders = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]')).map(
      (el) => el.getAttribute('data-event-order'),
    );
    expect(orders).toEqual(['1', '2']);
  });

  it('min-event-width: an event narrower than 80px still costs 80px — three one-tick events keep 2 at 177px (80 + 16 + 80, plus the 1px safety) and only the newest at 176px', () => {
    const events: FormStripEvent[] = ['A', 'B', 'C'].map((label) => ({
      key: `evt-${label}`,
      label: `Event ${label}`,
      sets: [singleGameSet(`${label}1`, true)],
    }));
    const at = (width: number) =>
      render(
        <FormStrip events={events} limit={30} labels={emptyLabels} availableWidthPx={width} />,
      ).container.querySelectorAll('[data-slot="form-strip-event"]').length;
    expect(at(177)).toBe(2);
    expect(at(176)).toBe(1);
  });

  it('newest-kept: the newest event is always kept, whatever the width', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={90}
      />,
    );
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls).toHaveLength(1);
    expect(eventEls[0]!.getAttribute('data-event-order')).toBe('2');
  });

  it('wide-newest-fallback: when the newest event alone is wider than the row, its newest sets that fit are kept and its label states the W–L drawn', () => {
    const { container } = render(
      <FormStrip
        events={oneEventFiveThreeGameSetsFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={100}
      />,
    );
    // 5 x 28 + 4 x 4 = 156px > 99: the newest three sets (28 + 32 + 32 = 92px) stay.
    expect(container.querySelectorAll('[data-slot="form-strip-set"]')).toHaveLength(3);
    const record = container.querySelector(
      '[data-slot="form-strip-event-label"]',
    )!.lastElementChild!;
    expect(record.textContent).toBe('6–3');
  });

  it('session-set-width: a session-set of N games is N ticks + (N - 1) 2px gaps (no 24px per game) — a 6-game set costs 58px, so its event (80px) fits beside an older one at 177px', () => {
    const sixGameSession: FormStripSet = {
      key: 'manual-session:s1',
      label: 'session set',
      inRecentWindow: true,
      games: Array.from({ length: 6 }, (_, i) => game(`s${i}`, i % 2 === 0)),
    };
    const events: FormStripEvent[] = [
      { key: 'evt-old', label: 'Old Event', sets: [singleGameSet('o1', true)] },
      { key: 'sessions:s1', label: 'Sessions · Jul 3 – 9', sets: [sixGameSession] },
    ];
    const { container } = render(
      <FormStrip events={events} limit={30} labels={emptyLabels} availableWidthPx={177} />,
    );
    // 6 x 24 + 5 x 2 = 154px per-game minimums would leave room for the newest only.
    expect(container.querySelectorAll('[data-slot="form-strip-event"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(7);
  });

  it('at 10px, the newest set is always kept — exactly 1 tick', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={10}
      />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(1);
  });

  it('a three-game set costs 28px (not the 24px single-game minimum): one event of five three-game sets (15 games) at 100px keeps 3 sets / 9 ticks', () => {
    const { container } = render(
      <FormStrip
        events={oneEventFiveThreeGameSetsFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={100}
      />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-set"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(9);
  });
});

/**
 * WR-01 (39.1-REVIEW.md): start.gg writes the same event name ("Ultimate
 * Singles") at every tournament, and the hosts group by name and order
 * groups by their FIRST game — so this year's sets sit inside a group
 * placed at a 2022 game, behind a 2025 manual session. Each set carries its
 * newest game's instant (`lastGameMs`); the kit must order by it.
 */
function recurringEventNameFixture(): FormStripEvent[] {
  const at = (iso: string) => Date.parse(iso);
  const set = (key: string, iso: string): FormStripSet => ({
    ...singleGameSet(key, true),
    lastGameMs: at(iso),
  });
  return [
    {
      key: 'Ultimate Singles',
      label: 'Ultimate Singles',
      sets: [
        set('singles-2022', '2022-03-05T18:00:00Z'),
        set('singles-2026a', '2026-02-07T18:00:00Z'),
        set('singles-2026b', '2026-02-07T19:00:00Z'),
      ],
    },
    {
      key: 'session:m2025',
      label: 'Session · Jun 1, 2025',
      sets: [set('manual-2025', '2025-06-01T18:00:00Z')],
    },
  ];
}

describe('FormStrip — chronological set order across events (WR-01)', () => {
  it('keeps the two newest sets (both from the recurring event name), not the older manual session, when only two fit', () => {
    const { container } = render(
      <FormStrip
        events={recurringEventNameFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={60}
      />,
    );
    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(sets).toEqual(['singles-2026a set', 'singles-2026b set']);
    // REWRITTEN by plan 39.1-42: the caption is gone — the one shown event's
    // label row names it.
    const labels = container.querySelectorAll('[data-slot="form-strip-event-label"]');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.firstElementChild!.textContent).toBe('Ultimate Singles');
  });

  it('with every set drawn, renders the reused name as two groups around the session, oldest first', () => {
    const { container } = render(
      <FormStrip events={recurringEventNameFixture()} limit={30} labels={emptyLabels} />,
    );
    const groups = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(groups.map((g) => g.querySelectorAll('[data-slot="form-strip-set"]').length)).toEqual([
      1, 1, 2,
    ]);
    // REWRITTEN by plan 39.1-42: every shown event is labelled (was a first /
    // last caption pair).
    expect(
      Array.from(container.querySelectorAll('[data-slot="form-strip-event-label"]')).map(
        (row) => row.firstElementChild!.textContent,
      ),
    ).toEqual(['Ultimate Singles', 'Session · Jun 1, 2025', 'Ultimate Singles']);
    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]'));
    expect(sets[1]!.getAttribute('aria-label')).toBe('manual-2025 set');
  });

  it('the limit trim drops the OLDEST set by time, not the first array entry', () => {
    const events = recurringEventNameFixture();
    // Four games in, limit 20 would keep all — use the kit's smallest limit
    // with a padded older event so exactly the oldest game falls out.
    const padding: FormStripEvent = {
      key: 'Old Weekly',
      label: 'Old Weekly',
      sets: Array.from({ length: 17 }, (_, i) => ({
        ...singleGameSet(`weekly-${i}`, true),
        lastGameMs: Date.parse('2024-01-01T00:00:00Z') + i * 60_000,
      })),
    };
    const { container } = render(
      <FormStrip events={[...events, padding]} limit={20} labels={emptyLabels} />,
    );
    const labels = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]')).map(
      (el) => el.getAttribute('aria-label'),
    );
    expect(labels).toHaveLength(20);
    expect(labels).not.toContain('singles-2022 set');
    expect(labels[labels.length - 1]).toBe('singles-2026b set');
  });
});

describe('FormStrip — accessible names state what is drawn (WR-03)', () => {
  it('the row group name is the host formatter of the DRAWN vs total games (60 of 90 at limit 60)', () => {
    render(<FormStrip events={ninetyGameFixture()} limit={60} labels={emptyLabels} />);
    expect(screen.getByRole('group', { name: 'summary 60 of 90' })).toBeInTheDocument();
  });

  it('after the width fit the row group name counts only the fitted games (8 of 12 at 240px)', () => {
    render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={240}
      />,
    );
    expect(screen.getByRole('group', { name: 'summary 8 of 12' })).toBeInTheDocument();
  });

  // REWRITTEN by plan 39.1-42: older events now drop whole, so the only
  // partially drawn event is the wide newest one (the set-fit fallback).
  it("a partially shown event's group name and title state the record of ONLY its drawn sets", () => {
    const { container } = render(
      <FormStrip
        events={oneEventFiveThreeGameSetsFixture()}
        limit={30}
        labels={emptyLabels}
        availableWidthPx={100}
      />,
    );
    const only = container.querySelector('[data-slot="form-strip-event"]')!;
    // Three of five 2–1 sets drawn: 6–3, never the whole event's 10–5.
    expect(only.getAttribute('aria-label')).toBe('Solo Long Event · 6–3');
    expect(only.getAttribute('title')).toBe('Solo Long Event · 6–3');
  });

  it('a limit trim that cuts into a set counts only the drawn games of that set', () => {
    render(<FormStrip events={ninetyGameFixture()} limit={60} labels={emptyLabels} />);
    const group = screen.getByRole('group', { name: /^Long Event · / });
    const drawnWins = group.querySelectorAll('[data-slot="form-strip-tick-win"]').length;
    const drawnLosses = group.querySelectorAll('[data-slot="form-strip-tick-loss"]').length;
    expect(drawnWins + drawnLosses).toBe(60);
    expect(group.getAttribute('aria-label')).toBe(`Long Event · ${drawnWins}–${drawnLosses}`);
  });
});

describe('FormStrip — hooks stay above the 0-games early return (guard)', () => {
  it('rerendering from 0 games to the two-event fixture and back to 0 renders empty -> 4 ticks -> empty, with no hook-order error', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, rerender } = render(
      <FormStrip events={[]} limit={60} labels={emptyLabels} />,
    );
    expect(container.querySelector('[data-slot="form-strip-empty"]')).not.toBeNull();

    rerender(<FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(4);

    rerender(<FormStrip events={[]} limit={60} labels={emptyLabels} />);
    expect(container.querySelector('[data-slot="form-strip-empty"]')).not.toBeNull();

    const hookOrderErrors = consoleErrorSpy.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && /order of Hooks/.test(arg)),
    );
    expect(hookOrderErrors).toHaveLength(0);
    consoleErrorSpy.mockRestore();
  });
});

describe('FormStrip — legend, narrow tick geometry, and centred single-game sets (plan 39.1-32, item 11)', () => {
  // REWRITTEN by plan 39.1-42 (sketch 003 `stripLegend`): the legend is the
  // structured four-item swatch legend in the head, not a ' · '-split string.
  it('head-legend: with a title the head renders the overline then four whole-token legend items (win / loss with a swatch tick) on one wrapping line (never justify-between)', () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture()}
        limit={60}
        labels={{ ...emptyLabels, title: 'Form · last 4 games, by event' }}
      />,
    );
    const root = container.querySelector('[data-slot="form-strip-root"]')!;
    const head = container.querySelector('[data-slot="form-strip-head"]') as HTMLElement;
    expect(head).not.toBeNull();
    expect(root.firstElementChild).toBe(head);
    expect(head.querySelector('[data-slot="form-strip-overline"]')?.textContent).toBe(
      'Form · last 4 games, by event',
    );
    const items = Array.from(head.querySelectorAll('[data-slot="form-strip-legend-item"]'));
    expect(items.map((el) => el.textContent)).toEqual([
      'up = win',
      'down = loss',
      'gap = new set',
      'label = event · W–L',
    ]);
    for (const item of items) {
      expect((item as HTMLElement).className).toMatch(/whitespace-nowrap/);
    }
    const swatches = items.map(
      (item) => item.querySelectorAll('[data-slot="form-strip-legend-swatch"]').length,
    );
    expect(swatches).toEqual([1, 1, 0, 0]);
    const win = items[0]!.querySelector('[data-slot="form-strip-legend-swatch"]') as HTMLElement;
    const loss = items[1]!.querySelector('[data-slot="form-strip-legend-swatch"]') as HTMLElement;
    expect(win.style.alignItems).toBe('flex-start');
    expect(loss.style.alignItems).toBe('flex-end');
    // Fidelity M1 (after-39.1-42 captures): a baseline-aligned row set the
    // swatch items' text lower / higher than the text-only items — the row
    // centres its items like sketch 003's `.legend{align-items:center}`.
    const legendRow = items[0]!.parentElement as HTMLElement;
    for (const cls of ['flex', 'flex-wrap', 'items-center', 'gap-x-3.5', 'gap-y-0.5']) {
      expect(legendRow.className.split(/\s+/)).toContain(cls);
    }
    expect(legendRow.className).not.toMatch(/items-baseline|justify-between/);
    for (const item of items) {
      expect((item as HTMLElement).className.split(/\s+/)).toContain('items-center');
    }
  });

  // REWRITTEN by plan 39.1-42: the shown-of-total token lives on the foot
  // line and is now a sentence ("N of M games shown · older events drop
  // first · oldest → newest") — it wraps like sketch 003's `.strip-foot`
  // items (never whitespace-nowrap, which widened 390px pages; guard:layout
  // horizontal-overflow on fighter-analysis / matchups / trends at 390).
  it('foot-line: shownOfTotal renders as its own wrapping token on the foot line (never whitespace-nowrap)', () => {
    const { container } = render(
      <FormStrip events={ninetyGameFixture()} limit={60} labels={emptyLabels} />,
    );
    const token = container.querySelector('[data-slot="form-strip-shown-of-total"]');
    expect(token).not.toBeNull();
    expect((token as HTMLElement).className).not.toMatch(/whitespace-nowrap/);
    expect((token as HTMLElement).className).toMatch(/\bmin-w-0\b/);
    expect(token!.textContent).toBe('60 of 90 games shown');
    const foot = token!.closest('[data-slot="form-strip-foot"]') as HTMLElement;
    expect(foot).not.toBeNull();
    expect(foot.className).toMatch(/\bflex-wrap\b/);
    expect(foot.className).toMatch(/\bmin-w-0\b/);
  });

  // REWRITTEN by plan 39.1-42: no title -> no head, so no legend at all (the
  // opponent hub passes none); was one unsplit legend item.
  it('head-legend: without a title no head and no legend item render', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    expect(container.querySelector('[data-slot="form-strip-head"]')).toBeNull();
    expect(container.querySelector('[data-slot="form-strip-legend-item"]')).toBeNull();
  });

  // REWRITTEN by plan 39.1-42: `analytics.strip.legend` (one ' · '-joined
  // string) is replaced by the four `analytics.strip.legendItem.*` keys.
  it.each(['en', 'es', 'fr', 'de', 'pt', 'ja'] as const)(
    "each locale's analytics.strip.legendItem keys render exactly four legend items (%s)",
    (locale) => {
      const json = JSON.parse(
        fs.readFileSync(resolve(process.cwd(), `src/i18n/locales/${locale}.json`), 'utf8'),
      ) as {
        analytics: {
          strip: { legendItem: { win: string; loss: string; setGap: string; eventLabel: string } };
        };
      };
      const { container } = render(
        <FormStrip
          events={twoEventFixture()}
          limit={60}
          labels={{ ...emptyLabels, title: 'Form', legend: json.analytics.strip.legendItem }}
        />,
      );
      const items = Array.from(container.querySelectorAll('[data-slot="form-strip-legend-item"]'));
      expect(items).toHaveLength(4);
      for (const item of items) {
        expect((item.textContent ?? '').trim().length).toBeGreaterThan(0);
      }
    },
  );

  // REWRITTEN by plan 39.1-42 (PD-42-5, sketch 002-C `.strip-set i`): phone
  // ticks are 5px wide (was max-sm:w-1.5, 6px).
  it('every tick carries the narrow-geometry classes (5x28px below 640px) and no inline width/height', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const tick = container.querySelector('[data-slot="form-strip-tick"]') as HTMLElement;
    for (const cls of ['w-2', 'h-8', 'max-sm:w-[5px]', 'max-sm:h-7']) {
      expect(tick.className).toContain(cls);
    }
    expect(tick.style.width).toBe('');
    expect(tick.style.height).toBe('');
    const bar = tick.firstElementChild as HTMLElement;
    for (const cls of ['h-3.5', 'max-sm:h-3']) {
      expect(bar.className).toContain(cls);
    }
    expect(bar.style.width).toBe('');
    expect(bar.style.height).toBe('');
  });

  it('the existing alignItems/opacity inline-style cases stay inline (unaffected by the class move)', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const winTick = container.querySelector('[data-slot="form-strip-tick"][title^="win"]');
    expect((winTick as HTMLElement).style.alignItems).toBe('flex-start');
  });

  it("a single-game set's form-strip-set carries justify-center, and its rule sits inside a form-strip-tick-run alongside its one tick", () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Solo Event',
        sets: [
          { key: 'set-1', label: 'solo set', inRecentWindow: true, games: [game('g1', true)] },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    const set = container.querySelector('[data-slot="form-strip-set"]') as HTMLElement;
    expect(set.className).toMatch(/justify-center/);
    const tickRun = set.querySelector('[data-slot="form-strip-tick-run"]') as HTMLElement;
    expect(tickRun).not.toBeNull();
    expect(tickRun.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(1);
  });

  it("a three-game set's tick-run holds its rule and all three ticks", () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Trio Event',
        sets: [
          {
            key: 'set-1',
            label: 'trio set',
            inRecentWindow: true,
            games: [game('g1', true), game('g2', false), game('g3', true)],
          },
        ],
      },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    const tickRun = container.querySelector('[data-slot="form-strip-tick-run"]') as HTMLElement;
    expect(tickRun.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(3);
  });
});

describe('FormStrip source-tree guards (UIX-05, VIZ-02)', () => {
  const source = fs.readFileSync(
    resolve(process.cwd(), 'src/components/charts/FormStrip.tsx'),
    'utf8',
  );
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('imports only from ./tokens within the kit, and never the charting library', () => {
    expect(source).not.toMatch(/from\s+['"]recharts['"]/);
    const kitImports = [...source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1]);
    expect(kitImports).toEqual(['./tokens']);
  });

  it('contains no hex colour literal and no useTranslation call', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(source).not.toMatch(/useTranslation/);
  });

  it('references CHART_TOKENS.win and CHART_TOKENS.loss (positive consumption scan)', () => {
    expect(codeOnly).toMatch(/CHART_TOKENS\.win/);
    expect(codeOnly).toMatch(/CHART_TOKENS\.loss/);
  });

  it('declares no colour/fill/tint member on its exported prop types', () => {
    const propBlocks = source.match(/export interface FormStrip\w*Props[\s\S]*?\n}/g) ?? [];
    for (const block of propBlocks) {
      expect(block).not.toMatch(/\b(colou?r|fill|tint)\??:/i);
    }
  });
});

/**
 * Plan 39.1-35 (sketch 002-C thin account, planner decision 7): an optional
 * overline formatter of the DRAWN vs total counts, rendered above the row
 * only when it returns text — the career timeline's "All N games · by
 * session" line names every game only when every game is actually drawn
 * (the `limit` trim or the width fit may draw fewer).
 */
// REWRITTEN by plan 39.1-42: plan 35's `overline` formatter is the kit's
// `title` (which may be a formatter of the DRAWN vs total counts); the title
// renders the head (overline + legend) — only when it returns text.
describe('FormStrip title as a formatter (plan 39.1-35 overline, the kit head since 39.1-42)', () => {
  const title = ({ shown, total }: { shown: number; total: number }) =>
    shown === total ? `All ${total} games` : undefined;

  it('renders the head with the overline above the row when every game is drawn', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={{ ...emptyLabels, title }}
      />,
    );
    const el = container.querySelector('[data-slot="form-strip-overline"]');
    expect(el?.textContent).toBe('All 12 games');
    const root = container.querySelector('[data-slot="form-strip-root"]')!;
    expect(root.firstElementChild).toBe(container.querySelector('[data-slot="form-strip-head"]'));
  });

  it('renders no head when the limit trims games (90 games at limit 60)', () => {
    const { container } = render(
      <FormStrip events={ninetyGameFixture()} limit={60} labels={{ ...emptyLabels, title }} />,
    );
    expect(container.querySelector('[data-slot="form-strip-head"]')).toBeNull();
  });

  it('renders no head when the width fit draws fewer than every game', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        availableWidthPx={100}
        labels={{ ...emptyLabels, title }}
      />,
    );
    expect(container.querySelector('[data-slot="form-strip-head"]')).toBeNull();
  });
});

/**
 * Plan 39.1-42 (sketch 003 `.strip-foot`, `fitStrips`' note): the foot line
 * states what the strip drew — the shown-of-total formatter when games were
 * dropped, the all-shown formatter otherwise — and the window note on the
 * same line.
 */
describe('FormStrip foot (plan 39.1-42)', () => {
  it('foot-line: every game drawn -> the all-shown formatter and the window note on one foot line; no shown-of-total token', () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture()}
        limit={60}
        labels={{ ...emptyLabels, windowNote: 'Last 30 games highlighted' }}
      />,
    );
    const foot = container.querySelector('[data-slot="form-strip-foot"]')!;
    expect(foot).not.toBeNull();
    expect(Array.from(foot.children).map((child) => child.textContent)).toEqual([
      'all 4 games · oldest → newest',
      'Last 30 games highlighted',
    ]);
    expect(container.querySelector('[data-slot="form-strip-shown-of-total"]')).toBeNull();
    const root = container.querySelector('[data-slot="form-strip-root"]')!;
    expect(root.lastElementChild).toBe(foot);
  });

  it('foot-line: games dropped by the fit -> the shown-of-total formatter of the DRAWN games on the foot line', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        availableWidthPx={240}
        labels={{ ...emptyLabels, windowNote: 'Whole record shown' }}
      />,
    );
    const foot = container.querySelector('[data-slot="form-strip-foot"]')!;
    expect(Array.from(foot.children).map((child) => child.textContent)).toEqual([
      '8 of 12 games shown',
      'Whole record shown',
    ]);
  });

  // Plan 41-10 (DD-41-04): the optional `drawn` support line is a formatter of
  // the games the kit actually DRAWS — only the kit knows them after the limit
  // trim and the width fit.
  it('drawn: the support line formats the W-L and set count of the DRAWN games only', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        availableWidthPx={240}
        labels={{
          ...emptyLabels,
          drawn: ({ wins, losses, sets }) => `${wins}-${losses} in ${sets} sets`,
        }}
      />,
    );
    const drawnGames = container.querySelectorAll('[data-slot="form-strip-tick"]').length;
    const wins = container.querySelectorAll('[data-slot="form-strip-tick-win"]').length;
    const support = container.querySelector('[data-slot="form-strip-support"]')!;
    expect(drawnGames).toBeLessThan(12);
    expect(support.textContent).toBe(`${wins}-${drawnGames - wins} in ${drawnGames} sets`);
  });

  it('drawn: absent, the foot renders no support line', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={30} labels={emptyLabels} />,
    );
    expect(container.querySelector('[data-slot="form-strip-support"]')).toBeNull();
  });
});
