import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { RATING_MODEL_VERSION } from '@/lib/glicko';
import { ratingModelNoteStorageKey } from '@/lib/ratingModelNote';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { RatingModelNote } from './RatingModelNote';

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

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
  },
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/dashboard" element={<RatingModelNote />} />
            <Route path="/coach/:clientId/dashboard" element={<RatingModelNote />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RatingModelNote', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('renders the title, body, and an accessible dismiss control when not dismissed', async () => {
    renderAt('/dashboard');

    expect(await screen.findByText('Rating model updated')).toBeInTheDocument();
    expect(
      screen.getByText(/Session ratings now reflect results against a fixed reference opponent/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('renders nothing (an empty container) once already dismissed for this uid+version', async () => {
    window.localStorage.setItem(ratingModelNoteStorageKey('test-uid', RATING_MODEL_VERSION), '1');

    const { container } = renderAt('/dashboard');

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('clicking dismiss hides the note and persists the dismissal under uid+version', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/dashboard');

    await screen.findByText('Rating model updated');
    await user.click(screen.getByRole('button', { name: 'Got it' }));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(
      window.localStorage.getItem(ratingModelNoteStorageKey('test-uid', RATING_MODEL_VERSION)),
    ).toBe('1');
  });

  it('a localStorage read failure defaults to not-dismissed and never throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });

    expect(() => renderAt('/dashboard')).not.toThrow();
    expect(await screen.findByText('Rating model updated')).toBeInTheDocument();

    spy.mockRestore();
  });

  // Phase 36 (T-36-02-02-style non-regression): the component reads only a
  // uid via AuthContext — no subject/clientId prop — so it must render
  // identically under a coach client-subject route as under the personal
  // one.
  it('renders identically under a coach client-subject route (uid-only, no subject prop)', async () => {
    renderAt('/coach/tetra-client/dashboard');

    expect(await screen.findByText('Rating model updated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });
});
