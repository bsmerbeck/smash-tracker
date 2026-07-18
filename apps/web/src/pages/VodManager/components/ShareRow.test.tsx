import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ShareSummary } from '@smash-tracker/shared';
import { ShareRow } from './ShareRow';

const removeShare = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      vodShares: {
        revoke: vi.fn(),
        remove: (...args: unknown[]) => removeShare(...args),
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

function renderRow(
  share: ShareSummary,
  props: {
    selectionMode?: boolean;
    selected?: boolean;
    onToggleSelected?: (next: boolean) => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ShareRow share={share} {...props} />
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

describe('ShareRow expired state (WR-05)', () => {
  it('labels an expired edit share, drops the dead-link Copy action, but keeps Revoke', () => {
    renderRow(makeShare({ permissions: 'edit', status: 'expired' }));

    expect(screen.getByText('Expired')).toBeInTheDocument();
    // The link is dead — no working Copy button for it.
    expect(screen.queryByRole('button', { name: 'Copy share link' })).not.toBeInTheDocument();
    // Revoke stays available: revoking is the path to deleting the row.
    expect(screen.getByRole('button', { name: 'Revoke share link' })).toBeInTheDocument();
    // Not yet revoked, so no delete action either.
    expect(screen.queryByRole('button', { name: 'Delete revoked share' })).not.toBeInTheDocument();
  });

  it('an active share shows neither the Expired label nor loses its Copy action', () => {
    renderRow(makeShare({ status: 'active' }));

    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy share link' })).toBeInTheDocument();
  });
});

describe('ShareRow active-row Delete (FB-03)', () => {
  it('renders a Delete button on an active row and confirming it deletes in one click', async () => {
    const user = userEvent.setup();
    renderRow(makeShare({ status: 'active' }));

    // Active row keeps Copy + Revoke and now also has Delete — no forced
    // revoke-then-delete chain.
    expect(screen.getByRole('button', { name: 'Copy share link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke share link' })).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: 'Delete share' });
    expect(deleteButton).toBeInTheDocument();

    await user.click(deleteButton);

    expect(screen.getByText('Delete this share link?')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This permanently removes the share and kills the link immediately — anyone with it loses access now. Previews already posted in Discord may keep showing the old preview. This can't be undone.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(removeShare).toHaveBeenCalledWith('share-1');
  });

  it('an expired row does not get the active-row Delete', () => {
    renderRow(makeShare({ status: 'expired' }));

    expect(screen.queryByRole('button', { name: 'Delete share' })).not.toBeInTheDocument();
  });

  it('a revoked row keeps its existing revoked-only Delete, not the active-row Delete', () => {
    renderRow(makeShare({ status: 'revoked' }));

    expect(screen.queryByRole('button', { name: 'Delete share' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete revoked share' })).toBeInTheDocument();
  });
});

describe('ShareRow selection checkbox (FB-03)', () => {
  it('renders no checkbox when selectionMode is false (default)', () => {
    renderRow(makeShare());

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a checkbox reflecting `selected` and calls onToggleSelected on change', async () => {
    const user = userEvent.setup();
    const onToggleSelected = vi.fn();
    renderRow(makeShare(), { selectionMode: true, selected: false, onToggleSelected });

    const checkbox = screen.getByRole('checkbox', { name: 'Select this share' });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(onToggleSelected).toHaveBeenCalledWith(true);
  });
});
