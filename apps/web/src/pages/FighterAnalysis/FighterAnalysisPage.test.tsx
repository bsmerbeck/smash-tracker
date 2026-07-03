import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { FighterAnalysisPage } from './FighterAnalysisPage';
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

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const fox = SpriteList.find((s) => s.id === 8)!;

function makeMatch(
  overrides: Partial<Record<string, unknown>> & { id: string; time: number; win: boolean },
) {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderFighterAnalysis() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fighter-analysis']}>
        <AuthProvider>
          <Routes>
            <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
            <Route path="/choose-primary" element={<div>Choose primary page</div>} />
            <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FighterAnalysisPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderFighterAnalysis();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
  });

  it('shows a no-matches empty state when the user has fighters but no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderFighterAnalysis();

    expect(await screen.findByText("You haven't reported any matches!")).toBeInTheDocument();
  });

  it('renders correct streak values for a win/loss sequence', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // Chronological: W, W, L, L, L, W (best win streak 2, worst loss streak 3, current streak 1 win)
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: false }),
      makeMatch({ id: 'm4', time: 4, win: false }),
      makeMatch({ id: 'm5', time: 5, win: false }),
      makeMatch({ id: 'm6', time: 6, win: true }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Streaks')).toBeInTheDocument());

    // Current streak: 1 (last match was a win)
    const currentBlock = screen.getByText('Current').closest('div')!;
    expect(within(currentBlock).getByText('1')).toBeInTheDocument();
    // Best win streak: 2
    const bestBlock = screen.getByText('Best').closest('div')!;
    expect(within(bestBlock).getByText('2')).toBeInTheDocument();
    // Worst loss streak: 3
    const worstBlock = screen.getByText('Worst').closest('div')!;
    expect(within(worstBlock).getByText('3')).toBeInTheDocument();
  });

  it('applies the minimum match threshold to Best/Worst Stage', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // Only 2 wins on Battlefield (id 1) — below the default threshold of 5, so "not enough matches".
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'm2', time: 2, win: true, map: { id: 1, name: 'Battlefield' } }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Best/Worst Stage')).toBeInTheDocument());
    expect(screen.getAllByText('not enough matches')).toHaveLength(2);
  });

  it('shows Best Stage once wins on a stage meet the threshold', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    const battlefieldWins = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `bf-${i}`, time: i, win: true, map: { id: 1, name: 'Battlefield' } }),
    );
    listMatches.mockResolvedValue(battlefieldWins);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Best/Worst Stage')).toBeInTheDocument());
    // "Battlefield" appears both as the Best Stage heading and in the Roster
    // Breakdown table row for Luigi (the default opponent), so assert via
    // the specific heading element rather than a single unique text match.
    expect(screen.getByRole('heading', { name: 'Battlefield', level: 4 })).toBeInTheDocument();
  });

  it('lists only faced opponents in the Matchup Stage Guide with records and stage calls', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      // 3 wins vs Luigi on Battlefield (id 1) — qualifies at the default threshold of 3
      makeMatch({
        id: 'm1',
        time: 1,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm3',
        time: 3,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({ id: 'm4', time: 4, win: false, opponent_id: fox.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Matchup Stage Guide')).toBeInTheDocument());
    // Both faced opponents appear with their records
    expect(screen.getAllByText(luigi.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(fox.name).length).toBeGreaterThan(0);
    expect(screen.getByText('3-0')).toBeInTheDocument();
    // Luigi's best stage qualifies (3 matches on Battlefield at 100%)
    expect(screen.getAllByText(/Battlefield/).length).toBeGreaterThan(0);
    expect(screen.getByText('(100% over 3)')).toBeInTheDocument();
  });

  it('shows overall best and worst matchup sections with a threshold control', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: luigi.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Best & Worst Matchups')).toBeInTheDocument());
    expect(screen.getByText('Best Matchups')).toBeInTheDocument();
    expect(screen.getByText('Worst Matchups')).toBeInTheDocument();
    // Default threshold of 5 not met by a single match
    expect(screen.getAllByText('No matchups meet the threshold yet.').length).toBe(2);
  });

  it('shows the performance snapshot with recent form and match-type splits', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: 'm2', time: 2, win: false, matchType: '' }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Performance Snapshot')).toBeInTheDocument());
    expect(screen.getByLabelText('Last 2 results, newest first')).toBeInTheDocument();
    expect(screen.getByText('quickplay')).toBeInTheDocument();
    expect(screen.getByText('unspecified')).toBeInTheDocument();
  });

  it('lists named-opponent records in the Opponent table, ignoring blank names', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent: 'rival' }),
      makeMatch({ id: 'm2', time: 2, win: false, opponent: '' }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Opponents')).toBeInTheDocument());
    expect(screen.getByText('rival')).toBeInTheDocument();
  });
});
