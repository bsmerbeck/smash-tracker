import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ShareSummary } from '@smash-tracker/shared';
import { ShareRow } from './ShareRow';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      vodShares: {
        revoke: vi.fn(),
        remove: vi.fn(),
      },
    },
  };
});

function makeShare(overrides: Partial<ShareSummary> = {}): ShareSummary {
  return {
    shareId: 'share-1',
    matchId: 'match-1',
    permissions: 'view',
    createdAt: 1_700_000_000_000,
    redaction: { includedNotes: true, includedTags: false, showDisplayName: false },
    status: 'active',
    url: 'https://grandfinals.gg/s/tok',
    result: 'win',
    fighterId: 1,
    opponentFighterId: 8,
    ...overrides,
  };
}

function renderRow(share: ShareSummary) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ShareRow share={share} />
    </QueryClientProvider>,
  );
}

describe('ShareRow tier badge (COACH-01)', () => {
  it('renders the plain View badge for a view-tier share and no coaching badge', () => {
    renderRow(makeShare({ permissions: 'view' }));

    expect(screen.getByText('View')).toBeInTheDocument();
    expect(screen.queryByText('Coaching')).not.toBeInTheDocument();
  });

  it('renders the distinct Coaching badge for an edit-tier share and drops the plain View badge', () => {
    renderRow(makeShare({ permissions: 'edit' }));

    const coachingBadge = screen.getByText('Coaching');
    expect(coachingBadge).toBeInTheDocument();
    // Differentiated Badge variant: filled default vs the view badge's outline.
    expect(coachingBadge).toHaveAttribute('data-variant', 'default');
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  it('keeps the tier badge on a revoked edit share (tier and status are independent facts)', () => {
    renderRow(makeShare({ permissions: 'edit', status: 'revoked', revokedAt: 1_700_100_000_000 }));

    expect(screen.getByText('Coaching')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });
});
