import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { Topbar } from './Topbar';
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

const getMe = vi.fn().mockResolvedValue({
  uid: 'test-uid',
  email: 'test@example.com',
  fighters: { primary: [], secondary: [] },
  coachingModeEnabled: false,
});

const listClients = vi.fn().mockResolvedValue([]);
const listWorkspaces = vi.fn().mockResolvedValue([]);
// Phase 29 (Research Tenancy, Isolation & Governance Gate): backs
// `useResearchSubject`'s query — every existing test in this file that
// navigates inside `/coach/:clientId/*` now also triggers this call, so it
// defaults to the ordinary resolution (matching prior, pre-Phase-29
// behavior) and is overridden per test in the new describe block below.
const getKind = vi.fn().mockResolvedValue({ kind: 'ordinary' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    startgg: {
      status: vi.fn().mockResolvedValue({ linked: false }),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => listClients(...args),
        kind: (...args: unknown[]) => getKind(...args),
      },
    },
    clientWorkspaces: {
      list: (...args: unknown[]) => listWorkspaces(...args),
    },
  },
}));

/**
 * Phase 11 walkthrough fix round 1 (FB-1): the `/coach` hub route has no
 * `clientId` param, so `Topbar`'s `ModeSwitch` must still read `mode:
 * 'coaching'` (not `'personal'`) for its value to reflect the hub — a
 * fresh `/dashboard` route asserts the reverse case for the Personal click.
 * Fix round 2 (D-04/D4): routes include `/coach/:clientId/*` so the client
 * chip's `useActiveSubject()` resolves a real `clientId`, mirroring
 * `useMatches.test.tsx`'s two-route `Wrapper` pattern.
 */
function renderTopbarAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/coach/:clientId/*" element={<Topbar />} />
              {/* Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01):
                  the client-owned workspace family, a sibling of the coach
                  route above. */}
              <Route path="/workspace/:tenantId/*" element={<Topbar />} />
              <Route path="*" element={<Topbar />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Topbar ModeSwitch', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    // These tests exercise the switch's active-VALUE logic (FB-1), not its
    // visibility gating (FB-3, covered in its own describe block below) —
    // coaching mode enabled so the switch stays visible across the
    // hub-to-personal navigation these tests drive.
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('walkthrough fix FB-1: shows Coaching as the active value on the /coach hub (no clientId)', async () => {
    renderTopbarAt('/coach');

    const coachingButtons = await screen.findAllByRole('radio', { name: 'Coaching' });
    for (const button of coachingButtons) {
      expect(button).toHaveAttribute('data-state', 'on');
    }
    const personalButtons = screen.getAllByRole('radio', { name: 'Personal' });
    for (const button of personalButtons) {
      expect(button).toHaveAttribute('data-state', 'off');
    }
  });

  it('walkthrough fix FB-1: clicking Personal from the hub is a real value change (navigates)', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach');

    const personalButtons = await screen.findAllByRole('radio', { name: 'Personal' });
    const personalButton = personalButtons[0];
    if (!personalButton) {
      throw new Error('expected at least one Personal radio button');
    }
    await user.click(personalButton);

    // Radix ToggleGroup only fires onValueChange for an actual value change;
    // clicking Personal from the (now correctly) active Coaching value
    // should flip it to Personal rather than being ignored as a same-value
    // re-click (the FB-1 bug: Personal used to already read active here).
    expect(personalButton).toHaveAttribute('data-state', 'on');
  });

  it('does not show the client chip or accent border on the /coach hub', async () => {
    renderTopbarAt('/coach');

    await screen.findAllByRole('radio', { name: 'Coaching' });
    expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument();
    // No clientId on the hub route, so no client-name badge should render.
    expect(screen.queryAllByText(/tenant-/).length).toBe(0);
  });
});

/** Phase 11 walkthrough fix round 1 (FB-3): the switch is opt-in via Profile. */
describe('Topbar ModeSwitch visibility (walkthrough fix FB-3)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('hides the mode switch on a personal route when coaching mode is disabled', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    renderTopbarAt('/dashboard');

    await screen.findByText('grandfinals.gg');
    expect(screen.queryAllByRole('radio', { name: 'Coaching' })).toHaveLength(0);
    expect(screen.queryAllByRole('radio', { name: 'Personal' })).toHaveLength(0);
  });

  it('shows the mode switch on a personal route once coaching mode is enabled', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    renderTopbarAt('/dashboard');

    expect((await screen.findAllByRole('radio', { name: 'Coaching' })).length).toBeGreaterThan(0);
  });

  it('still shows the mode switch under /coach even when coaching mode is disabled (deep-link)', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    renderTopbarAt('/coach');

    expect((await screen.findAllByRole('radio', { name: 'Coaching' })).length).toBeGreaterThan(0);
  });
});

/**
 * Fix round 2 (D-04/D4): the client chip is a client-switcher dropdown, not
 * a bare badge — "Switch client" label, every client (active one checked),
 * a separator, then "All clients" (→ /coach) and "Exit coaching"
 * (→ /dashboard).
 */
describe('Topbar client chip dropdown (walkthrough fix round 2, D-04/D4)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    listClients.mockResolvedValue([
      { clientId: 'tetra', label: 'Tetra', draftCount: 0 },
      { clientId: 'other-client', label: 'Other Client', draftCount: 0 },
    ]);
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('opens to a "Switch client" menu with both clients, "All clients", and "Exit coaching"', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach/tetra/overview');

    const chip = await screen.findByRole('button', { name: /Managing Tetra/ });
    await user.click(chip);

    expect(await screen.findByText('Switch client')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Tetra/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Other Client' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'All clients' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Exit coaching' })).toBeInTheDocument();
  });

  it("selecting the other client navigates to that client's overview", async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach/tetra/overview');

    const chip = await screen.findByRole('button', { name: /Managing Tetra/ });
    await user.click(chip);
    await user.click(screen.getByRole('menuitem', { name: 'Other Client' }));

    const chipAfter = await screen.findByRole('button', { name: /Managing Other Client/ });
    expect(chipAfter).toBeInTheDocument();
  });

  it('"All clients" navigates to /coach (the hub sidebar renders)', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach/tetra/overview');

    const chip = await screen.findByRole('button', { name: /Managing Tetra/ });
    await user.click(chip);
    await user.click(screen.getByRole('menuitem', { name: 'All clients' }));

    // Once on the hub (no clientId), the chip no longer renders.
    await screen.findAllByRole('radio', { name: 'Coaching' });
    expect(screen.queryByRole('button', { name: /Managing/ })).not.toBeInTheDocument();
  });

  it('"Exit coaching" navigates to /dashboard (chip and coaching accent border disappear)', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach/tetra/overview');

    const chip = await screen.findByRole('button', { name: /Managing Tetra/ });
    await user.click(chip);
    await user.click(screen.getByRole('menuitem', { name: 'Exit coaching' }));

    await screen.findByText('grandfinals.gg');
    expect(screen.queryByRole('button', { name: /Managing/ })).not.toBeInTheDocument();
  });

  it('does not render a dropdown chip on a personal route', async () => {
    renderTopbarAt('/dashboard');

    await screen.findByText('grandfinals.gg');
    expect(screen.queryByRole('button', { name: /Managing/ })).not.toBeInTheDocument();
  });
});

/**
 * Phase 11 fix round 3 (FB-4): the hub itself (`/coach`, no client selected)
 * gets a neutral "Select client ▾" picker so a coach can jump straight into
 * a client's Overview without scrolling to the table.
 */
describe('Topbar hub client picker (walkthrough fix round 3, FB-4)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    listClients.mockResolvedValue([
      { clientId: 'tetra', label: 'Tetra', draftCount: 0 },
      { clientId: 'other-client', label: 'Other Client', draftCount: 0 },
    ]);
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('shows a neutral "Select client" picker on the hub, listing every client', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach');

    const picker = await screen.findByRole('button', { name: 'Select a client to manage' });
    expect(picker).toHaveTextContent('Select client');
    await user.click(picker);

    expect(await screen.findByText('Select a client')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Tetra' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Other Client' })).toBeInTheDocument();
  });

  it("selecting a client from the hub picker opens that client's Overview", async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach');

    const picker = await screen.findByRole('button', { name: 'Select a client to manage' });
    await user.click(picker);
    await user.click(await screen.findByRole('menuitem', { name: 'Other Client' }));

    // Once inside the workspace, the accent client-switcher chip renders
    // instead of the neutral hub picker.
    expect(
      await screen.findByRole('button', { name: /Managing Other Client/ }),
    ).toBeInTheDocument();
  });

  it('does not render the hub picker on a personal route or inside a client workspace', async () => {
    renderTopbarAt('/dashboard');
    await screen.findByText('grandfinals.gg');
    expect(
      screen.queryByRole('button', { name: 'Select a client to manage' }),
    ).not.toBeInTheDocument();

    renderTopbarAt('/coach/tetra/overview');
    expect(await screen.findByRole('button', { name: /Managing Tetra/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Select a client to manage' }),
    ).not.toBeInTheDocument();
  });

  it('shows a disabled "no clients" item when the coach has none yet', async () => {
    const user = userEvent.setup();
    listClients.mockResolvedValue([]);
    renderTopbarAt('/coach');

    const picker = await screen.findByRole('button', { name: 'Select a client to manage' });
    await user.click(picker);

    expect(await screen.findByText('No clients yet')).toBeInTheDocument();
  });
});

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the
 * owned-workspace chip — an additive branch, mutually exclusive with the
 * coach-side chips above (`mode` stays `'personal'` throughout the
 * client-owned workspace family).
 */
describe('Topbar owned-workspace chip (Phase 24, CTRL-01)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    listWorkspaces.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: null },
    ]);
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders the owned-workspace chip and neither coach chip inside the owned workspace', async () => {
    renderTopbarAt('/workspace/t1/overview');

    expect(
      await screen.findByRole('button', { name: /Workspace: My Workspace/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Managing/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Select a client to manage' }),
    ).not.toBeInTheDocument();
  });

  it('renders the coach client chip exactly as before, and no in-workspace chip, on a coach route', async () => {
    listClients.mockResolvedValue([{ clientId: 'c1', label: 'Client One', draftCount: 0 }]);
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    renderTopbarAt('/coach/c1/overview');

    expect(await screen.findByRole('button', { name: /Managing Client One/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Workspace:/ })).not.toBeInTheDocument();
  });

  it('renders only the in-workspace chip (not the entry chip) inside the owned workspace itself', async () => {
    renderTopbarAt('/workspace/t1/overview');

    expect(
      await screen.findByRole('button', { name: /Workspace: My Workspace/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^My Workspace/ })).not.toBeInTheDocument();
  });
});

/**
 * Quick 260726-r5 (Phase 24 gap 1): the discoverable entry point BACK into an
 * owned workspace, shown from every route OUTSIDE `/workspace/:tenantId/*` —
 * Personal and Coaching alike. Before this fix, a claimed client had no way
 * back into their workspace short of the browser Back button.
 */
describe('Topbar owned-workspace entry chip (Quick 260726-r5, gap 1)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('with 0 owned workspaces: renders no entry on a personal route (no empty affordance)', async () => {
    listWorkspaces.mockResolvedValue([]);
    renderTopbarAt('/dashboard');

    await screen.findByText('grandfinals.gg');
    expect(screen.queryByRole('button', { name: /^My Workspace/ })).not.toBeInTheDocument();
  });

  it('with 1 owned workspace: renders the entry labeled with the workspace label from Personal, and navigates into /workspace/:tenantId/overview', async () => {
    const user = userEvent.setup();
    listWorkspaces.mockResolvedValue([
      { tenantId: 't1', label: "Tetra's Workspace", claimedAt: 1, delegateCoachUid: null },
    ]);
    renderTopbarAt('/dashboard');

    const entry = await screen.findByRole('button', { name: "My Workspace: Tetra's Workspace" });
    expect(entry).toHaveTextContent("Tetra's Workspace");
    await user.click(entry);

    expect(
      await screen.findByRole('button', { name: /Workspace: Tetra's Workspace/ }),
    ).toBeInTheDocument();
  });

  it('renders the entry from Coaching mode too (the hub, no client selected)', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    listWorkspaces.mockResolvedValue([
      { tenantId: 't1', label: "Tetra's Workspace", claimedAt: 1, delegateCoachUid: null },
    ]);
    renderTopbarAt('/coach');

    expect(
      await screen.findByRole('button', { name: "My Workspace: Tetra's Workspace" }),
    ).toBeInTheDocument();
  });

  it('with multiple owned workspaces: renders a "My Workspace" dropdown listing each one, and selecting one navigates', async () => {
    const user = userEvent.setup();
    listWorkspaces.mockResolvedValue([
      { tenantId: 't1', label: 'Alpha Workspace', claimedAt: 1, delegateCoachUid: null },
      { tenantId: 't2', label: 'Beta Workspace', claimedAt: 2, delegateCoachUid: null },
    ]);
    renderTopbarAt('/dashboard');

    const trigger = await screen.findByRole('button', { name: 'My Workspace' });
    expect(trigger).toHaveTextContent('My Workspace');
    await user.click(trigger);

    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Alpha Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Beta Workspace' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Beta Workspace' }));

    expect(
      await screen.findByRole('button', { name: /Workspace: Beta Workspace/ }),
    ).toBeInTheDocument();
  });

  it('does not render the entry chip once already inside the owned workspace', async () => {
    listWorkspaces.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: null },
    ]);
    renderTopbarAt('/workspace/t1/overview');

    await screen.findByRole('button', { name: /Workspace: My Workspace/ });
    expect(screen.queryByRole('button', { name: /^My Workspace/ })).not.toBeInTheDocument();
  });
});

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-02, review
 * finding 29-07 HIGH): the client chip is research-aware — it renders
 * ABOVE `ClientWorkspaceLayout`'s gated outlet (`MainLayout` renders the
 * Topbar before the nested route tree), so a research workspace's name
 * must never appear here with no discriminator.
 */
describe('Topbar client chip research indicator (Phase 29, RTEN-02)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    listClients.mockResolvedValue([{ clientId: 'tetra', label: 'Tetra', draftCount: 0 }]);
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders the research indicator for a research workspace', async () => {
    getKind.mockResolvedValue({ kind: 'research' });
    renderTopbarAt('/coach/tetra/overview');

    await screen.findByRole('button', { name: /Managing Tetra/ });
    expect(await screen.findByTestId('client-chip-research-indicator')).toHaveTextContent(
      'Research',
    );
    expect(screen.queryByTestId('client-chip-unresolved-indicator')).not.toBeInTheDocument();
  });

  it('renders the unresolved indicator on a failed kind lookup, not the research indicator', async () => {
    getKind.mockRejectedValue(new Error('network error'));
    renderTopbarAt('/coach/tetra/overview');

    await screen.findByRole('button', { name: /Managing Tetra/ });
    expect(await screen.findByTestId('client-chip-unresolved-indicator')).toHaveTextContent(
      'Unverified',
    );
    expect(screen.queryByTestId('client-chip-research-indicator')).not.toBeInTheDocument();
  });

  it('renders neither indicator for an ordinary workspace', async () => {
    getKind.mockResolvedValue({ kind: 'ordinary' });
    renderTopbarAt('/coach/tetra/overview');

    await screen.findByRole('button', { name: /Managing Tetra/ });
    await waitFor(() => expect(getKind).toHaveBeenCalled());
    expect(screen.queryByTestId('client-chip-research-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('client-chip-unresolved-indicator')).not.toBeInTheDocument();
  });
});
