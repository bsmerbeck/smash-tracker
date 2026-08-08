import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ClientHubRow } from '@smash-tracker/shared';
import { ResearchBadge } from './ResearchBadge';

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
    kind: 'ordinary',
    ...overrides,
  };
}

describe('ResearchBadge', () => {
  it('renders the research label for the research resolution', () => {
    render(<ResearchBadge client={makeClient({ kind: 'research' })} />);
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('renders the unresolved label for the unresolved resolution', () => {
    render(<ResearchBadge client={makeClient({ kind: 'unresolved' })} />);
    expect(screen.getByText('Unresolved')).toBeInTheDocument();
  });

  it('renders nothing for the ordinary resolution', () => {
    const { container } = render(<ResearchBadge client={makeClient({ kind: 'ordinary' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the research and unresolved badges are visually distinct (different variant styling)', () => {
    const { container: researchContainer } = render(
      <ResearchBadge client={makeClient({ kind: 'research' })} />,
    );
    const { container: unresolvedContainer } = render(
      <ResearchBadge client={makeClient({ kind: 'unresolved' })} />,
    );
    const researchClass = researchContainer.querySelector('[data-slot="badge"]')?.className;
    const unresolvedClass = unresolvedContainer.querySelector('[data-slot="badge"]')?.className;
    expect(researchClass).toBeTruthy();
    expect(unresolvedClass).toBeTruthy();
    expect(researchClass).not.toBe(unresolvedClass);
  });
});
