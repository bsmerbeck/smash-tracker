import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ClientHubRow } from '@smash-tracker/shared';
import { ClaimStatusBadge } from './ClaimStatusBadge';

const NOW = new Date('2026-07-25T12:00:00Z').getTime();
const HOUR_MS = 60 * 60 * 1000;

function makeClient(overrides: Partial<ClientHubRow> = {}): ClientHubRow {
  return {
    clientId: 'tetra',
    label: 'Tetra',
    lastActivityAt: null,
    draftCount: 0,
    deliveryState: null,
    archivedAt: null,
    claimedAt: null,
    pendingInvitationExpiresAt: null,
    ...overrides,
  };
}

describe('ClaimStatusBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Claimed when claimedAt is set, regardless of pendingInvitationExpiresAt', () => {
    render(
      <ClaimStatusBadge
        client={makeClient({
          claimedAt: NOW - HOUR_MS,
          pendingInvitationExpiresAt: NOW + HOUR_MS,
        })}
      />,
    );
    expect(screen.getByText('Claimed')).toBeInTheDocument();
  });

  it('renders the code-active badge with the remaining whole hours when a code lapses 3 hours out', () => {
    render(
      <ClaimStatusBadge
        client={makeClient({ claimedAt: null, pendingInvitationExpiresAt: NOW + 3 * HOUR_MS })}
      />,
    );
    const badge = screen.getByText(/claim code active/i);
    expect(badge.textContent).toContain('3');
  });

  it('renders the "expires soon" variant with no zero-hour count when under an hour remains', () => {
    render(
      <ClaimStatusBadge
        client={makeClient({ pendingInvitationExpiresAt: NOW + 30 * 60 * 1000 })}
      />,
    );
    const badge = screen.getByText(/claim code active/i);
    expect(badge.textContent).not.toContain('0 hour');
  });

  it('renders Managed when the pending code has already lapsed', () => {
    render(<ClaimStatusBadge client={makeClient({ pendingInvitationExpiresAt: NOW - HOUR_MS })} />);
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('renders Managed when both claimedAt and pendingInvitationExpiresAt are null', () => {
    render(<ClaimStatusBadge client={makeClient()} />);
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });
});
