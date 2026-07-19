import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { ClientOverviewPage } from './ClientOverviewPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const matchesList = vi.fn();
const getFighters = vi.fn();
const clientsList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    users: { getFighters: (...args: unknown[]) => getFighters(...args) },
    coaching: {
      clients: { list: (...args: unknown[]) => clientsList(...args) },
    },
  },
}));

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: Date.now(),
    win: true,
    ...overrides,
  } as Match;
}

function renderOverview(initialPath = '/coach/tetra/overview') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId">
              <Route path="overview" element={<ClientOverviewPage />} />
              <Route path="fighters" element={<div>Fighters page</div>} />
              <Route path="match-data" element={<div>Match data page</div>} />
              <Route path="vods" element={<div>Vods page</div>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientOverviewPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    clientsList.mockResolvedValue([{ clientId: 'tetra', label: 'TETRA', draftCount: 0 }]);
  });

  it('shows the em-dash win rate and all three steps incomplete when the client has zero matches', async () => {
    matchesList.mockResolvedValue([]);
    getFighters.mockResolvedValue({ primary: [], secondary: [] });

    renderOverview();

    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();

    expect(screen.getByTestId('checklist-fighters')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('checklist-matches')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('checklist-vod')).toHaveAttribute('data-done', 'false');

    // The first incomplete row (fighters) gets the accent Edit button.
    const editLink = screen.getByRole('link', { name: 'Edit' });
    expect(editLink.className).toContain('bg-coaching-accent');
    expect(editLink).toHaveAttribute('href', '/coach/tetra/fighters');
  });

  it('marks fighters + matches done but the VOD step incomplete when no match has a vodUrl', async () => {
    matchesList.mockResolvedValue([
      makeMatch({ id: 'm1', win: true }),
      makeMatch({ id: 'm2', win: false }),
    ]);
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });

    renderOverview();

    await waitFor(() =>
      expect(screen.getByTestId('checklist-fighters')).toHaveAttribute('data-done', 'true'),
    );
    expect(screen.getByTestId('checklist-matches')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('checklist-vod')).toHaveAttribute('data-done', 'false');

    // The first incomplete row is now VOD — its button gets the accent.
    const attachLink = screen.getByRole('link', { name: 'Attach VOD' });
    expect(attachLink.className).toContain('bg-coaching-accent');
    expect(attachLink).toHaveAttribute('href', '/coach/tetra/vods');

    // Win rate is no longer the empty placeholder once matches exist.
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  // Phase 11 fix round 3 (FB-8): once every step is done, the tutorial
  // checklist is replaced by a compact "Quick actions" row — it never shows
  // completed tutorial steps again.
  it('FB-8: replaces the checklist with a Quick actions row once all three steps are done', async () => {
    matchesList.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, vodUrl: 'https://youtu.be/abc' }),
    ]);
    getFighters.mockResolvedValue({ primary: [1], secondary: [2] });

    renderOverview();

    expect(await screen.findByTestId('quick-actions')).toBeInTheDocument();
    expect(screen.getByText('Quick actions')).toBeInTheDocument();

    // The checklist rows are gone entirely, not just marked done.
    expect(screen.queryByTestId('checklist-fighters')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checklist-matches')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checklist-vod')).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Add match' })).toHaveAttribute(
      'href',
      '/coach/tetra/match-data',
    );
    expect(screen.getByRole('link', { name: 'Attach VOD' })).toHaveAttribute(
      'href',
      '/coach/tetra/vods',
    );
    expect(screen.getByRole('link', { name: 'Open analytics' })).toHaveAttribute(
      'href',
      '/coach/tetra/dashboard',
    );
  });

  it('keeps showing the checklist (not quick actions) while any step is incomplete', async () => {
    matchesList.mockResolvedValue([
      makeMatch({ id: 'm1', win: true }),
      makeMatch({ id: 'm2', win: false }),
    ]);
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });

    renderOverview();

    await waitFor(() =>
      expect(screen.getByTestId('checklist-fighters')).toHaveAttribute('data-done', 'true'),
    );
    expect(screen.getByTestId('checklist-matches')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('checklist-vod')).toHaveAttribute('data-done', 'false');
    expect(screen.queryByTestId('quick-actions')).not.toBeInTheDocument();
  });
});
