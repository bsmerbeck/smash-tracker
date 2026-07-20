import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import { WelcomePage } from './WelcomePage';

const upsertMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
  },
  ApiError: class ApiError extends Error {},
}));

function renderWelcome({
  initialPath = '/welcome',
  routerState,
}: { initialPath?: string; routerState?: { preselect?: string } } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[routerState ? { pathname: initialPath, state: routerState } : initialPath]}
      >
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/dashboard" element={<div>Dashboard content</div>} />
          <Route path="/vod" element={<div>VOD Manager page</div>} />
          <Route path="/coach" element={<div>Client Hub page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    window.localStorage.clear();
  });

  it('renders all five intent options and a skip link', () => {
    renderWelcome();

    expect(screen.getByTestId('intent-option-prepare')).toBeInTheDocument();
    expect(screen.getByTestId('intent-option-review_vod')).toBeInTheDocument();
    expect(screen.getByTestId('intent-option-track_improvement')).toBeInTheDocument();
    expect(screen.getByTestId('intent-option-scout')).toBeInTheDocument();
    expect(screen.getByTestId('intent-option-coach_clients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
  });

  it('selecting an intent saves it with onboardingAsked: true and navigates to its guided path', async () => {
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByTestId('intent-option-review_vod'));

    await waitFor(() =>
      expect(upsertMe).toHaveBeenCalledWith({
        onboardingIntent: 'review_vod',
        onboardingAsked: true,
      }),
    );
    expect(await screen.findByText('VOD Manager page')).toBeInTheDocument();
  });

  it('D-06: selecting coach_clients ALSO enables coaching mode via the same mutation before navigating to /coach', async () => {
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByTestId('intent-option-coach_clients'));

    await waitFor(() => expect(upsertMe).toHaveBeenCalledWith({ coachingModeEnabled: true }));
    expect(upsertMe).toHaveBeenCalledWith({
      onboardingIntent: 'coach_clients',
      onboardingAsked: true,
    });
    expect(await screen.findByText('Client Hub page')).toBeInTheDocument();
  });

  it('Skip saves nothing and lands on /dashboard', async () => {
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(upsertMe).not.toHaveBeenCalled();
  });

  it('D-02: pre-selects the origin-matched option via router state without saving anything until clicked', () => {
    renderWelcome({ routerState: { preselect: 'review_vod' } });

    expect(screen.getByTestId('intent-option-review_vod')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('intent-option-prepare')).toHaveAttribute('aria-pressed', 'false');
    expect(upsertMe).not.toHaveBeenCalled();
  });

  it('shows a "back to what you were watching" link when an origin stamp is present', () => {
    onboardingOrigin.stamp({ kind: 'coachReview', returnPath: '/r/token1' });
    renderWelcome();

    expect(screen.getByRole('link', { name: 'Back to what you were watching' })).toHaveAttribute(
      'href',
      '/r/token1',
    );
  });

  it('renders no back link when there is no origin stamp', () => {
    renderWelcome();

    expect(
      screen.queryByRole('link', { name: 'Back to what you were watching' }),
    ).not.toBeInTheDocument();
  });
});
