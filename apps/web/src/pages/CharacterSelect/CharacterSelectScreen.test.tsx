import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { CharacterSelectScreen } from './CharacterSelectScreen';
import { useFighters } from '@/hooks/useFighters';
import { useFighterSlotSelection } from '@/hooks/useFighterSlotSelection';
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

const getFighters = vi.fn();
const saveFighters = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      saveFighters: (...args: unknown[]) => saveFighters(...args),
    },
  },
}));

function renderScreen(initialPath = '/choose-primary') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/choose-primary"
              element={
                <CharacterSelectScreen
                  slot="primary"
                  heading="Choose Your Primaries"
                  description="desc"
                  destinations={[
                    { label: 'Save and Choose Secondaries', href: '/choose-secondary' },
                    { label: 'Save and go to Dashboard', href: '/dashboard' },
                  ]}
                />
              }
            />
            <Route path="/choose-secondary" element={<div>Secondary page</div>} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CharacterSelectScreen', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    saveFighters.mockResolvedValue({ primary: [1], secondary: [] });
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('toggles a fighter into the selected list when clicked, and back out when clicked again', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());

    expect(screen.getByText('Selected (0)')).toBeInTheDocument();

    await user.click(screen.getByAltText('Mario'));
    expect(screen.getByText('Selected (1)')).toBeInTheDocument();

    // Clicking the now-selected Mario tile again removes it.
    const selectedMario = screen.getAllByAltText('Mario')[0];
    if (!selectedMario) throw new Error('expected a selected Mario tile');
    await user.click(selectedMario);
    expect(screen.getByText('Selected (0)')).toBeInTheDocument();
  });

  it('filters the available grid by name prefix', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());
    expect(screen.getByAltText('Luigi')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Filter by name...'), 'mar');

    expect(screen.getByAltText('Mario')).toBeInTheDocument();
    expect(screen.queryByAltText('Luigi')).not.toBeInTheDocument();
  });

  it("filters and displays by the active locale's localized fighter name (I18N-02)", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage('fr');
    renderScreen();

    // Jigglypuff (id 13) renders as "Rondoudou" in fr; wait for the
    // localized grid to hydrate before filtering.
    await waitFor(() => expect(screen.getByAltText('Rondoudou')).toBeInTheDocument());

    await user.type(screen.getByRole('textbox'), 'rond');

    expect(screen.getByAltText('Rondoudou')).toBeInTheDocument();
    expect(screen.queryByAltText('Mario')).not.toBeInTheDocument();
  });

  it('saves the primary selection as a number[] under the "primary" key and navigates', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());
    await user.click(screen.getByAltText('Mario'));
    await user.click(screen.getByAltText('Luigi'));

    await user.click(screen.getByRole('button', { name: 'Save and go to Dashboard' }));

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1, 10], secondary: [] });

    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
  });

  it('preserves the existing secondary selection when saving primaries', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [], secondary: [7, 8] });
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());
    await user.click(screen.getByAltText('Mario'));
    await user.click(screen.getByRole('button', { name: 'Save and go to Dashboard' }));

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1], secondary: [7, 8] });
  });

  it('excludes fighters already claimed by the other slot from the available grid', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [1] }); // Mario claimed by secondary
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Luigi')).toBeInTheDocument());
    expect(screen.queryByAltText('Mario')).not.toBeInTheDocument();
  });

  it('disables save buttons until at least one fighter is selected', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save and go to Dashboard' })).toBeDisabled();
  });

  // 260725-Q1: the available grid used to render in in-game roster/fighter-
  // number order (SpriteList's raw order); it must now be alphabetized by
  // localized display name in every locale.
  it('renders the available grid alphabetically sorted by localized name (en)', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByAltText('Mario')).toBeInTheDocument());

    const grid = screen.getByTestId('available-sprite-grid');
    const names = within(grid)
      .getAllByRole('img')
      .map((img) => img.getAttribute('alt') ?? '');

    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('renders the available grid alphabetically sorted by the fr localized name (I18N-02)', async () => {
    await i18n.changeLanguage('fr');
    renderScreen();
    // Jigglypuff (id 13) renders as "Rondoudou" in fr — wait for the
    // localized grid to hydrate before asserting order.
    await waitFor(() => expect(screen.getByAltText('Rondoudou')).toBeInTheDocument());

    const grid = screen.getByTestId('available-sprite-grid');
    const names = within(grid)
      .getAllByRole('img')
      .map((img) => img.getAttribute('alt') ?? '');

    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'fr')));
  });

  // 260726-r4 (P0 data-loss fix): a save may only send a slot value the
  // client has actually observed from the server. While `fighters` is
  // unresolved, the standalone screen shows its loading state — there is no
  // Save button a click could ever fire against.
  it('blocks saving while the fighters query is unresolved (no Save button rendered)', async () => {
    getFighters.mockReturnValue(new Promise(() => {})); // never resolves
    renderScreen();

    expect(await screen.findByText('Loading your fighters...')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save and go to Dashboard' }),
    ).not.toBeInTheDocument();
    expect(saveFighters).not.toHaveBeenCalled();
  });
});

/**
 * Combined-page harness — mirrors what `ClientFightersPage`/
 * `OwnerFightersPage` actually do (lift both slots' state to the page,
 * render two `CharacterSelectScreen`s wired via `combined`) without
 * pulling in the full page components' unrelated chrome (labels, routing
 * params, etc).
 */
function CombinedHarness({ onSaved }: { onSaved: () => void }) {
  const { data: fighters } = useFighters();
  const [primaryIds, setPrimaryIds] = useFighterSlotSelection(fighters, 'primary');
  const [secondaryIds, setSecondaryIds] = useFighterSlotSelection(fighters, 'secondary');
  return (
    <>
      <CharacterSelectScreen
        slot="primary"
        heading="Primary"
        description="desc"
        destinations={[{ label: 'Save', href: '/dashboard' }]}
        combined={{
          selectedIds: primaryIds,
          onSelectedIdsChange: setPrimaryIds,
          otherSlotIds: secondaryIds,
          onSaved,
        }}
      />
      <CharacterSelectScreen
        slot="secondary"
        heading="Secondary"
        description="desc"
        destinations={[{ label: 'Save', href: '/dashboard' }]}
        combined={{
          selectedIds: secondaryIds,
          onSelectedIdsChange: setSecondaryIds,
          otherSlotIds: primaryIds,
          onSaved,
        }}
      />
    </>
  );
}

function renderCombined(onSaved: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/combined']}>
        <AuthProvider>
          <Routes>
            <Route path="/combined" element={<CombinedHarness onSaved={onSaved} />} />
            <Route path="/dashboard" element={<div>Dashboard page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CharacterSelectScreen (combined mode, 260726-r4)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    saveFighters.mockResolvedValue({ primary: [1], secondary: [] });
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('a successful save does NOT navigate away and calls onSaved instead', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderCombined(onSaved);

    await waitFor(() => expect(screen.getAllByAltText('Mario')).toHaveLength(2));
    const [primaryMario] = screen.getAllByAltText('Mario');
    if (!primaryMario) throw new Error('expected a primary Mario tile');
    await user.click(primaryMario);

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    const primarySave = saveButtons[0];
    if (!primarySave) throw new Error('expected a primary Save button');
    await user.click(primarySave);

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Dashboard page')).not.toBeInTheDocument();
  });

  it('preserves an already-selected primary when saving the secondary panel (the exact reported bug)', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [1, 10], secondary: [] });
    const onSaved = vi.fn();
    renderCombined(onSaved);

    await waitFor(() => expect(screen.getAllByAltText('Peach')).toHaveLength(2));
    const [, secondaryPeach] = screen.getAllByAltText('Peach');
    if (!secondaryPeach) throw new Error('expected a secondary Peach tile');
    await user.click(secondaryPeach);

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    const secondarySave = saveButtons[1];
    if (!secondarySave) throw new Error('expected a secondary Save button');
    await user.click(secondarySave);

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1, 10], secondary: [14] });
  });
});
