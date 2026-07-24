import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HomeworkItem, Match } from '@smash-tracker/shared';
import type { SessionResponse } from '@/lib/api';
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

const sessionsGet = vi.fn();
const sessionsUpdate = vi.fn();
const sessionsToggleHomework = vi.fn();
const deliveriesCreate = vi.fn();
const matchesList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    coaching: {
      sessions: {
        get: (...args: unknown[]) => sessionsGet(...args),
        update: (...args: unknown[]) => sessionsUpdate(...args),
        toggleHomework: (...args: unknown[]) => sessionsToggleHomework(...args),
        deliveries: {
          create: (...args: unknown[]) => deliveriesCreate(...args),
        },
      },
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '@/context/AuthContext';
import { SessionComposerPage } from './SessionComposerPage';

function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    sessionId: 's1',
    date: 1_700_000_000_000,
    characterTags: [8],
    summary: 'Worked on neutral game.',
    homework: [{ id: 'h1', text: 'Practice ledgetraps', done: false }],
    linkedMatchIds: null,
    coachPrivateNotes: 'They tilt when down a stock.',
    createdAt: 1_700_000_000_000,
    lastEditedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeHomework(count: number): HomeworkItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `h${index}`,
    text: `Item ${index}`,
    done: false,
  }));
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    opponent: 'Zain',
    time: 1_700_000_000_000,
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  } as Match;
}

function renderComposer(initialPath = '/coach/tetra/sessions/s1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId/sessions/:sessionId" element={<SessionComposerPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SessionComposerPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    sessionsGet.mockResolvedValue(makeSession());
    sessionsUpdate.mockImplementation((_clientId, _sessionId, patch) =>
      Promise.resolve({ ...makeSession(), ...patch }),
    );
    sessionsToggleHomework.mockImplementation((_clientId, _sessionId, itemId, done) =>
      Promise.resolve({
        ...makeSession(),
        homework: [{ id: itemId, text: 'Practice ledgetraps', done }],
      }),
    );
    matchesList.mockResolvedValue([makeMatch()]);
  });

  it('renders the existing session fields — date, tags, summary, homework, and private notes', async () => {
    renderComposer();

    expect(await screen.findByDisplayValue('2023-11-14')).toBeInTheDocument();
    expect(screen.getByText('Fox')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Worked on neutral game.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Practice ledgetraps')).toBeInTheDocument();
    expect(screen.getByDisplayValue('They tilt when down a stock.')).toBeInTheDocument();
  });

  it('adding a homework item debounces into the update mutation with the new item appended', async () => {
    renderComposer();
    await screen.findByDisplayValue('Practice ledgetraps');

    await userEvent.setup().click(screen.getByRole('button', { name: '+ Add item' }));

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(sessionsUpdate).toHaveBeenCalledWith(
        'tetra',
        's1',
        expect.objectContaining({
          homework: expect.arrayContaining([
            expect.objectContaining({ text: 'Practice ledgetraps' }),
            expect.objectContaining({ text: '' }),
          ]),
        }),
      ),
    );
  });

  it('toggling a homework item fires the dedicated toggle mutation immediately', async () => {
    renderComposer();
    const checkbox = await screen.findByRole('checkbox');
    const user = userEvent.setup();

    await user.click(checkbox);

    await waitFor(() =>
      expect(sessionsToggleHomework).toHaveBeenCalledWith('tetra', 's1', 'h1', true),
    );
  });

  it('removing a homework item debounces into the update mutation with the item gone', async () => {
    renderComposer();
    await screen.findByDisplayValue('Practice ledgetraps');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove homework item' }));

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(sessionsUpdate).toHaveBeenCalledWith(
        'tetra',
        's1',
        expect.objectContaining({ homework: [] }),
      ),
    );
  });

  it('disables "+ Add item" and shows the cap notice at the homework cap (20)', async () => {
    sessionsGet.mockResolvedValue(makeSession({ homework: makeHomework(20) }));
    renderComposer();

    expect(await screen.findByRole('button', { name: '+ Add item' })).toBeDisabled();
    expect(screen.getByText('Up to 20 homework items.')).toBeInTheDocument();
  });

  it('editing the private notes debounces into the update mutation', async () => {
    renderComposer();
    const notesField = await screen.findByDisplayValue('They tilt when down a stock.');

    vi.useFakeTimers();
    fireEvent.change(notesField, { target: { value: 'Updated private note.' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(sessionsUpdate).toHaveBeenCalledWith(
        'tetra',
        's1',
        expect.objectContaining({ coachPrivateNotes: 'Updated private note.' }),
      ),
    );
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('Deliver opens the VOD picker and does not mint until confirmed', async () => {
    renderComposer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Deliver' }));

    expect(await screen.findByText('Choose VODs to include')).toBeInTheDocument();
    expect(deliveriesCreate).not.toHaveBeenCalled();
  });

  it('confirming the picker mints a session delivery link with the chosen includedVods', async () => {
    deliveriesCreate.mockResolvedValue({
      deliveryId: 'd1',
      token: 'tok1',
      url: 'https://x/r/tok1',
    });
    renderComposer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Deliver' }));
    await user.click(await screen.findByRole('button', { name: /Mario/ }));
    // The picker's own confirm button shares the "Deliver" accessible name
    // with the composer's trigger — the trigger is hidden behind the open
    // dialog at this point, so this resolves to the confirm button.
    const confirmButtons = screen.getAllByRole('button', { name: 'Deliver' });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() =>
      expect(deliveriesCreate).toHaveBeenCalledWith('tetra', 's1', { includedVods: ['m1'] }),
    );
  });

  it("pre-checks the picker with the session's currently linked VODs", async () => {
    sessionsGet.mockResolvedValue(makeSession({ linkedMatchIds: ['m2'] }));
    matchesList.mockResolvedValue([makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })]);
    renderComposer();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Deliver' }));

    const rows = await screen.findAllByRole('button', { name: /Mario/ });
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
    expect(rows[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('linking a VOD via the multi-select debounces linkedMatchIds into the update mutation', async () => {
    matchesList.mockResolvedValue([makeMatch({ id: 'm1' })]);
    renderComposer();
    await screen.findByDisplayValue('Practice ledgetraps');
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Linked VODs'), 'm1');

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(sessionsUpdate).toHaveBeenCalledWith(
        'tetra',
        's1',
        expect.objectContaining({ linkedMatchIds: ['m1'] }),
      ),
    );
  });

  it('removing a linked VOD debounces the update with it gone', async () => {
    sessionsGet.mockResolvedValue(makeSession({ linkedMatchIds: ['m1'] }));
    matchesList.mockResolvedValue([makeMatch({ id: 'm1' })]);
    renderComposer();
    await screen.findByDisplayValue('Practice ledgetraps');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Unlink/ }));

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(sessionsUpdate).toHaveBeenCalledWith(
        'tetra',
        's1',
        expect.objectContaining({ linkedMatchIds: [] }),
      ),
    );
  });
});
