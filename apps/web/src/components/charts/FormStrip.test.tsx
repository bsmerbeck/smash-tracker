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
      record: '2-1',
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
      record: '1-0',
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
  return [{ key: 'evt-1', label: 'Long Event', record: '45-45', sets }];
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
    record: '2-2',
    sets: Array.from({ length: 4 }, (_, i) => singleGameSet(`${label}${i + 1}`, i % 2 === 0)),
  }));
}

/** Plan 39.1-33: one event, five three-game sets (15 games) — a three-game set is `max(24, 3*8 + 2*2) = 28px` wide, not the 24px single-game minimum. */
function oneEventFiveThreeGameSetsFixture(): FormStripEvent[] {
  return [
    {
      key: 'evt-solo',
      label: 'Solo Long Event',
      record: '8-7',
      sets: Array.from({ length: 5 }, (_, i) => ({
        key: `solo-set-${i + 1}`,
        label: `solo set ${i + 1}`,
        inRecentWindow: true,
        games: [game(`g${i + 1}a`, true), game(`g${i + 1}b`, false), game(`g${i + 1}c`, true)],
      })),
    },
  ];
}

const emptyLabels = {
  summary: 'summary',
  legend: 'legend',
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

  it('renders the empty node, zero ticks, no legend and no group role at 0 games', () => {
    const { container } = render(<FormStrip events={[]} limit={60} labels={emptyLabels} />);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(0);
    expect(screen.queryByText('legend')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByText('No games in this view yet.')).toBeInTheDocument();
  });

  it('renders exactly 1 real tick at 1 game, no padding', () => {
    const events: FormStripEvent[] = [
      {
        key: 'evt-1',
        label: 'Solo Event',
        record: '1-0',
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
        record: '1-1',
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

  it('dims every tick and highlights nothing when games exist but none are in the recent window', () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture(false)}
        limit={60}
        labels={{ ...emptyLabels, windowEmpty: 'No games in the last 90 days — all games shown.' }}
      />,
    );
    const ticks = Array.from(container.querySelectorAll('[data-slot="form-strip-tick"]'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect((tick as HTMLElement).style.opacity).toBe('0.32');
    }
    expect(screen.getByText('No games in the last 90 days — all games shown.')).toBeInTheDocument();
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
    const row = screen.getByRole('group', { name: 'summary' });
    expect(row.className).toMatch(/\bflex-nowrap\b/);
    expect(row.className).toMatch(/\boverflow-hidden\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    expect(row.className).not.toMatch(/\bflex-wrap\b/);
    expect(row.className).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
  });

  it('no form-strip-event carries an inline min-width, and every element child of a form-strip-event is a form-strip-set', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls.length).toBeGreaterThan(0);
    for (const eventEl of eventEls) {
      expect((eventEl as HTMLElement).style.minWidth).toBe('');
      for (const child of Array.from(eventEl.children)) {
        expect((child as HTMLElement).dataset.slot).toBe('form-strip-set');
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
      'Genesis 10 · 2-1',
      'Weekly #12 · 1-0',
    ]);
    expect(eventEls.map((el) => el.getAttribute('title'))).toEqual([
      'Genesis 10 · 2-1',
      'Weekly #12 · 1-0',
    ]);
  });

  it('renders form-strip-caption-first (oldest shown) and form-strip-caption-last (newest shown), both truncate + data-truncate-guard, for a two-event fixture', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const first = container.querySelector('[data-slot="form-strip-caption-first"]');
    const last = container.querySelector('[data-slot="form-strip-caption-last"]');
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    expect(first!.textContent).toBe('Genesis 10');
    expect(first).toHaveAttribute('title', 'Genesis 10');
    expect(last!.textContent).toBe('Weekly #12');
    expect(last).toHaveAttribute('title', 'Weekly #12');
    for (const span of [first, last]) {
      expect((span as HTMLElement).className).toMatch(/\btruncate\b/);
      expect((span as HTMLElement).hasAttribute('data-truncate-guard')).toBe(true);
    }
    // The caption is the ONLY place "Genesis 10" renders as visible text —
    // the per-group label/record line this plan removes used to also print
    // it under the group itself.
    expect(screen.getAllByText('Genesis 10')).toHaveLength(1);
  });

  it('a one-event fixture renders caption-first only — no form-strip-caption-last', () => {
    const events: FormStripEvent[] = [
      { key: 'evt-1', label: 'Solo Event', record: '1-0', sets: [singleGameSet('g1', true)] },
    ];
    const { container } = render(<FormStrip events={events} limit={30} labels={emptyLabels} />);
    expect(container.querySelector('[data-slot="form-strip-caption-first"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="form-strip-caption-last"]')).toBeNull();
  });
});

describe('FormStrip — width fit via availableWidthPx (plan 39.1-33, R1)', () => {
  it('at 240px, three events x four single-game sets (12 games, limit 30) keeps 8 ticks in 2 events, drops the oldest event, keeps the newest set as the LAST form-strip-set, and captions the middle (now-oldest-shown) event first', () => {
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
      'Event B · 2-2',
      'Event C · 2-2',
    ]);
    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]'));
    expect(sets[sets.length - 1]!.getAttribute('aria-label')).toBe('C4 set');
    const captionFirst = container.querySelector('[data-slot="form-strip-caption-first"]');
    expect(captionFirst!.textContent).toBe('Event B');
    expect(screen.getByText('8 of 12 games shown')).toBeInTheDocument();
  });

  it('at 280px, the same fixture keeps 9 ticks in 3 events — the oldest event keeps only its newest set — and captions the oldest shown event first', () => {
    const { container } = render(
      <FormStrip
        events={threeEventFourSetFixture()}
        limit={30}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
        availableWidthPx={280}
      />,
    );
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]')).toHaveLength(9);
    const eventEls = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(eventEls).toHaveLength(3);
    const oldestEventSets = eventEls[0]!.querySelectorAll('[data-slot="form-strip-set"]');
    expect(oldestEventSets).toHaveLength(1);
    expect(oldestEventSets[0]!.getAttribute('aria-label')).toBe('A4 set');
    const captionFirst = container.querySelector('[data-slot="form-strip-caption-first"]');
    expect(captionFirst!.textContent).toBe('Event A');
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
      record: '3-0',
      sets: [
        set('singles-2022', '2022-03-05T18:00:00Z'),
        set('singles-2026a', '2026-02-07T18:00:00Z'),
        set('singles-2026b', '2026-02-07T19:00:00Z'),
      ],
    },
    {
      key: 'session:m2025',
      label: 'Session · Jun 1, 2025',
      record: '1-0',
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
    expect(container.querySelector('[data-slot="form-strip-caption-first"]')).toHaveTextContent(
      'Ultimate Singles',
    );
  });

  it('with every set drawn, renders the reused name as two groups around the session, oldest first', () => {
    const { container } = render(
      <FormStrip events={recurringEventNameFixture()} limit={30} labels={emptyLabels} />,
    );
    const groups = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(groups.map((g) => g.querySelectorAll('[data-slot="form-strip-set"]').length)).toEqual([
      1, 1, 2,
    ]);
    expect(container.querySelector('[data-slot="form-strip-caption-first"]')).toHaveTextContent(
      'Ultimate Singles',
    );
    expect(container.querySelector('[data-slot="form-strip-caption-last"]')).toHaveTextContent(
      'Ultimate Singles',
    );
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
      record: '17-0',
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
  it("legend 'a · b · c' renders three whole-token legend items in a flex-wrap row (never justify-between)", () => {
    const { container } = render(
      <FormStrip
        events={twoEventFixture()}
        limit={60}
        labels={{ ...emptyLabels, legend: 'a · b · c' }}
      />,
    );
    const items = container.querySelectorAll('[data-slot="form-strip-legend-item"]');
    expect(items).toHaveLength(3);
    for (const item of Array.from(items)) {
      expect((item as HTMLElement).className).toMatch(/whitespace-nowrap/);
    }
    expect(['a', 'b', 'c']).toEqual(Array.from(items).map((el) => el.textContent));
    const legendRow = items[0]!.parentElement as HTMLElement;
    expect(legendRow.className).toMatch(/\bflex-wrap\b/);
    expect(legendRow.className).not.toMatch(/justify-between/);
  });

  it('shownOfTotal renders as its own whitespace-nowrap token', () => {
    const { container } = render(
      <FormStrip
        events={ninetyGameFixture()}
        limit={60}
        labels={{ ...emptyLabels, shownOfTotal: shownOfTotalFormatter }}
      />,
    );
    const token = container.querySelector('[data-slot="form-strip-shown-of-total"]');
    expect(token).not.toBeNull();
    expect((token as HTMLElement).className).toMatch(/whitespace-nowrap/);
    expect(token!.textContent).toBe('60 of 90 games shown');
  });

  it("a legend with no separator ('legend') renders one legend item WITHOUT whitespace-nowrap", () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const items = container.querySelectorAll('[data-slot="form-strip-legend-item"]');
    expect(items).toHaveLength(1);
    expect((items[0] as HTMLElement).className).not.toMatch(/whitespace-nowrap/);
    expect(items[0]!.textContent).toBe('legend');
  });

  it.each(['en', 'es', 'fr', 'de', 'pt', 'ja'] as const)(
    "each locale's analytics.strip.legend renders exactly four legend items (%s)",
    (locale) => {
      const json = JSON.parse(
        fs.readFileSync(resolve(process.cwd(), `src/i18n/locales/${locale}.json`), 'utf8'),
      ) as { analytics: { strip: { legend: string } } };
      const { container } = render(
        <FormStrip
          events={twoEventFixture()}
          limit={60}
          labels={{ ...emptyLabels, legend: json.analytics.strip.legend }}
        />,
      );
      expect(container.querySelectorAll('[data-slot="form-strip-legend-item"]')).toHaveLength(4);
    },
  );

  it('every tick carries the narrow-geometry classes and no inline width/height', () => {
    const { container } = render(
      <FormStrip events={twoEventFixture()} limit={60} labels={emptyLabels} />,
    );
    const tick = container.querySelector('[data-slot="form-strip-tick"]') as HTMLElement;
    for (const cls of ['w-2', 'h-8', 'max-sm:w-1.5', 'max-sm:h-7']) {
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
        record: '1-0',
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
        record: '2-1',
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
