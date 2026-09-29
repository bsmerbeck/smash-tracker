import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { resolveTournamentTier, type TournamentEntry } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TournamentsTable, type TournamentTableRow } from './TournamentsTable';

function makeRow(
  overrides: Record<string, unknown> = {},
  record = { wins: 0, losses: 0 },
): TournamentTableRow {
  const entry = {
    eventId: 1,
    entryKey: '1',
    eventName: 'Ultimate Singles',
    tournamentName: 'Supernova 2026',
    firstSetAt: Date.UTC(2026, 7, 8),
    lastSetAt: Date.UTC(2026, 7, 9),
    setsPlayed: 5,
    isOnline: false,
    ...overrides,
  } as TournamentEntry;
  const total = record.wins + record.losses;
  return {
    entry,
    record: {
      ...record,
      total,
      winRate: total === 0 ? 100 : Math.round((record.wins / total) * 100),
    } as TournamentTableRow['record'],
    resolution: resolveTournamentTier({ entry, observedOnline: false }),
  };
}

function renderTable(rows: TournamentTableRow[], layout: 'table' | 'stack' = 'table') {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <TournamentsTable rows={rows} layout={layout} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function manyRows(count: number): TournamentTableRow[] {
  return Array.from({ length: count }, (_, i) =>
    makeRow({
      eventId: 1000 + i,
      entryKey: String(1000 + i),
      tournamentName: `Event ${i}`,
      firstSetAt: Date.UTC(2025, 5, 1) + i * 86_400_000,
      lastSetAt: Date.UTC(2025, 5, 1) + i * 86_400_000,
    }),
  );
}

describe('TournamentsTable (TIER-02 / T-08)', () => {
  it('renders the six column headers with scope="col"', () => {
    renderTable([makeRow()]);
    const headers = screen
      .getAllByRole('columnheader')
      .filter((h) => h.getAttribute('scope') === 'col');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Tier',
      'Event',
      'Date',
      'Placement',
      'Seed Δ',
      'Record',
    ]);
  });

  it('shows tier, provenance, placement, seed delta and record on one row', () => {
    renderTable([
      makeRow(
        { placement: 3, numEntrants: 2048, seed: 8, slug: 'tournament/supernova-2026' },
        { wins: 26, losses: 7 },
      ),
    ]);
    const row = screen.getByText('Supernova 2026').closest('tr') as HTMLElement;
    expect(within(row).getByText('Supermajor')).toBeInTheDocument();
    expect(within(row).getByText('Estimated from 2,048 entrants')).toBeInTheDocument();
    expect(within(row).getByText('3rd / 2,048')).toBeInTheDocument();
    expect(within(row).getByText('+5')).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'Seed 8 → 3' })).toBeInTheDocument();
    expect(within(row).getByText('26–7')).toBeInTheDocument();
    expect(within(row).getByText('79%')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'View on start.gg' })).toHaveAttribute(
      'href',
      'https://start.gg/tournament/supernova-2026',
    );
  });

  it('marks the Placement cell data-col="place", never a placement-named attribute', () => {
    const { container } = renderTable([makeRow({ placement: 1, numEntrants: 64 })]);
    expect(container.querySelector('[data-col="place"]')).toHaveTextContent('1st / 64');
    expect(container.innerHTML).not.toMatch(/data-[a-z-]*placement/);
  });

  it('renders the ordinal alone when the entrant count is missing', () => {
    renderTable([makeRow({ placement: 3 })]);
    const cell = document.querySelector('[data-col="place"]') as HTMLElement;
    expect(cell.textContent).toBe('3rd');
  });

  it('renders a missing placement as an em dash and the seed delta with it', () => {
    renderTable([makeRow({ seed: 4, numEntrants: 64 })]);
    const cell = document.querySelector('[data-col="place"]') as HTMLElement;
    expect(cell.textContent).toBe('—');
    expect(document.querySelector('[data-slot="seed-delta"]')).toHaveAttribute(
      'data-state',
      'missing',
    );
  });

  it('renders a missing seed as an em dash seed delta even with a placement', () => {
    renderTable([makeRow({ placement: 3, numEntrants: 64 })]);
    expect(document.querySelector('[data-slot="seed-delta"]')).toHaveAttribute(
      'data-state',
      'missing',
    );
  });

  it('draws a fell-short delta with a real minus sign, never a hyphen', () => {
    renderTable([makeRow({ placement: 9, seed: 7, numEntrants: 96 })]);
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(screen.queryByText('-2')).not.toBeInTheDocument();
  });

  it('never prints a per-row Imported badge (T-08)', () => {
    renderTable([makeRow({ origin: 'admin-imported', provider: 'startgg' })]);
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
  });

  it('Gate 4: an imported row with no linked games renders an em dash record, never 0–0', () => {
    renderTable([makeRow({ origin: 'admin-imported', provider: 'startgg' })]);
    const row = screen.getByText('Supernova 2026').closest('tr') as HTMLElement;
    expect(within(row).queryByText('0–0')).not.toBeInTheDocument();
    expect(row.textContent).toMatch(/—\s*$/);
    expect(row.querySelector('[data-slot="record"]')).toBeNull();
  });

  it('a non-imported row with zero linked games keeps its real zero record', () => {
    renderTable([makeRow()]);
    expect(screen.getByText('0–0')).toBeInTheDocument();
  });

  it('groups rows under year headers, newest first, with singular and plural headers', () => {
    renderTable([
      makeRow({
        eventId: 1,
        entryKey: '1',
        tournamentName: 'A',
        firstSetAt: Date.UTC(2025, 5, 1),
        lastSetAt: Date.UTC(2025, 5, 1),
      }),
      makeRow({
        eventId: 2,
        entryKey: '2',
        tournamentName: 'B',
        firstSetAt: Date.UTC(2026, 5, 1),
        lastSetAt: Date.UTC(2026, 5, 1),
      }),
      makeRow({
        eventId: 3,
        entryKey: '3',
        tournamentName: 'C',
        firstSetAt: Date.UTC(2026, 6, 1),
        lastSetAt: Date.UTC(2026, 6, 1),
      }),
    ]);
    const groups = Array.from(document.querySelectorAll('th[scope="colgroup"]')).map(
      (th) => th.textContent,
    );
    expect(groups).toEqual(['2026 · 2 events', '2025 · 1 event']);
    const names = screen
      .getAllByRole('link')
      .map((a) => a.textContent)
      .filter((text) => ['A', 'B', 'C'].includes(text ?? ''));
    expect(names).toEqual(['C', 'B', 'A']);
  });

  it('a single-year account renders one header, never zero', () => {
    renderTable([makeRow()]);
    expect(document.querySelectorAll('th[scope="colgroup"]')).toHaveLength(1);
  });

  it('groups undated rows last under "No date"', () => {
    renderTable([
      makeRow({
        eventId: 1,
        entryKey: '1',
        tournamentName: 'Undated',
        firstSetAt: 0,
        lastSetAt: 0,
      }),
      makeRow({ eventId: 2, entryKey: '2', tournamentName: 'Dated' }),
    ]);
    const groups = Array.from(document.querySelectorAll('th[scope="colgroup"]')).map(
      (th) => th.textContent,
    );
    expect(groups).toEqual(['2026 · 1 event', 'No date']);
  });

  it('makes every row a drillable overlay into the event with a whole-row accessible name', () => {
    renderTable([makeRow({ placement: 3, numEntrants: 2048, seed: 8 }, { wins: 26, losses: 7 })]);
    const overlay = screen.getByRole('link', {
      name: /^Supernova 2026, Ultimate Singles, .*Supermajor, 3rd \/ 2,048, 26–7; opens the event$/,
    });
    expect(overlay).toHaveAttribute('href', '/tournaments/1');
    expect(screen.getByRole('link', { name: 'Supernova 2026' })).toHaveAttribute(
      'href',
      '/tournaments/1',
    );
  });

  it('routes a parry.gg row on its entryKey and omits the start.gg link', () => {
    renderTable([
      makeRow({
        eventId: undefined,
        entryKey: 'pgg-the-big-house-9',
        tournamentName: 'The Big House 9',
        source: 'parrygg',
      }),
    ]);
    expect(screen.getByRole('link', { name: 'The Big House 9' })).toHaveAttribute(
      'href',
      '/tournaments/pgg-the-big-house-9',
    );
    expect(screen.queryByRole('link', { name: 'View on start.gg' })).not.toBeInTheDocument();
  });

  it('falls back to the event name when the tournament name is absent', () => {
    renderTable([makeRow({ tournamentName: undefined })]);
    expect(screen.getByRole('link', { name: 'Ultimate Singles' })).toHaveAttribute(
      'href',
      '/tournaments/1',
    );
  });

  it("renders an import's own event dates when recorded", () => {
    renderTable([
      makeRow({
        origin: 'admin-imported',
        provider: 'startgg',
        startAtMs: Date.UTC(2024, 5, 10, 12),
        endAtMs: Date.UTC(2024, 5, 11, 12),
      }),
    ]);
    expect(screen.getByText('Jun 10, 2024 – Jun 11, 2024')).toBeInTheDocument();
  });

  it('shows the Online badge and the Side event badge only when they differ from the default', () => {
    renderTable([
      makeRow({ eventId: 1, entryKey: '1', tournamentName: 'Main', isOnline: false }),
      makeRow({ eventId: 2, entryKey: '2', tournamentName: 'Weekly', isOnline: true }),
      makeRow({
        eventId: 3,
        entryKey: '3',
        tournamentName: 'Side',
        eventName: 'Squad Strike',
        isOnline: false,
      }),
    ]);
    const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(within(rowOf('Main')).queryByText('Online')).not.toBeInTheDocument();
    expect(within(rowOf('Weekly')).getByText('Online')).toBeInTheDocument();
    expect(within(rowOf('Side')).getByText('Side event')).toBeInTheDocument();
    expect(within(rowOf('Weekly')).getByText('Tier unknown')).toBeInTheDocument();
  });

  describe('paging (no inner scroller)', () => {
    it('mounts at most 100 rows, then 50 more on demand', async () => {
      renderTable(manyRows(160));
      expect(
        screen.getAllByRole('row').filter((r) => r.dataset.slot === 'tournaments-row'),
      ).toHaveLength(100);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
      expect(document.querySelectorAll('[data-slot="tournaments-row"]')).toHaveLength(150);
      await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
      expect(document.querySelectorAll('[data-slot="tournaments-row"]')).toHaveLength(160);
      expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
    });

    it('offers no paging control at or under the cap', () => {
      renderTable(manyRows(100));
      expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
    });

    it('below 640px mounts 20 stacked rows and pages by 20', async () => {
      renderTable(manyRows(45), 'stack');
      expect(document.querySelectorAll('[data-slot="tournaments-row"]')).toHaveLength(20);
      expect(document.querySelector('table')).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Show 20 more' }));
      expect(document.querySelectorAll('[data-slot="tournaments-row"]')).toHaveLength(40);
      await user.click(screen.getByRole('button', { name: 'Show 20 more' }));
      expect(document.querySelectorAll('[data-slot="tournaments-row"]')).toHaveLength(45);
    });

    it('never puts a scroll container of its own on the list', () => {
      const { container } = renderTable(manyRows(30));
      expect(container.innerHTML).not.toMatch(/overflow-y|max-h-/);
    });
  });

  describe('stacked layout (below 640px)', () => {
    it('keeps the row link, tier badge, placement, seed delta and record', () => {
      renderTable(
        [makeRow({ placement: 3, numEntrants: 2048, seed: 8 }, { wins: 26, losses: 7 })],
        'stack',
      );
      const item = document.querySelector('[data-slot="tournaments-row"]') as HTMLElement;
      expect(within(item).getByRole('link', { name: /opens the event$/ })).toHaveAttribute(
        'href',
        '/tournaments/1',
      );
      expect(within(item).getByText('Supermajor')).toBeInTheDocument();
      expect(within(item).getByText('3rd / 2,048')).toBeInTheDocument();
      expect(within(item).getByText('+5')).toBeInTheDocument();
      expect(within(item).getByText('26–7')).toBeInTheDocument();
    });
  });
});

describe('DD-18: ordinal placement through i18next plurals in every locale', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  const CASES: Record<string, Record<number, string>> = {
    en: { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 11: '11th', 21: '21st', 22: '22nd', 23: '23rd' },
    es: { 1: '1.º', 3: '3.º', 4: '4.º' },
    fr: { 1: '1er', 2: '2e', 3: '3e', 4: '4e' },
    de: { 1: '1.', 3: '3.', 4: '4.' },
    pt: { 1: '1º', 3: '3º', 4: '4º' },
    ja: { 1: '1位', 3: '3位', 4: '4位' },
  };

  for (const [locale, expected] of Object.entries(CASES)) {
    it(`${locale} resolves each ordinal form`, async () => {
      await i18n.changeLanguage(locale);
      for (const [count, text] of Object.entries(expected)) {
        expect(
          i18n.t('tournaments.table.placement', { count: Number(count), ordinal: true }),
          `${locale} ${count}`,
        ).toBe(text);
      }
    });
  }

  it('groups a four-digit placement per locale instead of printing it bare', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('tournaments.table.placement', { count: 1024, ordinal: true })).toBe('1,024th');
    await i18n.changeLanguage('de');
    expect(i18n.t('tournaments.table.placement', { count: 1024, ordinal: true })).toBe('1.024.');
  });
});
