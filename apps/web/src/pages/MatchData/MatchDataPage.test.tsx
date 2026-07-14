import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router';
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
const getStageFavorites = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });

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
    stageFavorites: {
      get: (...args: unknown[]) => getStageFavorites(...args),
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

/** Stands in for `/vod` so navigation from the VOD menu's "Go to VOD Manager" item can be asserted without rendering the real VodManagerPage. */
function VodRouteProbe() {
  const [params] = useSearchParams();
  return <div>VOD Manager page (match={params.get('match')})</div>;
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
              <Route path="/vod" element={<VodRouteProbe />} />
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

  it('saves an edit to an anonymous quickplay match without requiring an opponent name', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: luigi.id,
        // The GSP Quick Logger stores anonymous quickplay opponents as ''.
        opponent: '',
        notes: '',
        matchType: 'quickplay',
        win: true,
        gsp: 9_000_000,
        map: { id: 0, name: 'no selection' },
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    // Flip the result and save without touching the blank opponent field —
    // this used to fail validation with "Opponent name is required".
    await user.click(within(dialog).getByRole('radio', { name: 'Loss' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ opponent: '', win: false }),
    );
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

  it('clears vodUrl and vodTimestamps when the VOD link field is blanked on save', async () => {
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
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('VOD URL')).toHaveValue(
      'https://youtube.com/watch?v=abc123',
    );

    await user.clear(within(dialog).getByLabelText('VOD URL'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const payload = updateMatch.mock.calls[0]![1];
    expect(payload).not.toHaveProperty('vodUrl');
    expect(payload).not.toHaveProperty('vodTimestamps');
  });

  it('carries existing vodTimestamps through when the VOD link is edited (not cleared)', async () => {
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
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('VOD URL'));
    await user.type(within(dialog).getByLabelText('VOD URL'), 'https://youtube.com/watch?v=xyz789');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        vodUrl: 'https://youtube.com/watch?v=xyz789',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    );
  });

  it('blocks saving an invalid VOD URL with an inline validation error', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1' })]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Edit match')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Edit match'));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('VOD URL'), 'not-a-url');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('Enter a valid URL (or leave blank)'),
    ).toBeInTheDocument();
    expect(updateMatch).not.toHaveBeenCalled();
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

  it('shows "Add VOD notes" for a match without a vodUrl and "Watch VOD" for one with', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', opponent: 'rival' }),
      makeMatch({
        id: 'm2',
        opponent: 'someone-else',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getAllByLabelText('Add VOD notes')).toHaveLength(1));
    expect(screen.getAllByLabelText('Watch VOD')).toHaveLength(1);
  });

  it('opens a 3-item action menu (Go to VOD Manager, Edit VOD link, Remove VOD link) from the VOD icon when the match has a VOD', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', vodUrl: 'https://youtube.com/watch?v=abc123' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Watch VOD')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Watch VOD'));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Go to VOD Manager' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Edit VOD link' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Remove VOD link' })).toBeInTheDocument();
  });

  it('navigates to the VOD Manager, preselecting the match, via "Go to VOD Manager"', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', vodUrl: 'https://youtube.com/watch?v=abc123' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Watch VOD')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Watch VOD'));
    await user.click(await screen.findByRole('menuitem', { name: 'Go to VOD Manager' }));

    expect(await screen.findByText('VOD Manager page (match=m1)')).toBeInTheDocument();
  });

  it('opens the Edit Match dialog prefilled via "Edit VOD link"', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', vodUrl: 'https://youtube.com/watch?v=abc123' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Watch VOD')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Watch VOD'));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit VOD link' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit Match')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('VOD URL')).toHaveValue(
      'https://youtube.com/watch?v=abc123',
    );
  });

  it('clears vodUrl and vodTimestamps via a full PATCH after confirming "Remove VOD link"', async () => {
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
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByLabelText('Watch VOD')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Watch VOD'));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove VOD link' }));

    const alert = await screen.findByRole('alertdialog');
    expect(within(alert).getByText('Remove this VOD link?')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith('m1', {
      fighter_id: mario.id,
      opponent_id: luigi.id,
      map: { id: 0, name: 'no selection' },
      opponent: 'rival',
      notes: 'gg',
      matchType: 'quickplay',
      win: true,
    });
    const payload = updateMatch.mock.calls[0]![1];
    expect(payload).not.toHaveProperty('vodUrl');
    expect(payload).not.toHaveProperty('vodTimestamps');
  });

  it('opens the VOD notes dialog and saves a new VOD URL and timestamp', async () => {
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

    await waitFor(() => expect(screen.getByLabelText('Add VOD notes')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Add VOD notes'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('VOD Notes')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('VOD URL'), 'https://youtube.com/watch?v=abc123');
    await user.type(within(dialog).getByLabelText('Timestamp time'), '2:41');
    await user.type(within(dialog).getByLabelText('Timestamp note'), 'missed punish on shield');
    await user.click(within(dialog).getByRole('button', { name: 'Add timestamp' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    );
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

  it('renders the Tournament column, falling back to eventName then "—"', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', tournamentName: 'The Big House 9', eventName: 'Ultimate Singles' }),
      makeMatch({ id: 'm2', opponent: 'someone-else', eventName: 'Ultimate Singles' }),
      makeMatch({ id: 'm3', opponent: 'third-party' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByText('Match History')).toBeInTheDocument());
    expect(screen.getByText('The Big House 9')).toBeInTheDocument();
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('composes a per-column fighter filter with the global text filter', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent: 'rival' }),
      makeMatch({ id: 'm2', fighter_id: luigi.id, opponent: 'rival' }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getAllByText('rival')).toHaveLength(2));

    await user.click(screen.getByLabelText('Your Fighter'));
    await user.click(await screen.findByRole('option', { name: luigi.name }));

    await waitFor(() => expect(screen.getAllByText('rival')).toHaveLength(1));
  });

  it('shows a "no matches found" row when column filters exclude every row', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: luigi.id,
        matchType: 'quickplay',
      }),
      makeMatch({
        id: 'm2',
        fighter_id: mario.id,
        opponent_id: luigi.id,
        matchType: 'offline-tourney',
      }),
    ]);

    renderMatchData();

    await waitFor(() => expect(screen.getByText('Match History')).toBeInTheDocument());

    // Fighter filter (mario) narrows nothing away; combined with a match
    // type that doesn't exist among mario's rows the set becomes empty.
    await user.click(screen.getByLabelText('Type'));
    await user.click(await screen.findByRole('option', { name: 'quickplay' }));
    await user.click(screen.getByLabelText('Filter matches'));
    await user.type(screen.getByLabelText('Filter matches'), 'nonexistent-search-term');

    expect(await screen.findByText('No matches found.')).toBeInTheDocument();
  });

  it('persists column visibility toggles to localStorage and hides the column', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', notes: 'a note' })]);

    renderMatchData();

    await waitFor(() => expect(screen.getByText('a note')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Notes' }));

    await waitFor(() => expect(screen.queryByText('a note')).not.toBeInTheDocument());

    const stored = JSON.parse(
      window.localStorage.getItem('smash-tracker.matchTableColumns') ?? '{}',
    );
    expect(stored.notes).toBe(false);
  });

  it('exports the currently-filtered rows as a CSV blob download', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent: 'rival' }),
      makeMatch({ id: 'm2', fighter_id: luigi.id, opponent: 'someone-else' }),
    ]);

    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderMatchData();

    await waitFor(() => expect(screen.getAllByText('rival')).toHaveLength(1));

    await user.click(screen.getByLabelText('Your Fighter'));
    await user.click(await screen.findByRole('option', { name: mario.name }));
    await waitFor(() => expect(screen.queryByText('someone-else')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0] as [Blob];
    const text = await blob.text();
    expect(text).toContain('rival');
    expect(text).not.toContain('someone-else');
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
  });
});
