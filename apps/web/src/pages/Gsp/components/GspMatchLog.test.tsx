import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { GspMatchLog } from './GspMatchLog';

function makeGspMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'gsp'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 8,
    win: true,
    ...overrides,
  };
}

// Ascending time, matching getGspMatches output.
const gspMatches: Match[] = [
  makeGspMatch({ id: 'a', time: Date.UTC(2026, 0, 1, 12), gsp: 9_000_000 }),
  makeGspMatch({ id: 'b', time: Date.UTC(2026, 0, 2, 12), gsp: 9_150_000 }),
  makeGspMatch({ id: 'c', time: Date.UTC(2026, 0, 3, 12), gsp: 9_050_000, win: false }),
];

describe('GspMatchLog', () => {
  it('renders nothing when there are no GSP entries', () => {
    const { container } = render(
      <GspMatchLog gspMatches={[]} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists entries newest-first with formatted GSP and signed deltas', () => {
    render(<GspMatchLog gspMatches={gspMatches} onEdit={vi.fn()} onDelete={vi.fn()} />);

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

  it('raises onEdit/onDelete with the row match', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<GspMatchLog gspMatches={gspMatches} onEdit={onEdit} onDelete={onDelete} />);

    await user.click(screen.getAllByRole('button', { name: /^Edit GSP entry/ })[0]!);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(gspMatches[2]);

    await user.click(screen.getAllByRole('button', { name: /^Delete GSP entry/ })[2]!);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(gspMatches[0]);
  });

  it('collapses long logs behind a "Show all" toggle', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      makeGspMatch({ id: `m${i}`, time: Date.UTC(2026, 0, i + 1, 12), gsp: 9_000_000 + i * 1000 }),
    );
    render(<GspMatchLog gspMatches={many} onEdit={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show all 12 entries' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });
});
