import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScoutRecentEvent } from '@smash-tracker/shared';
import { ScoutRecentEventsCard } from './ScoutRecentEventsCard';

describe('ScoutRecentEventsCard', () => {
  it('renders a start.gg event with a slug as an external link to start.gg', () => {
    const events: ScoutRecentEvent[] = [
      {
        eventName: 'Ultimate Singles',
        lastSetAt: 1_700_000_000_000,
        slug: 'tournament/the-big-house-9/event/ultimate-singles',
        source: 'startgg',
      },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    const link = screen.getByRole('link', { name: /Ultimate Singles/ });
    expect(link).toHaveAttribute(
      'href',
      'https://www.start.gg/tournament/the-big-house-9/event/ultimate-singles',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a pre-V9-B event with no slug as plain text (back-compat)', () => {
    const events: ScoutRecentEvent[] = [
      { eventName: 'Ultimate Singles', lastSetAt: 1_700_000_000_000 },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a parry.gg event as plain text even when a slug is present (no verified event URL shape)', () => {
    const events: ScoutRecentEvent[] = [
      {
        eventName: 'Ultimate Singles',
        lastSetAt: 1_700_000_000_000,
        slug: 'my-tournament-01931d1c/test',
        source: 'parrygg',
      },
    ];
    render(<ScoutRecentEventsCard events={events} />);

    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no events', () => {
    render(<ScoutRecentEventsCard events={[]} />);
    expect(screen.getByText('No recent events sampled.')).toBeInTheDocument();
  });
});

/**
 * Plan 39.1-49 (UI-SPEC §6.6): at 390px on Scout the recent-events table hid
 * its Placement / Entrants / Date columns behind a sideways scroll. Below
 * 640px each event is a stacked two-line row with the same external link.
 */
const eventsText = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('ScoutRecentEventsCard — stacked rows below 640px (plan 39.1-49)', () => {
  const events: ScoutRecentEvent[] = [
    {
      eventName: 'Guard Harness Weekly Ultimate Singles #42',
      tournamentName: 'Guard Harness Community Weekly Series 42',
      placement: 1,
      numEntrants: 128,
      lastSetAt: 1_700_200_000_000,
      slug: 'tournament/guard-harness-42/event/ultimate-singles',
      source: 'startgg',
    },
    {
      eventName: 'Loopback Legends Monthly Ultimate Singles #7',
      placement: 13,
      numEntrants: 64,
      lastSetAt: 1_700_100_000_000,
    },
    {
      eventName: 'Parry Open',
      lastSetAt: 1_700_000_000_000,
      slug: 'parry-open/singles',
      source: 'parrygg',
    },
  ];

  it('stack versus table parity: same rows, the same external link per row (href, target, rel), every table value in its stacked row, same root data-slot', () => {
    const table = render(<ScoutRecentEventsCard events={events} layout="table" />);
    const tableEl = table.container.querySelector('table[data-slot="scout-recent-events"]');
    expect(tableEl).not.toBeNull();
    const tableRows = Array.from(tableEl!.querySelectorAll('tbody tr')).map((tr) => ({
      links: Array.from(tr.querySelectorAll('a')).map((a) => [
        a.getAttribute('href'),
        a.getAttribute('target'),
        a.getAttribute('rel'),
      ]),
      cells: Array.from(tr.querySelectorAll('td'))
        .map((td) => eventsText(td))
        .filter(Boolean),
    }));
    table.unmount();

    const stack = render(<ScoutRecentEventsCard events={events} layout="stack" />);
    expect(stack.container.querySelector('table')).toBeNull();
    const items = Array.from(
      stack.container.querySelectorAll('ul[data-slot="scout-recent-events"] > li'),
    );
    expect(items).toHaveLength(tableRows.length);
    items.forEach((li, index) => {
      expect(
        Array.from(li.querySelectorAll('a')).map((a) => [
          a.getAttribute('href'),
          a.getAttribute('target'),
          a.getAttribute('rel'),
        ]),
      ).toEqual(tableRows[index]!.links);
      for (const cell of tableRows[index]!.cells) {
        expect(eventsText(li)).toContain(cell);
      }
    });
  });
});

/**
 * Plan 39.1-49 (orchestrator 2026-09-26; UI-SPEC §4.3 "brand red is never
 * text"): the event link takes the kit's inline link tone (39.1-39's
 * `INLINE_LINK_TONE`) in both layouts — never `text-primary`.
 */
describe('ScoutRecentEventsCard — event link tone (plan 39.1-49)', () => {
  const linked: ScoutRecentEvent[] = [
    {
      eventName: 'Ultimate Singles',
      lastSetAt: 1_700_000_000_000,
      slug: 'tournament/the-big-house-9/event/ultimate-singles',
      source: 'startgg',
    },
  ];

  it('link tone: the event link carries INLINE_LINK_TONE and no text-primary, in the table and the stack', () => {
    for (const layout of ['table', 'stack'] as const) {
      const view = render(<ScoutRecentEventsCard events={linked} layout={layout} />);
      const classes = screen.getByRole('link').className.split(/\s+/);
      expect(classes).not.toContain('text-primary');
      expect(classes).toEqual(
        expect.arrayContaining(['text-foreground', 'underline-offset-4', 'hover:underline']),
      );
      view.unmount();
    }
  });
});
