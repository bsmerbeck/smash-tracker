import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GspEntry, GspReading, Match } from '@smash-tracker/shared';
import { GspMatchLog } from './GspMatchLog';

function makeGspMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'gsp'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 8,
    win: true,
    ...overrides,
  };
}

function matchEntry(match: Match): GspEntry {
  return { kind: 'match', time: match.time, gsp: match.gsp!, win: match.win, match };
}

function readingEntry(reading: GspReading): GspEntry {
  return { kind: 'reading', time: reading.time, gsp: reading.gsp, reading };
}

// Ascending time, matching getGspEntries output.
const entries: GspEntry[] = [
  matchEntry(makeGspMatch({ id: 'a', time: Date.UTC(2026, 0, 1, 12), gsp: 9_000_000 })),
  matchEntry(makeGspMatch({ id: 'b', time: Date.UTC(2026, 0, 2, 12), gsp: 9_150_000 })),
  matchEntry(makeGspMatch({ id: 'c', time: Date.UTC(2026, 0, 3, 12), gsp: 9_050_000, win: false })),
];

describe('GspMatchLog', () => {
  it('renders nothing when there are no GSP entries', () => {
    const { container } = render(<GspMatchLog entries={[]} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists entries newest-first with formatted GSP and signed deltas', () => {
    render(<GspMatchLog entries={entries} onEdit={vi.fn()} onDelete={vi.fn()} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Newest (loss, 9,050,000, delta -100,000) first.
    expect(items[0]).toHaveTextContent('Loss');
    expect(items[0]).toHaveTextContent('9,050,000');
    expect(items[0]).toHaveTextContent('-100,000');
    expect(items[1]).toHaveTextContent('+150,000');
    // Oldest entry has no previous reading, so no delta.
    expect(items[2]).toHaveTextContent('9,000,000');
    expect(items[2]!.textContent).not.toContain('+');
  });

  it('renders a calibration reading with a Set badge and no delta', () => {
    const withReading: GspEntry[] = [
      ...entries,
      readingEntry({ id: 'r1', fighter_id: 1, time: Date.UTC(2026, 0, 4, 12), gsp: 9_500_000 }),
      matchEntry(makeGspMatch({ id: 'd', time: Date.UTC(2026, 0, 5, 12), gsp: 9_510_000 })),
    ];
    render(<GspMatchLog entries={withReading} onEdit={vi.fn()} onDelete={vi.fn()} />);

    const items = screen.getAllByRole('listitem');
    // Newest first: the match after the calibration deltas from the NEW
    // baseline (+10,000), not from the pre-drift number.
    expect(items[0]).toHaveTextContent('Win');
    expect(items[0]).toHaveTextContent('+10,000');
    // The calibration row: "Set" badge, the value, and no win/loss/delta.
    expect(items[1]).toHaveTextContent('Set');
    expect(items[1]).toHaveTextContent('9,500,000');
    expect(items[1]!.textContent).not.toContain('+');
    expect(items[1]!.textContent).not.toContain('Win');
    expect(items[1]!.textContent).not.toContain('Loss');
  });

  it('raises onEdit/onDelete with the row entry', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<GspMatchLog entries={entries} onEdit={onEdit} onDelete={onDelete} />);

    await user.click(screen.getAllByRole('button', { name: /^Edit GSP entry/ })[0]!);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(entries[2]);

    await user.click(screen.getAllByRole('button', { name: /^Delete GSP entry/ })[2]!);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(entries[0]);
  });

  it('collapses long logs behind a "Show all" toggle', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      matchEntry(
        makeGspMatch({
          id: `m${i}`,
          time: Date.UTC(2026, 0, i + 1, 12),
          gsp: 9_000_000 + i * 1000,
        }),
      ),
    );
    render(<GspMatchLog entries={many} onEdit={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show all 12 entries' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });
});
