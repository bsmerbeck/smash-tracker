import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ScoutCommonOpponent } from '@smash-tracker/shared';
import { ScoutCommonOpponentsCard } from './ScoutCommonOpponentsCard';

function renderCard(opponents: ScoutCommonOpponent[], initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ScoutCommonOpponentsCard opponents={opponents} />
    </MemoryRouter>,
  );
}

describe('ScoutCommonOpponentsCard', () => {
  it('renders the empty state when there are no common opponents', () => {
    renderCard([]);
    expect(screen.getByText('No repeat opponents in the sample.')).toBeInTheDocument();
  });

  it("a row's destination uses the NORMALIZED form of a mixed-case, space-bearing third-party tag", () => {
    renderCard([{ gamerTag: '  MkLeo Jr. ', sets: 3 }]);
    const link = screen.getByRole('link', { name: /MkLeo Jr\./ });
    // normalizeOpponentTag: trim + lowercase, then strip only `.#$[]/` and
    // control chars (\x00-\x1f) — a plain space is NOT in that class, so it
    // survives and gets percent-encoded as a path segment.
    expect(link).toHaveAttribute('href', '/opponents/mkleo%20jr');
  });

  it('carries the coach prefix through the destination', () => {
    renderCard([{ gamerTag: 'rival', sets: 2 }], '/coach/client-a/scout');
    const link = screen.getByRole('link', { name: /rival/ });
    expect(link).toHaveAttribute('href', '/coach/client-a/opponents/rival');
  });
});
