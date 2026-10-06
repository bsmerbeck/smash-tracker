import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { DEFAULT_VOD_MANAGER_FILTERS } from '../lib/vodManagerFilters';
import { VodMatchList } from './VodMatchList';

function makeMatch(id: string, opponent: string): Match {
  return {
    id,
    fighter_id: 1,
    opponent_id: 10,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent,
    notes: '',
    matchType: 'none',
    win: true,
    vodUrl: 'https://www.youtube.com/watch?v=abc123',
  } as unknown as Match;
}

function renderList(selectedId: string | null) {
  return render(
    <VodMatchList
      matches={[makeMatch('m1', 'rival-one'), makeMatch('m2', 'rival-two')]}
      filters={DEFAULT_VOD_MANAGER_FILTERS}
      filterOptions={{
        fighters: [],
        opponentFighters: [],
        stages: [],
        tournaments: [],
        opponents: [],
        tagsInUse: [],
      }}
      onFiltersChange={vi.fn()}
      sort="newest"
      onSortChange={vi.fn()}
      selectedId={selectedId}
      onSelect={vi.fn()}
    />,
  );
}

describe('VodMatchList row treatment', () => {
  // Owner report 2026-10-06: every unselected row carried the brand-red
  // `border-primary text-primary` accent, so a normal list read as a list
  // of errors. Unselected rows are neutral; only the selection is accented.
  it('renders unselected rows neutral, never in the primary (red) accent', () => {
    renderList('m1');

    const unselected = screen.getByRole('button', { name: 'Select match vs rival-two' });
    expect(unselected.className).not.toMatch(/(^|\s)text-primary(\s|$)/);
    expect(unselected.className).not.toMatch(/(^|\s)border-primary(\s|$)/);
    expect(unselected.className).toMatch(/(^|\s)border-border(\s|$)/);
    expect(unselected.className).toMatch(/(^|\s)text-foreground(\s|$)/);
  });

  it('keeps the selected row visually distinct from the unselected ones', () => {
    renderList('m1');

    const selected = screen.getByRole('button', { name: 'Select match vs rival-one' });
    const unselected = screen.getByRole('button', { name: 'Select match vs rival-two' });
    expect(selected.className).toMatch(/(^|\s)border-primary(\s|$)/);
    expect(selected.className).toMatch(/(^|\s)bg-accent(\s|$)/);
    expect(unselected.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
  });
});
