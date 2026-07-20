import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useAddReviewSection,
  useCoachingReviewDraft,
  useCoachingReviews,
  useCreateCoachingReview,
  useHideReviewSection,
  usePublishCoachingReview,
} from './useCoachingReviews';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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

import { AuthProvider } from '@/context/AuthContext';

const reviewsList = vi.fn();
const reviewsCreate = vi.fn();
const reviewsGetDraft = vi.fn();
const reviewsPublish = vi.fn();
const reviewsHideSection = vi.fn();
const reviewsAddSection = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    coaching: {
      reviews: {
        list: (...args: unknown[]) => reviewsList(...args),
        create: (...args: unknown[]) => reviewsCreate(...args),
        getDraft: (...args: unknown[]) => reviewsGetDraft(...args),
        publish: (...args: unknown[]) => reviewsPublish(...args),
        hideSection: (...args: unknown[]) => reviewsHideSection(...args),
        addSection: (...args: unknown[]) => reviewsAddSection(...args),
      },
    },
  },
}));

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ListProbe({ clientId }: { clientId?: string }) {
  const list = useCoachingReviews(clientId);
  if (!list.isSuccess) {
    return <div>loading</div>;
  }
  return <div>reviews: {list.data.length}</div>;
}

function CreateProbe({ clientId }: { clientId: string }) {
  const create = useCreateCoachingReview(clientId);
  return (
    <div>
      <button onClick={() => create.mutate()}>create</button>
      {create.isSuccess && <div>created: {create.data.reviewId}</div>}
    </div>
  );
}

function DraftProbe({ clientId, reviewId }: { clientId: string; reviewId: string }) {
  const draft = useCoachingReviewDraft(clientId, reviewId);
  if (!draft.isSuccess) {
    return <div>loading</div>;
  }
  return <div>revision: {draft.data.revision}</div>;
}

function PublishProbe({ clientId, reviewId }: { clientId: string; reviewId: string }) {
  const publish = usePublishCoachingReview(clientId, reviewId);
  return (
    <div>
      <button onClick={() => publish.mutate()}>publish</button>
      {publish.isSuccess && <div>version: {publish.data.version}</div>}
    </div>
  );
}

function HideSectionProbe({ clientId, reviewId }: { clientId: string; reviewId: string }) {
  const hide = useHideReviewSection(clientId, reviewId);
  return (
    <div>
      <button onClick={() => hide.mutate('summary')}>hide</button>
      {hide.isSuccess && <div>hidden: {hide.data.revision}</div>}
    </div>
  );
}

function AddSectionProbe({ clientId, reviewId }: { clientId: string; reviewId: string }) {
  const add = useAddReviewSection(clientId, reviewId);
  return (
    <div>
      <button onClick={() => add.mutate({ kind: 'general', title: 'Notes' })}>add</button>
      {add.isSuccess && <div>added: {add.data.revision}</div>}
    </div>
  );
}

describe('useCoachingReviews', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useCoachingReviews resolves the list for the given clientId', async () => {
    reviewsList.mockResolvedValue([
      {
        reviewId: 'r1',
        status: 'draft',
        latestVersion: null,
        revision: 3,
        deliveryState: null,
        createdAt: 1,
        lastAutosavedAt: 1,
      },
    ]);

    render(
      <Wrapper>
        <ListProbe clientId="tetra" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('reviews: 1')).toBeInTheDocument());
    expect(reviewsList).toHaveBeenCalledWith('tetra');
  });

  it('useCoachingReviews does not fetch when clientId is undefined', () => {
    render(
      <Wrapper>
        <ListProbe />
      </Wrapper>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(reviewsList).not.toHaveBeenCalled();
  });

  it('useCreateCoachingReview posts for the clientId and resolves the created review', async () => {
    reviewsCreate.mockResolvedValue({ reviewId: 'r2', revision: 0 });

    render(
      <Wrapper>
        <CreateProbe clientId="tetra" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('create'));

    await waitFor(() => expect(screen.getByText('created: r2')).toBeInTheDocument());
    expect(reviewsCreate).toHaveBeenCalledWith('tetra');
  });

  it('useCoachingReviewDraft resolves the coach-facing draft (including revision)', async () => {
    reviewsGetDraft.mockResolvedValue({
      revision: 4,
      sections: [],
      coachPrivateNotes: null,
      lastAutosavedAt: 1,
      createdAt: 1,
    });

    render(
      <Wrapper>
        <DraftProbe clientId="tetra" reviewId="r1" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('revision: 4')).toBeInTheDocument());
    expect(reviewsGetDraft).toHaveBeenCalledWith('tetra', 'r1');
  });

  it('usePublishCoachingReview posts and resolves the sealed version', async () => {
    reviewsPublish.mockResolvedValue({ version: 1 });

    render(
      <Wrapper>
        <PublishProbe clientId="tetra" reviewId="r1" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('publish'));

    await waitFor(() => expect(screen.getByText('version: 1')).toBeInTheDocument());
    expect(reviewsPublish).toHaveBeenCalledWith('tetra', 'r1');
  });

  it('useHideReviewSection posts the sectionId and resolves the updated draft', async () => {
    reviewsHideSection.mockResolvedValue({
      revision: 2,
      sections: [],
      coachPrivateNotes: null,
      lastAutosavedAt: 1,
      createdAt: 1,
    });

    render(
      <Wrapper>
        <HideSectionProbe clientId="tetra" reviewId="r1" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('hide'));

    await waitFor(() => expect(screen.getByText('hidden: 2')).toBeInTheDocument());
    expect(reviewsHideSection).toHaveBeenCalledWith('tetra', 'r1', 'summary');
  });

  it('useAddReviewSection posts the kind/title and resolves the updated draft', async () => {
    reviewsAddSection.mockResolvedValue({
      revision: 3,
      sections: [],
      coachPrivateNotes: null,
      lastAutosavedAt: 1,
      createdAt: 1,
    });

    render(
      <Wrapper>
        <AddSectionProbe clientId="tetra" reviewId="r1" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('add'));

    await waitFor(() => expect(screen.getByText('added: 3')).toBeInTheDocument());
    expect(reviewsAddSection).toHaveBeenCalledWith('tetra', 'r1', {
      kind: 'general',
      title: 'Notes',
    });
  });
});
