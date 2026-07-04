import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
} from '@/context/AnalyticsFilterContext';
import { MatchDataPage } from './MatchDataPage';
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
const listOpponents = vi.fn();
const updateMatch = vi.fn();
const deleteMatch = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
      remove: (...args: unknown[]) => deleteMatch(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: 'gg',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderMatchData() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/match-data']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/match-data" element={<MatchDataPage />} />
              <Route path="/choose-primary" element={<div>Choose primary page</div>} />
              <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
              <Route path="/dashboard" element={<div>Dashboard page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MatchDataPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    listOpponents.mockResolvedValue(['rival', 'other']);
    updateMatch.mockResolvedValue(makeMatch());
    deleteMatch.mockResolvedValue(undefined);
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchData();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
  });

  it('shows a no-matches empty state when the user has fighters but no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchData();

    expect(
      await screen.findByText(
        'You have no matches, report a match and check back here to view match data!',
      ),
    ).toBeInTheDocument();
  });

  it('renders rows from mocked matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true }),
      makeMatch({ id: 'm2', win: false, opponent: 'someone-else' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByText('Match History')).toBeInTheDocument());
    expect(screen.getAllByText('Win')).toHaveLength(1);
    expect(screen.getAllByText('Loss')).toHaveLength(1);
    expect(screen.getByText('rival')).toBeInTheDocument();
    expect(screen.getByText('someone-else')).toBeInTheDocument();
  });

  it('filters rows by the search input', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', opponent: 'rival' }),
      makeMatch({ id: 'm2', opponent: 'someone-else' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByText('rival')).toBeInTheDocument());

    const filterInput = screen.getByLabelText('Filter matches');
    await user.type(filterInput, 'someone');

    await waitFor(() => {
      expect(screen.queryByText('rival')).not.toBeInTheDocument();
      expect(screen.getByText('someone-else')).toBeInTheDocument();
    });
  });

  it('opens the edit dialog prefilled and submits a correctly shaped full PATCH payload', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: luigi.id,
        opponent: 'rival',
        notes: 'gg',
        matchType: 'quickplay',
        win: true,
        map: { id: 0, name: 'no selection' },
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit Match')).toBeInTheDocument();
    // Prefilled opponent name combobox trigger shows the existing value.
    expect(within(dialog).getByRole('combobox', { name: 'Opponent' })).toHaveTextContent('rival');

    // Flip the result to Loss and save, everything else stays as prefilled.
    await user.click(within(dialog).getByRole('radio', { name: 'Loss' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith('m1', {
      fighter_id: mario.id,
      opponent_id: luigi.id,
      map: { id: 0, name: 'no selection' },
      opponent: 'rival',
      notes: 'gg',
      matchType: 'quickplay',
      win: false,
    });
  });

  it('prefills stocksLeft/eventName/tournamentName in the edit dialog and round-trips them on save', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: luigi.id,
        opponent: 'rival',
        notes: 'gg',
        matchType: 'quickplay',
        win: true,
        map: { id: 0, name: 'no selection' },
        stocksLeft: 2,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('combobox', { name: 'Stocks Left (winner)' }),
    ).toHaveTextContent('2');

    // Tournament section is collapsed by default but prefilled underneath.
    await user.click(within(dialog).getByRole('button', { name: 'Tournament (optional)' }));
    expect(within(dialog).getByPlaceholderText('e.g. The Big House 9')).toHaveValue(
      'The Big House 9',
    );
    expect(within(dialog).getByPlaceholderText('e.g. Ultimate Singles')).toHaveValue(
      'Ultimate Singles',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        stocksLeft: 2,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      }),
    );
  });

  it('shows a clear-filters notice (not the no-matches hero) when the global filter empties an existing match set', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'startgg', range: 'all' }),
    );
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // All matches are manual (no `source`), so the persisted "startgg" filter excludes everything.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })]);

    renderMatchData();

    expect(await screen.findByText('No matches match the current filters.')).toBeInTheDocument();
    // The page itself still renders (not the page-level "no matches at all"
    // hero, which links out to /dashboard) — MatchTable's own per-widget
    // empty state is expected here since the filtered `matches` is empty.
    expect(screen.getByText('Match History')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() =>
      expect(screen.queryByText('No matches match the current filters.')).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText('rival').length).toBeGreaterThan(0);
  });

  it('deletes a match after confirmation', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1' })]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Delete match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Delete match'));

    const alert = await screen.findByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMatch).toHaveBeenCalledWith('m1'));
  });
});
