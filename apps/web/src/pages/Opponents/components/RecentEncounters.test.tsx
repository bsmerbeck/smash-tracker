import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { RecentEncounters } from './RecentEncounters';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function twoEventFixture(): Match[] {
  return [
    makeMatch({
      id: 'a1',
      time: 1000,
      win: true,
      externalId: 'sgg:100:g1',
      eventName: 'Genesis 9',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 1, name: 'Battlefield' },
    }),
    makeMatch({
      id: 'a2',
      time: 1100,
      win: true,
      externalId: 'sgg:100:g2',
      eventName: 'Genesis 9',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 1, name: 'Battlefield' },
    }),
    makeMatch({
      id: 'a3',
      time: 1200,
      win: false,
      externalId: 'sgg:100:g3',
      eventName: 'Genesis 9',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 3, name: 'Final Destination' },
    }),
    makeMatch({
      id: 'b1',
      time: 2000,
      win: false,
      externalId: 'sgg:200:g1',
      eventName: 'The Big House 9',
      fighter_id: 1,
      opponent_id: 10,
      map: { id: 1, name: 'Battlefield' },
    }),
  ];
}

function renderEncounters(
  matches: Match[],
  props: {
    tournamentLinkForMatch?: (m: Match) => { href: string; label: string } | undefined;
    onSeeAllInMatchList?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <RecentEncounters matches={matches} {...props} />
    </MemoryRouter>,
  );
}

describe('RecentEncounters (39.1-18 Task 2, UIX-08/D-10)', () => {
  it('renders no rows when the fixture is empty', () => {
    renderEncounters([]);
    expect(screen.getByText('No encounters recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders two event headers, each with a title and a link to the tournament detail route', () => {
    const matches = twoEventFixture();
    renderEncounters(matches, {
      tournamentLinkForMatch: (m) => ({
        href: `/tournaments/${m.eventName}`,
        label: m.eventName ?? '',
      }),
    });

    const headers = document.querySelectorAll('[data-slot="encounter-event-header"]');
    expect(headers.length).toBe(2);
    // Newest event (The Big House 9, time 2000) renders first.
    expect(headers[0]!.textContent).toContain('The Big House 9');
    expect(headers[1]!.textContent).toContain('Genesis 9');
    const genesisHeader = headers[1]! as HTMLElement;
    expect(genesisHeader.tagName).toBe('A');
    expect(genesisHeader.getAttribute('href')).toBe('/tournaments/Genesis 9');
    const nameSlot = within(genesisHeader).getByTitle('Genesis 9');
    expect(nameSlot).toHaveAttribute('data-truncate-guard');
  });

  it('renders no tier badge, label or colour class on any header', () => {
    renderEncounters(twoEventFixture(), {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });
    const headers = document.querySelectorAll('[data-slot="encounter-event-header"]');
    for (const header of headers) {
      expect(header.textContent ?? '').not.toMatch(/tier/i);
      expect(header.className).not.toMatch(/tier/i);
    }
  });

  it('a set row is a button with an expanded state; activating a second row collapses the first', async () => {
    const user = userEvent.setup();
    renderEncounters(twoEventFixture(), {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });

    const rows = document.querySelectorAll('[data-slot="encounter-set-row"] button');
    expect(rows.length).toBe(2);
    const [first, second] = [...rows] as HTMLElement[];
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'false');

    await user.click(first!);
    expect(first).toHaveAttribute('aria-expanded', 'true');

    await user.click(second!);
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveAttribute('aria-expanded', 'false');
  });

  it('win and loss set rows differ by result word AND a status element, not colour alone', () => {
    renderEncounters(twoEventFixture(), {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });
    const winStatus = document.querySelector('[data-slot="encounter-set-status-win"]');
    const lossStatus = document.querySelector('[data-slot="encounter-set-status-loss"]');
    expect(winStatus).toBeInTheDocument();
    expect(lossStatus).toBeInTheDocument();
    const rows = document.querySelectorAll('[data-slot="encounter-set-row"]');
    const texts = [...rows].map((r) => r.textContent ?? '');
    expect(texts.some((text) => text.includes('Win'))).toBe(true);
    expect(texts.some((text) => text.includes('Loss'))).toBe(true);
  });

  it('with 12 sets, exactly 8 render plus one show-all control; activating it renders the rest', async () => {
    const user = userEvent.setup();
    const matches: Match[] = [];
    for (let i = 0; i < 12; i++) {
      matches.push(
        makeMatch({
          id: `s${i}`,
          time: 1000 + i,
          win: i % 2 === 0,
          externalId: `sgg:${i}:g1`,
          eventName: 'One Big Event',
        }),
      );
    }
    renderEncounters(matches, {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });

    expect(document.querySelectorAll('[data-slot="encounter-set-row"]').length).toBe(8);
    const showAll = screen.getByRole('button', { name: 'Show all sets' });
    await user.click(showAll);
    expect(document.querySelectorAll('[data-slot="encounter-set-row"]').length).toBe(12);
  });

  it('a manual-only fixture renders session headers with single rows and no set score', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1000, win: true }),
      makeMatch({ id: 'm2', time: 1100, win: false }),
    ];
    renderEncounters(matches);

    const sessionHeaders = document.querySelectorAll('[data-slot="encounter-session-header"]');
    expect(sessionHeaders.length).toBeGreaterThan(0);
    const rows = document.querySelectorAll('[data-slot="encounter-set-row"]');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // A single-game pseudo-set never prints a "N–M" score, only the result word.
      expect(row.textContent ?? '').not.toMatch(/\d+–\d+/);
    }
  });

  it('no rendered text contains the literal unknown-stage string', () => {
    const matches = [
      makeMatch({
        id: 'u1',
        time: 1000,
        win: true,
        externalId: 'sgg:5:g1',
        eventName: 'No Stage Event',
        map: { id: 0, name: 'no selection' },
      }),
    ];
    renderEncounters(matches, {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('unknown');
  });

  it('with no encounters, the existing empty copy renders and zero headers, controls and set rows render', () => {
    renderEncounters([]);
    expect(screen.getByText('No encounters recorded yet.')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="encounter-event-header"]').length).toBe(0);
    expect(document.querySelectorAll('[data-slot="encounter-session-header"]').length).toBe(0);
    expect(document.querySelectorAll('[data-slot="encounter-set-row"]').length).toBe(0);
  });

  it('expanding a set with an attached VOD renders a link to the subject-aware video route', async () => {
    const user = userEvent.setup();
    const matches = [
      makeMatch({
        id: 'v1',
        time: 1000,
        win: true,
        externalId: 'sgg:7:g1',
        eventName: 'Video Event',
        vodUrl: 'https://x.test/v',
      }),
    ];
    renderEncounters(matches, {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });

    const button = document.querySelector('[data-slot="encounter-set-row"] button')!;
    await user.click(button);
    const link = screen.getByRole('link', { name: /Win/ });
    expect(link).toHaveAttribute('href', '/vod?match=v1');
  });

  it('expanding a set with no VOD renders inline facts, not a link', async () => {
    const user = userEvent.setup();
    const matches = [
      makeMatch({
        id: 'nv1',
        time: 1000,
        win: true,
        externalId: 'sgg:8:g1',
        eventName: 'No Video Event',
      }),
    ];
    renderEncounters(matches, {
      tournamentLinkForMatch: () => ({ href: '/tournaments/x', label: 'x' }),
    });

    const button = document.querySelector('[data-slot="encounter-set-row"] button')!;
    await user.click(button);
    expect(screen.queryByRole('link', { name: /Win/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Win ·/)).toBeInTheDocument();
  });
});
