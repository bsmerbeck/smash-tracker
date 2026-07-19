import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
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

const getFavorites = vi.fn();
const updateFavorites = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    stageFavorites: {
      get: (...args: unknown[]) => getFavorites(...args),
      update: (...args: unknown[]) => updateFavorites(...args),
    },
  },
}));

import { AuthProvider } from '@/context/AuthContext';
import { FavoriteStagesCard } from './FavoriteStagesCard';

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FavoriteStagesCard />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('FavoriteStagesCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('shows an empty state when nothing is favorited yet', async () => {
    getFavorites.mockResolvedValue({ stageIds: [], updatedAt: 0 });

    renderCard();

    expect(await screen.findByText('No favorite stages yet.')).toBeInTheDocument();
  });

  it('lists favorites in their saved order', async () => {
    getFavorites.mockResolvedValue({ stageIds: [113, 1], updatedAt: 5 });

    renderCard();

    expect(await screen.findByText('Small Battlefield')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Small Battlefield', 'Battlefield']);
  });

  it('removing a favorite PUTs the list without it', async () => {
    const user = userEvent.setup();
    getFavorites.mockResolvedValue({ stageIds: [113, 1], updatedAt: 5 });
    updateFavorites.mockResolvedValue({ stageIds: [1], updatedAt: 6 });

    renderCard();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Small Battlefield from favorites' }),
    );

    await waitFor(() => expect(updateFavorites).toHaveBeenCalledWith({ stageIds: [1] }));
  });

  it('adding a stage through the combobox PUTs the list with it appended', async () => {
    const user = userEvent.setup();
    getFavorites.mockResolvedValue({ stageIds: [1], updatedAt: 5 });
    updateFavorites.mockResolvedValue({ stageIds: [1, 113], updatedAt: 6 });

    renderCard();

    await user.click(await screen.findByRole('combobox', { name: /Add a favorite stage/ }));
    await user.type(screen.getByPlaceholderText('Search stages...'), 'Small Battlefield');
    await user.click(await screen.findByRole('option', { name: /Small Battlefield/ }));

    await waitFor(() => expect(updateFavorites).toHaveBeenCalledWith({ stageIds: [1, 113] }));
  });

  it('already-favorited stages are not offered in the combobox', async () => {
    const user = userEvent.setup();
    getFavorites.mockResolvedValue({ stageIds: [113], updatedAt: 5 });

    renderCard();

    await user.click(await screen.findByRole('combobox', { name: /Add a favorite stage/ }));
    await user.type(screen.getByPlaceholderText('Search stages...'), 'Small Battlefield');

    expect(screen.queryByRole('option', { name: /Small Battlefield/ })).not.toBeInTheDocument();
  });

  it('shows an error toast when saving fails', async () => {
    const user = userEvent.setup();
    getFavorites.mockResolvedValue({ stageIds: [1], updatedAt: 5 });
    updateFavorites.mockRejectedValue(new Error('nope'));

    renderCard();

    await user.click(
      await screen.findByRole('button', { name: 'Remove Battlefield from favorites' }),
    );

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
