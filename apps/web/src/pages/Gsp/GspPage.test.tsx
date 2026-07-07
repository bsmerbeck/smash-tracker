import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GSP_MODEL } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { GspPage } from './GspPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { computedEliteThreshold } from './lib/gspMmrModel';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

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

/**
 * Matcher for the computed Elite threshold: the value drifts with wall-clock
 * time (t advances ~0.98/hour, ~88 GSP/hour on the threshold), so instead of
 * an exact string we accept any localized number within a small tolerance of
 * the value computed at assertion time.
 */
function nearNumberMatcher(expected: number, tolerance = 500) {
  return (content: string) => {
    const n = Number(content.replace(/,/g, ''));
    return Number.isFinite(n) && Math.abs(n - expected) <= tolerance;
  };
}

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
    // Elite threshold is now COMPUTED from the model (settings updatedAt 0 =
    // never saved, so no calibration) rather than showing the stored value.
    expect(
      screen.getByText(nearNumberMatcher(computedEliteThreshold(Date.now()))),
    ).toBeInTheDocument();
    expect(screen.queryByText('10,000,000')).not.toBeInTheDocument();
  });

  it('shows the estimated MMR and reframes distance to Elite on the MMR scale', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // Fixture times are epoch-ms ~0 (t floors to the model minimum), which
    // makes the conversion deterministic: gsp 9,050,000 -> MMR 1,000.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_050_000 })]);

    renderGspPage();

    expect(await screen.findByText('Est. MMR')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    // Distance card: 1142 - 1000 = 142, with the MMR framing caption.
    expect(screen.getByText('142')).toBeInTheDocument();
    expect(screen.getByText(/MMR 1,000 · below Elite \(1142\)/)).toBeInTheDocument();
    // The honest-labeling caption links the community doc.
    expect(
      screen.getByRole('link', { name: 'community-reverse-engineered model' }),
    ).toBeInTheDocument();
  });

  it('flags tail readings as approximate on the Est. MMR card', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // 16,500,000 is beyond gsp(MMR 1400) at the floored t -> top tail.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 16_500_000 })]);

    renderGspPage();

    expect(await screen.findByText(/top-tail reading — approximate/)).toBeInTheDocument();
  });

  it('shows the ELITE badge once the estimated MMR reaches Elite (1142)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // gsp 15,000,000 at the floored t -> MMR ~1158 >= 1142.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 15_000_000 })]);

    renderGspPage();

    expect(await screen.findByText('ELITE')).toBeInTheDocument();
    expect(screen.getByText(/already in Elite Smash/)).toBeInTheDocument();
  });

  it('recalibrates the model when the Elite threshold is edited (stored via the settings API)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 })]);
    const user = userEvent.setup();

    renderGspPage();
    await screen.findByText('Elite Threshold');
    expect(screen.getByText(/editing recalibrates the model/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Elite threshold' }));
    const input = screen.getByLabelText('Elite Smash threshold');
    await user.clear(input);
    await user.type(input, '14,800,000');
    await user.click(screen.getByRole('button', { name: 'Save threshold' }));

    await waitFor(() =>
      expect(updateGspSettings).toHaveBeenCalledWith({ eliteThreshold: 14_800_000 }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/recalibrated/i));
  });

  it('displays a saved threshold as a calibration: computed value + recalibrated date', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 })]);
    const savedAt = GSP_MODEL.T_ANCHOR.atMs;
    getGspSettings.mockResolvedValue({ eliteThreshold: 14_720_247, updatedAt: savedAt });

    renderGspPage();

    await screen.findByText('Elite Threshold');
    // The card shows the value computed from the calibration at NOW — which
    // has drifted upward from the saved reading — not the raw saved value.
    const expected = computedEliteThreshold(Date.now(), {
      eliteThresholdGsp: 14_720_247,
      atMs: savedAt,
    });
    expect(expected).toBeGreaterThan(14_720_247);
    expect(screen.getByText(nearNumberMatcher(expected))).toBeInTheDocument();
    expect(screen.getByText(/recalibrated/)).toBeInTheDocument();
  });

  it('logs a match through the Quick Logger and shows the GSP + MMR delta toast', async () => {
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
    // The toast carries both deltas: raw GSP and the estimated MMR change
    // (both readings land on the main curve, so the conversion is "clean").
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('+500,000 GSP'));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/≈ \+\d+ MMR/));
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

  it('toggles the curve between GSP and MMR views', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 }),
      makeMatch({ id: 'm2', time: 2, win: true, gsp: 9_100_000 }),
    ]);
    const user = userEvent.setup();

    renderGspPage();
    await screen.findByText('GSP Curve');

    // Default GSP view explains the computed threshold line.
    expect(screen.getByText(/logged post-match GSP reading/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'MMR view' }));
    expect(screen.getByText(/doesn't inflate over time/)).toBeInTheDocument();
    expect(screen.queryByText(/logged post-match GSP reading/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'GSP view' }));
    expect(screen.getByText(/logged post-match GSP reading/)).toBeInTheDocument();
  });

  describe('Road to Elite states', () => {
    it('projects net wins on the MMR scale at a >50% win rate', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 }),
        makeMatch({ id: 'm2', time: 2, win: true, gsp: 9_100_000 }),
        makeMatch({ id: 'm3', time: 3, win: false, gsp: 9_050_000 }),
      ]);

      renderGspPage();

      expect(await screen.findByText(/~\d+ more match/)).toBeInTheDocument();
      expect(screen.getByText(/MMR\/match/)).toBeInTheDocument();
      expect(screen.getByText(/to Elite \(MMR 1142\)/)).toBeInTheDocument();
    });

    it('presents equilibrium kindly at a <=50% win rate', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 }),
        makeMatch({ id: 'm2', time: 2, win: false, gsp: 8_900_000 }),
      ]);

      renderGspPage();

      expect(await screen.findByText('Holding steady at your level')).toBeInTheDocument();
      expect(
        screen.getByText(/matchmaking thinks this is your level right now/),
      ).toBeInTheDocument();
      expect(screen.getByText(/>50% win rate is what moves you up/)).toBeInTheDocument();
    });

    it('keeps the V10 own-history estimate as a secondary line when it can compute', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      // A longer winning series: enough win-steps for the V10 projection's
      // linear fallback (>= 2 win-steps) and a >50% win rate for the primary.
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, gsp: 9_000_000 }),
        makeMatch({ id: 'm2', time: 2, win: true, gsp: 9_100_000 }),
        makeMatch({ id: 'm3', time: 3, win: true, gsp: 9_200_000 }),
        makeMatch({ id: 'm4', time: 4, win: true, gsp: 9_300_000 }),
      ]);

      renderGspPage();

      // Both the primary MMR projection and the secondary own-history line
      // contain "~N more matches", hence findAll.
      const projections = await screen.findAllByText(/~\d+ more match/);
      expect(projections.length).toBe(2);
      expect(screen.getByText(/From your own GSP history instead/)).toBeInTheDocument();
    });
  });
});
