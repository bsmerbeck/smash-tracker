import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { PlayRhythmHeat } from './PlayRhythmHeat';

/**
 * B1 / DD-41-05/06 (UI-SPEC 7.3): the Play rhythm heat card hosts the volume MatrixHeat over the REAL
 * `buildActivityHeat`, so a change in the builder's shape fails here.
 */

let nextId = 0;

function game(year: number, month1to12: number, day = 10): Match {
  nextId += 1;
  return {
    id: `prh-${nextId}`,
    fighter_id: 8,
    opponent_id: 23,
    time: Date.UTC(year, month1to12 - 1, day, 12),
    win: true,
  } as Match;
}

function games(year: number, month: number, count: number): Match[] {
  return Array.from({ length: count }, (_, i) => game(year, month, 1 + i));
}

const TWO_YEARS = [...games(2025, 12, 25), ...games(2026, 3, 12), ...games(2026, 4, 1)];

describe('PlayRhythmHeat', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('titles the card, captions the year count, and renders one button per month with games', () => {
    const { container } = render(<PlayRhythmHeat matches={TWO_YEARS} onSelectMonth={() => {}} />);
    expect(screen.getByText('Play rhythm')).toBeInTheDocument();
    expect(screen.getByText('Games by month · 2 years, newest first')).toBeInTheDocument();
    const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
    expect(root.querySelectorAll('button')).toHaveLength(3);
    expect(root.querySelectorAll('.bg-muted\\/20')).toHaveLength(12 * 2 - 3);
  });

  it('one year is one row, singular caption', () => {
    const { container } = render(
      <PlayRhythmHeat matches={games(2026, 3, 2)} onSelectMonth={() => {}} />,
    );
    expect(screen.getByText('Games by month · 1 year, newest first')).toBeInTheDocument();
    const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(root.querySelectorAll('.bg-muted\\/20')).toHaveLength(11);
  });

  it('names each month in its aria-label with the localized month and a plural count', () => {
    render(<PlayRhythmHeat matches={TWO_YEARS} onSelectMonth={() => {}} />);
    expect(screen.getByRole('button', { name: 'December 2025: 25 games' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'April 2026: 1 game' })).toBeInTheDocument();
  });

  it('a month click hands the page that UTC month as its from/to range', async () => {
    const onSelectMonth = vi.fn();
    render(<PlayRhythmHeat matches={TWO_YEARS} onSelectMonth={onSelectMonth} />);
    await userEvent.click(screen.getByRole('button', { name: 'December 2025: 25 games' }));
    expect(onSelectMonth).toHaveBeenCalledWith({
      fromMs: Date.UTC(2025, 11, 1),
      toMs: Date.UTC(2026, 0, 1) - 1,
    });
  });

  describe('more than nine years', () => {
    const TEN_YEARS = Array.from({ length: 10 }, (_, i) => game(2017 + i, 5));

    it('draws the newest nine rows and says so in the caption', () => {
      const { container } = render(<PlayRhythmHeat matches={TEN_YEARS} onSelectMonth={() => {}} />);
      expect(
        screen.getByText('9 of 10 years shown · older years in the table'),
      ).toBeInTheDocument();
      const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
      // 9 rows x 12 columns of squares: 9 buttons + 99 placeholders = 108, the mark bound.
      expect(root.querySelectorAll('button')).toHaveLength(9);
      expect(root.querySelectorAll('.bg-muted\\/20')).toHaveLength(99);
      expect(screen.queryByText('2017')).toBeNull();
    });

    it('keeps every year, with a year total, in the table twin', async () => {
      render(<PlayRhythmHeat matches={TEN_YEARS} onSelectMonth={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
      const table = screen.getByRole('table', { name: 'Games by month, with year totals' });
      const bodyRows = within(table).getAllByRole('row').slice(1);
      expect(bodyRows).toHaveLength(10);
      expect(within(bodyRows[9]!).getByRole('rowheader').textContent).toBe('2017');
      expect(within(table).getByRole('columnheader', { name: 'Year total' })).toBeInTheDocument();
      // Each year holds one game: May is a 1, the year total is a 1, every other month a dash.
      const cells = within(bodyRows[0]!).getAllByRole('cell');
      expect(cells.map((cell) => cell.textContent)).toEqual([
        ...Array.from({ length: 12 }, (_, i) => (i === 4 ? '1' : '—')),
        '1',
      ]);
    });
  });

  it('the table twin is closed until asked for and then lists the month counts', async () => {
    render(<PlayRhythmHeat matches={TWO_YEARS} onSelectMonth={() => {}} />);
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    // Newest year first: 2026 holds 13 games (12 + 1), 2025 holds 25.
    expect(within(rows[0]!).getAllByRole('cell').at(-1)!.textContent).toBe('13');
    expect(within(rows[1]!).getAllByRole('cell').at(-1)!.textContent).toBe('25');
  });

  describe('E6 long-text: month labels at 22px cells', () => {
    it('keeps the full short month label and a two-letter form that shows below a 300px grid container', async () => {
      await i18n.changeLanguage('de');
      const { container } = render(<PlayRhythmHeat matches={TWO_YEARS} onSelectMonth={() => {}} />);
      const header = container.querySelector('[data-slot="matrix-heat-volume"] .grid')!;
      const full = Array.from(header.querySelectorAll('span.\\@max-\\[300px\\]\\:hidden')).map(
        (el) => el.textContent,
      );
      const narrow = Array.from(header.querySelectorAll('span.\\@max-\\[300px\\]\\:inline')).map(
        (el) => el.textContent,
      );
      expect(full).toHaveLength(12);
      expect(narrow).toHaveLength(12);
      // de March: the full label stays whole, the narrow one is two letters, never a cut glyph.
      expect(full[2]!.startsWith('M')).toBe(true);
      expect(full[2]!.length).toBeGreaterThan(2);
      expect(narrow[2]).toBe(Array.from(full[2]!).slice(0, 2).join(''));
      for (const label of narrow) expect(Array.from(label!).length).toBeLessThanOrEqual(2);
    });
  });
});
