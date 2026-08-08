import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ClientWorkspaceLayout } from './ClientWorkspaceLayout';

const useResearchSubject = vi.fn();

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
}));

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/coach/tetra/overview']}>
      <Routes>
        <Route path="/coach/:clientId" element={<ClientWorkspaceLayout />}>
          <Route path="overview" element={<div>workspace content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ClientWorkspaceLayout', () => {
  it('mounts the banner exactly once for a research subject, alongside the outlet content', () => {
    useResearchSubject.mockReturnValue({
      isResearch: true,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.getAllByTestId('research-snapshot-banner')).toHaveLength(1);
    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('renders no banner and unchanged content for an ordinary subject', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();
    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('withholds page content while the kind lookup is pending, and renders the loading affordance instead', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: true,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders the outlet once the kind resolves', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('renders a localized error affordance with a retry control and no page content on a failed kind lookup', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: true,
      retry,
    });

    renderLayout();

    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    expect(screen.getByTestId('research-kind-load-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't verify this workspace")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
