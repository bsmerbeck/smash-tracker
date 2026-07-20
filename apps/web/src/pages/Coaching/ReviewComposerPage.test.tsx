import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, ReviewDraft, ReviewSection } from '@smash-tracker/shared';
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

// The real VOD player injects vendor <script> tags and talks to
// window.YT/window.Twitch — out of scope for the composer shell (already
// covered by VodManagerPage.test.tsx / useVodPlayer.test.ts). Swapped for a
// trivial stand-in so this file only exercises composer behavior.
vi.mock('@/pages/VodManager/components/VodPlayer', () => ({
  VodPlayer: ({ vodUrl }: { vodUrl: string }) => <div data-testid="vod-player">{vodUrl}</div>,
}));

const matchesList = vi.fn();
const reviewsGetDraft = vi.fn();
const reviewsHideSection = vi.fn();
const reviewsShowSection = vi.fn();
const reviewsAddSection = vi.fn();
const reviewsPublish = vi.fn();
const reviewsPatchDraft = vi.fn();

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    readonly statusCode?: number;
    readonly details?: unknown;
    constructor(status: number, message: string, details?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.statusCode = status;
      this.details = details;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    coaching: {
      reviews: {
        getDraft: (...args: unknown[]) => reviewsGetDraft(...args),
        hideSection: (...args: unknown[]) => reviewsHideSection(...args),
        showSection: (...args: unknown[]) => reviewsShowSection(...args),
        addSection: (...args: unknown[]) => reviewsAddSection(...args),
        publish: (...args: unknown[]) => reviewsPublish(...args),
        patchDraft: (...args: unknown[]) => reviewsPatchDraft(...args),
      },
    },
  },
  ApiError: MockApiError,
}));

import { AuthProvider } from '@/context/AuthContext';
import { ReviewComposerPage } from './ReviewComposerPage';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    opponent: 'Zain',
    time: Date.now(),
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  } as Match;
}

function makeSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return { id: 'summary', kind: 'summary', hidden: false, title: null, body: '', ...overrides };
}

function makeDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    revision: 0,
    sections: [
      makeSection({ id: 'summary', kind: 'summary' }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ],
    coachPrivateNotes: null,
    lastAutosavedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function renderComposer(initialPath = '/coach/tetra/reviews/r1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId">
              <Route path="reviews/:reviewId" element={<ReviewComposerPage />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReviewComposerPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    matchesList.mockResolvedValue([makeMatch()]);
    reviewsGetDraft.mockResolvedValue(makeDraft());
  });

  it('renders the two-pane layout: source bar, player, evidence heading, and the four suggested sections', async () => {
    renderComposer();

    expect(await screen.findByTestId('vod-player')).toHaveTextContent('https://youtu.be/abc123');
    expect(screen.getByText('vs Zain')).toBeInTheDocument();
    expect(screen.getByText('Evidence (0)')).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'Client review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '🔒 Private notes' })).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Strengths' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Priorities' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Practice Plan' })).toBeInTheDocument();
  });

  it('switching to Private notes shows the full-width amber pane while the left pane (source/player) stays mounted', async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByTestId('vod-player');

    // radix Tabs' default activationMode="automatic" switches on FOCUS, not
    // click — userEvent (not a raw fireEvent.click) is required to trigger it.
    await user.click(screen.getByRole('tab', { name: '🔒 Private notes' }));

    expect(
      await screen.findByText(
        'Only you can see this. Never delivered, never in previews, stored separately from the review.',
      ),
    ).toBeInTheDocument();
    // The left pane never unmounts when switching document tabs.
    expect(screen.getByTestId('vod-player')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
  });

  it('hides a section via the overflow menu (content preserved) and shows a real, focusable Undo button', async () => {
    const user = userEvent.setup({ delay: null });
    renderComposer();
    await screen.findByTestId('vod-player');

    reviewsHideSection.mockResolvedValue(
      makeDraft({
        revision: 1,
        sections: [
          makeSection({ id: 'summary', kind: 'summary', hidden: true, body: 'kept text' }),
          makeSection({ id: 'strengths', kind: 'strengths' }),
          makeSection({ id: 'priorities', kind: 'priorities' }),
          makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
        ],
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Section options: Summary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide section' }));

    await waitFor(() => expect(reviewsHideSection).toHaveBeenCalledWith('tetra', 'r1', 'summary'));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument(),
    );

    const undoButton = await screen.findByRole('button', {
      name: 'Undo hide section Summary',
    });
    expect(undoButton.tagName).toBe('BUTTON');
    await waitFor(() => expect(undoButton).toHaveFocus());

    reviewsShowSection.mockResolvedValue(
      makeDraft({
        revision: 2,
        sections: [
          makeSection({ id: 'summary', kind: 'summary', hidden: false, body: 'kept text' }),
          makeSection({ id: 'strengths', kind: 'strengths' }),
          makeSection({ id: 'priorities', kind: 'priorities' }),
          makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
        ],
      }),
    );
    await user.click(undoButton);

    await waitFor(() => expect(reviewsShowSection).toHaveBeenCalledWith('tetra', 'r1', 'summary'));
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  });

  it('debounces a section edit and autosaves via PATCH with the expected revision', async () => {
    renderComposer();
    await screen.findByTestId('vod-player');

    reviewsPatchDraft.mockResolvedValue(makeDraft({ revision: 1 }));

    // Fake timers installed only for the debounce window itself — findBy*/
    // waitFor above (and the render's own async draft/matches fetch) rely on
    // real timers to poll, so switching earlier would hang those.
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'edited summary' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    vi.useRealTimers();

    expect(reviewsPatchDraft).toHaveBeenCalledWith(
      'tetra',
      'r1',
      expect.objectContaining({ expectedRevision: 0 }),
    );
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});
