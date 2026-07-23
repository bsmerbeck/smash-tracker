import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { CharacterSelectScreen } from './CharacterSelectScreen';
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
});
