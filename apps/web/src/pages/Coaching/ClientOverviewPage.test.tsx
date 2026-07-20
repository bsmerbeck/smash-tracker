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
    getRedirectResult: mock.getRedirectResult,
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
const reviewsList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    users: { getFighters: (...args: unknown[]) => getFighters(...args) },
    coaching: {
      clients: { list: (...args: unknown[]) => clientsList(...args) },
      reviews: { list: (...args: unknown[]) => reviewsList(...args) },
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

/** A minimal `ReviewListItem` (the shape `GET .../reviews` returns). */
function makeReview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    reviewId: 'r1',
    status: 'draft',
    latestVersion: null,
    revision: 0,
    deliveryState: null,
    createdAt: Date.now(),
    lastAutosavedAt: Date.now(),
    ...overrides,
  };
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
              <Route path="reviews" element={<div>Reviews page</div>} />
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
    reviewsList.mockResolvedValue([]);
  });

  it('shows the em-dash win rate and all four steps incomplete when the client has zero matches/reviews', async () => {
    matchesList.mockResolvedValue([]);
    getFighters.mockResolvedValue({ primary: [], secondary: [] });

    renderOverview();

    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();

    expect(screen.getByTestId('checklist-fighters')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('checklist-matches')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('checklist-vod')).toHaveAttribute('data-done', 'false');
    expect(screen.getByTestId('checklist-review')).toHaveAttribute('data-done', 'false');

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
    expect(screen.getByTestId('checklist-review')).toHaveAttribute('data-done', 'false');

    // The first incomplete row is now VOD — its button gets the accent.
    const attachLink = screen.getByRole('link', { name: 'Attach VOD' });
    expect(attachLink.className).toContain('bg-coaching-accent');
    expect(attachLink).toHaveAttribute('href', '/coach/tetra/vods');

    // Win rate is no longer the empty placeholder once matches exist.
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  // Phase 13 (ONBD-05/D-08): the 4th step's done-state comes from the
  // published-review query, never a draft — a client with only a draft
  // review still shows the step incomplete.
  it('D-08: the review step stays incomplete while the client has only a draft (unpublished) review', async () => {
    matchesList.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, vodUrl: 'https://youtu.be/abc' }),
    ]);
    getFighters.mockResolvedValue({ primary: [1], secondary: [2] });
    reviewsList.mockResolvedValue([makeReview({ status: 'draft' })]);

    renderOverview();

    await waitFor(() =>
      expect(screen.getByTestId('checklist-vod')).toHaveAttribute('data-done', 'true'),
    );
    expect(screen.getByTestId('checklist-review')).toHaveAttribute('data-done', 'false');
    // The first three steps are done, so the review step is the sole
    // incomplete row and gets the accent button.
    const writeLink = screen.getByRole('link', { name: 'Write a review' });
    expect(writeLink.className).toContain('bg-coaching-accent');
    expect(writeLink).toHaveAttribute('href', '/coach/tetra/reviews');
  });

  // Phase 11 fix round 3 (FB-8): once every step is done, the tutorial
  // checklist is replaced by a compact "Quick actions" row — it never shows
  // completed tutorial steps again.
  it('FB-8: replaces the checklist with a Quick actions row once all four steps are done', async () => {
    matchesList.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, vodUrl: 'https://youtu.be/abc' }),
    ]);
    getFighters.mockResolvedValue({ primary: [1], secondary: [2] });
    reviewsList.mockResolvedValue([makeReview({ status: 'published', latestVersion: 1 })]);

    renderOverview();

    expect(await screen.findByTestId('quick-actions')).toBeInTheDocument();
    expect(screen.getByText('Quick actions')).toBeInTheDocument();

    // The checklist rows are gone entirely, not just marked done.
    expect(screen.queryByTestId('checklist-fighters')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checklist-matches')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checklist-vod')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checklist-review')).not.toBeInTheDocument();

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

  // Phase 11 fix round 3 (FB-7): overview enrichment — a Fighters card with
  // sprites and a recent-matches mini-list.
  describe('FB-7 overview enrichment', () => {
    it('shows an empty state for the Fighters card and recent matches when the client has neither', async () => {
      matchesList.mockResolvedValue([]);
      getFighters.mockResolvedValue({ primary: [], secondary: [] });

      renderOverview();

      expect(await screen.findByText('No fighters selected yet.')).toBeInTheDocument();
      expect(screen.getByText('No matches yet.')).toBeInTheDocument();
    });

    it("renders the client's primary/secondary fighter sprites", async () => {
      matchesList.mockResolvedValue([]);
      getFighters.mockResolvedValue({ primary: [1], secondary: [10] });

      renderOverview();

      expect(await screen.findByText('Primary')).toBeInTheDocument();
      expect(screen.getByText('Secondary')).toBeInTheDocument();
      expect(screen.getByText('Mario')).toBeInTheDocument();
      expect(screen.getByText('Luigi')).toBeInTheDocument();
    });

    it('renders the last 5 matches with date, opponent tag, characters, and a W/L chip', async () => {
      getFighters.mockResolvedValue({ primary: [1], secondary: [] });
      matchesList.mockResolvedValue([
        makeMatch({
          id: 'win-match',
          fighter_id: 1,
          opponent_id: 10,
          opponent: 'rival',
          win: true,
        }),
        makeMatch({
          id: 'loss-match',
          fighter_id: 1,
          opponent_id: 10,
          opponent: 'other',
          win: false,
          time: Date.now() - 1000,
        }),
      ]);

      renderOverview();

      expect(await screen.findByText('rival')).toBeInTheDocument();
      expect(screen.getByText('Recent matches')).toBeInTheDocument();
      expect(screen.getByText('other')).toBeInTheDocument();
      expect(screen.getByText('Win')).toBeInTheDocument();
      expect(screen.getByText('Loss')).toBeInTheDocument();
    });

    it('caps the recent-matches list at the 5 most recent by date', async () => {
      getFighters.mockResolvedValue({ primary: [1], secondary: [] });
      const now = Date.now();
      matchesList.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) =>
          makeMatch({
            id: `m${i}`,
            fighter_id: 1,
            opponent_id: 10,
            opponent: `opponent-${i}`,
            win: true,
            time: now - i * 1000,
          }),
        ),
      );

      renderOverview();

      await screen.findByText('opponent-0');
      // The 5 most recent (i=0..4); the older 3 (i=5..7) must be excluded.
      for (let i = 0; i < 5; i++) {
        expect(screen.getByText(`opponent-${i}`)).toBeInTheDocument();
      }
      for (let i = 5; i < 8; i++) {
        expect(screen.queryByText(`opponent-${i}`)).not.toBeInTheDocument();
      }
    });
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
    expect(screen.getByTestId('checklist-review')).toHaveAttribute('data-done', 'false');
    expect(screen.queryByTestId('quick-actions')).not.toBeInTheDocument();
  });
});
