import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ScoutPage } from './ScoutPage';
import { ApiError } from '@/lib/api';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const toastSuccess = vi.fn();
const toastPlain = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastPlain(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
  }),
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

const scoutLookup = vi.fn();
const matchesList = vi.fn().mockResolvedValue([]);
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const reportsConfig = vi.fn().mockResolvedValue({ enabled: false });
const reportsGenerate = vi.fn();
const reportsList = vi.fn().mockResolvedValue([]);
const billingCredits = vi.fn().mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
const billingCheckout = vi.fn();

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    api: {
      scout: { lookup: (...args: unknown[]) => scoutLookup(...args) },
      matches: { list: (...args: unknown[]) => matchesList(...args) },
      users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
      reports: {
        config: (...args: unknown[]) => reportsConfig(...args),
        generate: (...args: unknown[]) => reportsGenerate(...args),
        list: (...args: unknown[]) => reportsList(...args),
      },
      billing: {
        credits: (...args: unknown[]) => billingCredits(...args),
        checkout: (...args: unknown[]) => billingCheckout(...args),
      },
    },
    ApiError: MockApiError,
  };
});

function renderPage(initialEntry = '/scout') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/scout" element={<ScoutPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const REPORT = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  sampledSets: 3,
  sampledGames: 6,
  characters: [{ fighterId: 67, games: 6, wins: 4 }],
  stages: [{ stageId: 1, games: 6, wins: 4 }],
  recentEvents: [
    {
      eventName: 'Ultimate Singles',
      tournamentName: 'Genesis 9',
      placement: 33,
      numEntrants: 1024,
      lastSetAt: 1_700_000_000_000,
    },
  ],
  commonOpponents: [{ gamerTag: 'PowPow', sets: 2 }],
};

describe('ScoutPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: false });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
    setMockUser(makeMockUser());
  });

  it('shows the empty prompt before a search is submitted', () => {
    renderPage();
    expect(
      screen.getByText(/Paste a start\.gg profile URL, slug, or player id above/),
    ).toBeInTheDocument();
  });

  it('submits the query and renders the report', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();

    await user.type(
      screen.getByLabelText(/start\.gg profile URL, slug, or player id/),
      'https://start.gg/user/07dc2239',
    );
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await waitFor(() =>
      expect(scoutLookup).toHaveBeenCalledWith({
        query: 'https://start.gg/user/07dc2239',
        source: 'startgg',
      }),
    );
    expect(await screen.findByText('Pandem1c')).toBeInTheDocument();
    expect(screen.getByText(/Public start\.gg data · sampled last 3 sets/)).toBeInTheDocument();
    expect(screen.getByText('PowPow')).toBeInTheDocument();
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
  });

  it('shows a friendly message on a 404', async () => {
    const user = userEvent.setup();
    scoutLookup.mockRejectedValue(new ApiError(404, 'No start.gg player found for that query'));

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/doesnotexist');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText(/We couldn't find a start\.gg player/)).toBeInTheDocument();
  });

  it('shows a friendly message on a 429', async () => {
    const user = userEvent.setup();
    scoutLookup.mockRejectedValue(new ApiError(429, 'rate limited'));

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText(/rate-limiting requests/)).toBeInTheDocument();
  });

  it('shows the "Your History vs Them" strip when the scouted tag matches an existing opponent', async () => {
    const user = userEvent.setup();
    matchesList.mockResolvedValue([
      {
        id: 'm1',
        fighter_id: 1,
        opponent_id: 2,
        time: 1_700_000_000_000,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'pandem1c',
        notes: '',
        matchType: 'quickplay',
        win: true,
      },
      {
        id: 'm2',
        fighter_id: 1,
        opponent_id: 2,
        time: 1_700_100_000_000,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'pandem1c',
        notes: '',
        matchType: 'quickplay',
        win: false,
      },
    ]);
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText('Your History vs Them')).toBeInTheDocument();
    expect(screen.getByText('1-1', { exact: false })).toBeInTheDocument();
  });

  it('does not show the history strip when the scouted tag has no match history', async () => {
    const user = userEvent.setup();
    matchesList.mockResolvedValue([]);
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await screen.findByText('Pandem1c');
    expect(screen.queryByText('Your History vs Them')).not.toBeInTheDocument();
  });
});

const GENERATED_RECORD = {
  id: 'report-1',
  createdAt: 1_700_000_000_000,
  model: 'claude-opus-4-8',
  // Same start.gg player id as REPORT.player.id — this is "the currently
  // scouted player's" own stored report.
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  report: {
    overview: 'A fast-falling Fox/Falco player.',
    gameplan: ['Punish landing lag.'],
    characterStrategy: {
      picks: ['Mario'],
      reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
    },
    stageStrategy: {
      bans: ['Final Destination'],
      picks: ['Battlefield'],
      reasoning: 'Flat stages favor us.',
    },
    headToHead: null,
    watchFor: ['Shine spikes off stage.'],
    confidenceNotes: 'Only 6 games sampled.',
  },
};

const OTHER_PLAYER_RECORD = {
  id: 'report-2',
  createdAt: 1_700_100_000_000,
  model: 'claude-opus-4-8',
  // A different start.gg player id — a report for someone OTHER than the
  // currently scouted player.
  player: { id: 999, gamerTag: 'PowPow', userSlug: 'user/other' },
  report: {
    overview: 'An aggressive rushdown player.',
    gameplan: ['Play patient neutral.'],
    characterStrategy: {
      picks: ['Fox'],
      reasoning: 'Game 1: Fox.',
    },
    stageStrategy: {
      bans: ['Pokemon Stadium 2'],
      picks: ['Smashville'],
      reasoning: 'They struggle with moving platforms.',
    },
    headToHead: null,
    watchFor: ['Aggressive edgeguards.'],
    confidenceNotes: 'Only 4 games sampled.',
  },
};

describe('ScoutPage — AI reports feature disabled', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: false });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
    setMockUser(makeMockUser());
  });

  it('never shows the "Generate AI report" button when disabled', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await screen.findByText('Pandem1c');
    expect(screen.queryByRole('button', { name: /Generate AI report/ })).not.toBeInTheDocument();
  });

  it('never shows the past reports card when disabled, even if reports exist', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([GENERATED_RECORD]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await screen.findByText('Pandem1c');
    expect(screen.queryByText('Past AI Reports')).not.toBeInTheDocument();
  });
});

describe('ScoutPage — AI reports feature enabled', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
    setMockUser(makeMockUser());
  });

  it('shows the "Generate AI report" button once a scout result is on screen', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByRole('button', { name: /Generate AI report/ })).toBeInTheDocument();
  });

  it('generates and renders the AI report on click', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsGenerate.mockResolvedValue(GENERATED_RECORD);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: /Generate AI report/ }));

    await waitFor(() =>
      expect(reportsGenerate).toHaveBeenCalledWith({ query: 'user/07dc2239', source: 'startgg' }),
    );
    expect(await screen.findByText('AI Scouting Report')).toBeInTheDocument();
    expect(screen.getAllByText(GENERATED_RECORD.report.overview).length).toBeGreaterThan(0);
  });

  it('shows a pending state with spinner text while generating', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    let resolveGenerate: (value: typeof GENERATED_RECORD) => void = () => {};
    reportsGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGenerate = resolve;
        }),
    );

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: /Generate AI report/ }));

    expect(
      await screen.findByText(/Generating report — this usually takes a minute or two\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generating report/ })).toBeDisabled();

    resolveGenerate(GENERATED_RECORD);
    await waitFor(() => expect(screen.getByText('AI Scouting Report')).toBeInTheDocument());
  });

  it('shows an inline destructive alert with the API message on error', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsGenerate.mockRejectedValue(
      new ApiError(502, 'The model declined to generate a report for this request'),
    );

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: /Generate AI report/ }));

    expect(
      await screen.findByText('The model declined to generate a report for this request'),
    ).toBeInTheDocument();
  });

  it('shows the past reports card for OTHER players, and selecting one renders it', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([OTHER_PLAYER_RECORD]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByRole('heading', { name: 'Pandem1c' });

    expect(await screen.findByText('Past AI Reports')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /PowPow/ }));

    expect(await screen.findByText('AI Scouting Report')).toBeInTheDocument();
    expect(screen.getAllByText(OTHER_PLAYER_RECORD.report.overview).length).toBeGreaterThan(0);
  });

  it('does not show the past reports card when the list is empty', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    expect(screen.queryByText('Past AI Reports')).not.toBeInTheDocument();
  });
});

describe('ScoutPage — V7-B.1 persistence across refresh / re-scout', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
    setMockUser(makeMockUser());
  });

  it('automatically renders the stored report for a player with an existing report, no click needed', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([GENERATED_RECORD]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByRole('heading', { name: 'Pandem1c' });

    expect(await screen.findByText('AI Scouting Report')).toBeInTheDocument();
    expect(screen.getAllByText(GENERATED_RECORD.report.overview).length).toBeGreaterThan(0);
    expect(reportsGenerate).not.toHaveBeenCalled();
  });

  it('shows a plain "Generate AI report" button for a player without a stored report', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByRole('heading', { name: 'Pandem1c' });

    expect(screen.queryByText('AI Scouting Report')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate AI report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate report' })).not.toBeInTheDocument();
  });

  it('shows "Regenerate report" (not "Generate AI report") once a stored report is displayed', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([GENERATED_RECORD]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('AI Scouting Report');

    expect(screen.getByRole('button', { name: 'Regenerate report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate AI report' })).not.toBeInTheDocument();
  });

  it('a fresh generation replaces the auto-displayed stored report', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([GENERATED_RECORD]);
    const freshRecord = {
      ...GENERATED_RECORD,
      id: 'report-fresh',
      report: { ...GENERATED_RECORD.report, overview: 'A freshly regenerated read.' },
    };
    reportsGenerate.mockResolvedValue(freshRecord);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await waitFor(() =>
      expect(screen.getAllByText(GENERATED_RECORD.report.overview).length).toBeGreaterThan(0),
    );

    await user.click(screen.getByRole('button', { name: 'Regenerate report' }));

    await waitFor(() =>
      expect(screen.getAllByText('A freshly regenerated read.').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(GENERATED_RECORD.report.overview)).not.toBeInTheDocument();
  });

  it('excludes the currently scouted player from the past-reports card (already shown above)', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsList.mockResolvedValue([GENERATED_RECORD, OTHER_PLAYER_RECORD]);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('AI Scouting Report');

    expect(await screen.findByText('Past AI Reports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PowPow/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pandem1c/ })).not.toBeInTheDocument();
  });
});

describe('ScoutPage — V7-C billing (free access)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: true, freeAccess: true, billingEnabled: true });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: true, balance: 0, packs: [] });
    setMockUser(makeMockUser());
  });

  it('shows "Free access" and no "Buy credits" affordance for an allowlisted uid', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    expect(screen.getByText('Free access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy credits' })).not.toBeInTheDocument();
  });
});

describe('ScoutPage — V7-C billing (paid, non-allowlisted)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: true, freeAccess: false, billingEnabled: true });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({
      freeAccess: false,
      balance: 3,
      packs: [
        { id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' },
        { id: 'pack15', credits: 15, amountCents: 2000, label: '15 reports' },
      ],
    });
    setMockUser(makeMockUser());
  });

  it('shows the credit balance and a "Buy credits" affordance', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    expect(await screen.findByText('3 credits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy credits' })).toBeInTheDocument();
  });

  it('clicking "Buy credits" opens the BuyCreditsDialog', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: 'Buy credits' }));

    expect(await screen.findByText('Buy report credits')).toBeInTheDocument();
  });

  it('a 402 from generation opens the BuyCreditsDialog automatically', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsGenerate.mockRejectedValue(
      new ApiError(402, 'You need report credits — buy a pack to continue'),
    );

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: 'Generate AI report' }));

    expect(await screen.findByText('Buy report credits')).toBeInTheDocument();
    // The generic destructive error alert is suppressed for a 402 — the
    // dialog itself is the feedback.
    expect(
      screen.queryByText('You need report credits — buy a pack to continue'),
    ).not.toBeInTheDocument();
  });

  it('explains the packs next to the button', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    expect(
      await screen.findByText(
        /Each report costs 1 credit\. 5 reports for \$8\.00 · 15 reports for \$20\.00\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows the buy affordance from the live credits query even when reportsConfig.billingEnabled is stale-false', async () => {
    // Regression: the buy UI used to gate on reportsConfig.billingEnabled,
    // which caches long and lagged Stripe being enabled server-side — leaving
    // a charged user (402) with no way to buy. It now keys off the credits
    // query, so a stale/absent billingEnabled must NOT hide the buy path.
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);
    reportsConfig.mockResolvedValue({ enabled: true, freeAccess: false, billingEnabled: false });

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));
    await screen.findByText('Pandem1c');

    expect(await screen.findByText('3 credits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy credits' })).toBeInTheDocument();
  });
});

describe('ScoutPage — V7-C Stripe Checkout return trip', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: true, freeAccess: false, billingEnabled: true });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({
      freeAccess: false,
      balance: 5,
      packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
    });
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a success toast and re-polls credits on ?billing=success, then strips the param', async () => {
    renderPage('/scout?billing=success');

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/credits/i)),
    );
    await waitFor(() => expect(billingCredits).toHaveBeenCalled());
  });

  it('shows a neutral toast on ?billing=cancelled', async () => {
    renderPage('/scout?billing=cancelled');

    await waitFor(() =>
      expect(toastPlain).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i)),
    );
  });

  it('does not show any billing toast without a billing query param', () => {
    renderPage('/scout');

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastPlain).not.toHaveBeenCalled();
  });
});
