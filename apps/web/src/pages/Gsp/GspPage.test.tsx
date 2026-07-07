import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { GspPage } from './GspPage';
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
const createMatch = vi.fn();
const getGspSettings = vi.fn();
const updateGspSettings = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      create: (...args: unknown[]) => createMatch(...args),
    },
    gspSettings: {
      get: (...args: unknown[]) => getGspSettings(...args),
      update: (...args: unknown[]) => updateGspSettings(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(
  overrides: Partial<Record<string, unknown>> & { id: string; time: number; win: boolean },
) {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  };
}

function renderGspPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/gsp']}>
        <AuthProvider>
          <Routes>
            <Route path="/gsp" element={<GspPage />} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GspPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);
    getGspSettings.mockResolvedValue({ eliteThreshold: 10_000_000, updatedAt: 0 });
    updateGspSettings.mockResolvedValue({ eliteThreshold: 11_000_000, updatedAt: Date.now() });
    createMatch.mockResolvedValue({
      id: 'new-match',
      fighter_id: mario.id,
      opponent_id: luigi.id,
      time: Date.now(),
      map: { id: 0, name: 'no selection' },
      opponent: '',
      notes: '',
      matchType: 'quickplay',
      win: true,
      gsp: 9_500_000,
    });
  });

  it('shows an explanatory empty state with no gsp-bearing matches and no fighter selections', async () => {
    renderGspPage();

    expect(await screen.findByText('Track your GSP climb')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log a match on the Dashboard' })).toBeInTheDocument();
  });

  it('offers primary/secondary fighters as suggestions even with no gsp matches yet', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });

    renderGspPage();

    expect(await screen.findByRole('heading', { name: 'GSP Tracker' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Select fighter' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Select fighter' })).getByText(mario.name),
    ).toBeInTheDocument();
  });

  it('renders the hero row and curve once GSP matches exist', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 }),
      makeMatch({ id: 'm2', time: 2, win: true, gsp: 9_100_000 }),
      makeMatch({ id: 'm3', time: 3, win: false, gsp: 9_050_000 }),
    ]);

    renderGspPage();

    expect(await screen.findByText('9,050,000')).toBeInTheDocument(); // current GSP
    expect(screen.getByText('GSP Curve')).toBeInTheDocument();
    expect(screen.getByText('10,000,000')).toBeInTheDocument(); // elite threshold
  });

  it('shows the ELITE badge once current GSP reaches the threshold', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    getGspSettings.mockResolvedValue({ eliteThreshold: 9_000_000, updatedAt: 0 });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_500_000 })]);

    renderGspPage();

    expect(await screen.findByText('ELITE')).toBeInTheDocument();
    expect(screen.getByText(/already in Elite Smash/)).toBeInTheDocument();
  });

  it('logs a match through the Quick Logger and shows the delta toast', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 })]);
    const user = userEvent.setup();

    renderGspPage();

    await screen.findByText('Quick Logger');

    await user.click(screen.getByRole('combobox', { name: 'Opponent Character' }));
    await user.click(await screen.findByRole('option', { name: luigi.name }));

    await user.click(screen.getByRole('radio', { name: 'Win' }));

    const gspInput = screen.getByLabelText('GSP After Match');
    await user.clear(gspInput);
    await user.type(gspInput, '9500000');

    await user.click(screen.getByRole('button', { name: 'Log Match' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        fighter_id: mario.id,
        opponent_id: luigi.id,
        matchType: 'quickplay',
        win: true,
        gsp: 9_500_000,
      }),
    );
  });

  it('requires an opponent character and result before submitting from the Quick Logger', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 })]);
    const user = userEvent.setup();

    renderGspPage();
    await screen.findByText('Quick Logger');

    await user.click(screen.getByRole('button', { name: 'Log Match' }));

    expect(createMatch).not.toHaveBeenCalled();
  });

  it('persists the opponent character after logging so rematches only need result + GSP', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 })]);
    const user = userEvent.setup();

    renderGspPage();
    await screen.findByText('Quick Logger');

    // First match: full entry.
    await user.click(screen.getByRole('combobox', { name: 'Opponent Character' }));
    await user.click(await screen.findByRole('option', { name: luigi.name }));
    await user.click(screen.getByRole('radio', { name: 'Win' }));
    const gspInput = screen.getByLabelText('GSP After Match');
    await user.clear(gspInput);
    await user.type(gspInput, '9500000');
    await user.click(screen.getByRole('button', { name: 'Log Match' }));
    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));

    // Rematch: same opponent stays selected — only result + GSP needed.
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    const gspInput2 = screen.getByLabelText('GSP After Match');
    await user.clear(gspInput2);
    await user.type(gspInput2, '9300000');
    await user.click(screen.getByRole('button', { name: 'Log Match' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(2));
    expect(createMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        opponent_id: luigi.id,
        win: false,
        gsp: 9_300_000,
      }),
    );
  });
});
