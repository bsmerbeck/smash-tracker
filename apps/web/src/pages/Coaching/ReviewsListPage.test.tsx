import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, ReviewDraft } from '@smash-tracker/shared';
import type { ReviewDeliveryListItem, ReviewListItem } from '@/lib/api';
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

const reviewsList = vi.fn();
const reviewsCreate = vi.fn();
const reviewsArchive = vi.fn();
const reviewsGetDraft = vi.fn();
const deliveriesList = vi.fn();
const deliveriesCreate = vi.fn();
const deliveriesRevoke = vi.fn();
const matchesList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    coaching: {
      reviews: {
        list: (...args: unknown[]) => reviewsList(...args),
        create: (...args: unknown[]) => reviewsCreate(...args),
        archive: (...args: unknown[]) => reviewsArchive(...args),
        getDraft: (...args: unknown[]) => reviewsGetDraft(...args),
        deliveries: {
          list: (...args: unknown[]) => deliveriesList(...args),
          create: (...args: unknown[]) => deliveriesCreate(...args),
          revoke: (...args: unknown[]) => deliveriesRevoke(...args),
        },
      },
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '@/context/AuthContext';
import { ReviewsListPage } from './ReviewsListPage';

function makeReview(overrides: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    reviewId: 'r1',
    status: 'draft',
    latestVersion: null,
    revision: 0,
    deliveryState: null,
    createdAt: 1_700_000_000_000,
    lastAutosavedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<ReviewDeliveryListItem> = {}): ReviewDeliveryListItem {
  return {
    deliveryId: 'd1',
    status: 'delivered',
    token: 'tok1',
    version: 1,
    createdAt: 1_700_000_000_000,
    revokedAt: null,
    expiresAt: null,
    ackAt: null,
    viewedAt: null,
    url: 'https://grandfinals.gg/r/tok1',
    ...overrides,
  };
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

function makeDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    revision: 0,
    sections: [],
    coachPrivateNotes: null,
    lastAutosavedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function ReviewComposerStub() {
  const location = useLocation();
  return <div data-testid="review-composer-stub">{location.pathname}</div>;
}

function renderList(initialPath = '/coach/tetra/reviews') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId">
              <Route path="reviews" element={<ReviewsListPage />} />
              <Route path="reviews/:reviewId" element={<ReviewComposerStub />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReviewsListPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    deliveriesList.mockResolvedValue([]);
    matchesList.mockResolvedValue([makeMatch()]);
    reviewsGetDraft.mockResolvedValue(makeDraft());
  });

  it('shows a dash delivery chip (never "Not delivered") for a draft review', async () => {
    reviewsList.mockResolvedValue([makeReview({ status: 'draft', deliveryState: null })]);
    renderList();

    expect(await screen.findByText('Draft')).toBeInTheDocument();
    expect(screen.getByLabelText('No delivery — nothing published yet')).toHaveTextContent('—');
  });

  it('renders separate review-status and delivery-status chips for a published, acknowledged review', async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 2, deliveryState: 'acknowledged' }),
    ]);
    renderList();

    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(screen.getByText('Acknowledged')).toBeInTheDocument();
  });

  it('renders a separate Open button and delivery overflow menu — never a merged control', async () => {
    reviewsList.mockResolvedValue([makeReview()]);
    renderList();

    expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delivery and more actions' })).toBeInTheDocument();
  });

  it('Open navigates straight to the composer for that review', async () => {
    reviewsList.mockResolvedValue([makeReview({ reviewId: 'r-open' })]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByTestId('review-composer-stub')).toHaveTextContent(
      '/coach/tetra/reviews/r-open',
    );
  });

  it('the delivery menu disables Deliver for a draft (no published version to pin to)', async () => {
    reviewsList.mockResolvedValue([makeReview({ status: 'draft', latestVersion: null })]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));

    expect(await screen.findByRole('menuitem', { name: 'Deliver' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Deliver opens the VOD picker and does not mint until confirmed', async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 3, deliveryState: 'not-delivered' }),
    ]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deliver' }));

    expect(await screen.findByText('Choose VODs to include')).toBeInTheDocument();
    expect(deliveriesCreate).not.toHaveBeenCalled();
  });

  it('confirming the picker mints a delivery for the published latestVersion with the chosen includedVods', async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 3, deliveryState: 'not-delivered' }),
    ]);
    matchesList.mockResolvedValue([makeMatch({ id: 'm1' })]);
    deliveriesCreate.mockResolvedValue({
      deliveryId: 'd1',
      token: 'tok1',
      url: 'https://x/r/tok1',
    });
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deliver' }));
    await user.click(await screen.findByRole('button', { name: /Mario/ }));
    await user.click(screen.getByRole('button', { name: 'Deliver' }));

    await waitFor(() =>
      expect(deliveriesCreate).toHaveBeenCalledWith('tetra', 'r1', {
        version: 3,
        includedVods: ['m1'],
      }),
    );
  });

  it("pre-checks the picker with the review's cited matchIds", async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 3, deliveryState: 'not-delivered' }),
    ]);
    matchesList.mockResolvedValue([makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })]);
    reviewsGetDraft.mockResolvedValue(
      makeDraft({
        sections: [
          {
            id: 'summary',
            kind: 'summary',
            hidden: false,
            title: null,
            body: '{{cite:matchId=m2;seconds=42;label=moment}}',
          },
        ],
      }),
    );
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deliver' }));

    const rows = await screen.findAllByRole('button', { name: /Mario/ });
    await waitFor(() => expect(rows[1]).toHaveAttribute('aria-pressed', 'true'));
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('Revoke fires the revoke mutation for the active (non-revoked) delivery', async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 1, deliveryState: 'delivered' }),
    ]);
    deliveriesList.mockResolvedValue([makeDelivery({ deliveryId: 'd-active' })]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    const revokeItem = await screen.findByRole('menuitem', { name: 'Revoke link' });
    await waitFor(() => expect(revokeItem).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(revokeItem);

    await waitFor(() => expect(deliveriesRevoke).toHaveBeenCalledWith('tetra', 'r1', 'd-active'));
  });

  it('Archive review fires the archive mutation', async () => {
    reviewsList.mockResolvedValue([makeReview()]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive review' }));

    await waitFor(() => expect(reviewsArchive).toHaveBeenCalledWith('tetra', 'r1'));
  });

  it('+ New review creates a fresh draft and navigates to its composer', async () => {
    reviewsList.mockResolvedValue([]);
    reviewsCreate.mockResolvedValue({ reviewId: 'r-new', revision: 0 });
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: '+ New review' }));

    expect(await screen.findByTestId('review-composer-stub')).toHaveTextContent(
      '/coach/tetra/reviews/r-new',
    );
  });

  it('shows the empty state when there are no reviews yet', async () => {
    reviewsList.mockResolvedValue([]);
    renderList();

    expect(
      await screen.findByText(
        'No reviews yet. Start one from here or from a VOD in the VOD Manager.',
      ),
    ).toBeInTheDocument();
  });

  it('stacks the card title above the chips row on mobile while preserving the desktop row (D-13)', async () => {
    reviewsList.mockResolvedValue([
      makeReview({ status: 'published', latestVersion: 2, deliveryState: 'acknowledged' }),
    ]);
    renderList();

    const title = await screen.findByText(/Review — started/);
    const statusChip = await screen.findByText('Published v2');

    // The card root (<li>) stacks on mobile (flex-col) and becomes the
    // existing single row at `sm` (sm:flex-row) — this directly encodes the
    // D-13 fix (mobile-first stack, desktop row preserved).
    const cardRoot = title.closest('li');
    expect(cardRoot).not.toBeNull();
    expect(cardRoot?.className).toContain('flex-col');
    expect(cardRoot?.className).toContain('sm:flex-row');

    // The title and the status chip must NOT share the same immediate
    // parent — they live in separate stacking rows, so the title is no
    // longer a sibling competing on the crush row with the chips.
    expect(title.parentElement).not.toBe(statusChip.parentElement);
  });
});
