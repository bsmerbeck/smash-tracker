import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { MatchupsPage } from './MatchupsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

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

const getFighters = vi.fn();
const listMatches = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
// SelectOpponent defaults to the alphabetically-first sprite, matching
// alphaSpriteList's sort in src/components/match-form/MatchForm.ts.
const alphabeticallyFirstSprite = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name))[0]!;

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderMatchups() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/matchups']}>
        <AuthProvider>
          <Routes>
            <Route path="/matchups" element={<MatchupsPage />} />
            <Route path="/choose-primary" element={<div>Choose primary page</div>} />
            <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MatchupsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchups();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose Primary Fighters' })).toHaveAttribute(
      'href',
      '/choose-primary',
    );
  });

  it('shows a no-matches empty state when the user has fighters but no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchups();

    expect(await screen.findByText("You haven't reported any matches!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('filters matches to the selected fighter/opponent pairing by default', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
      }),
      // Different opponent fighter — should NOT be counted against the default matchup.
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
    ]);

    renderMatchups();

    await waitFor(() => expect(screen.getByText('Matchup Results')).toBeInTheDocument());
    // Only the m1 match (vs the alphabetically-first opponent) should count.
    const winsStat = screen.getByText('Wins').closest('div');
    expect(winsStat).not.toBeNull();
    expect(within(winsStat!).getByText('1')).toBeInTheDocument();
  });

  it('updates the matchup when a different opponent is selected', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    renderMatchups();

    await waitFor(() =>
      expect(screen.getByLabelText('Select opponent fighter')).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await user.click(await screen.findByRole('option', { name: new RegExp(luigi.name) }));

    await waitFor(() => {
      const winsStat = screen.getByText('Wins').closest('div');
      expect(winsStat).not.toBeNull();
      // Two wins recorded against Luigi.
      expect(within(winsStat!).getByText('2')).toBeInTheDocument();
    });
  });

  it('shows matchup insights with streaks, form, and stage breakdown for the pairing', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        time: 1,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm3',
        time: 3,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: false,
        map: { id: 1, name: 'Battlefield' },
      }),
    ]);

    renderMatchups();

    await waitFor(() => expect(screen.getByText('Matchup Insights')).toBeInTheDocument());
    // Current streak: 1 loss (most recent match lost)
    expect(screen.getByText('1 losses')).toBeInTheDocument();
    // Recent form pips for all three matches
    expect(screen.getByLabelText('Last 3 results, newest first')).toBeInTheDocument();
    // Battlefield qualifies at the default per-stage threshold (3 matches, 67%)
    expect(screen.getByText('Stage Breakdown')).toBeInTheDocument();
    expect(screen.getByText('2-1')).toBeInTheDocument();
    expect(screen.getAllByText(/Battlefield/).length).toBeGreaterThan(0);
  });

  it('shows a no-matches message for the matchup table when the pairing has no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    renderMatchups();

    // Default opponent is alphabetically-first, not Luigi, so no matches for the default pairing.
    expect(await screen.findByText('No matches reported yet!')).toBeInTheDocument();
    expect(screen.getByText('No reported matches against this fighter')).toBeInTheDocument();
  });
});
