import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type {
  CreditsStatus,
  StoredPracticePlan,
  SynthesisJobStatusResponse,
} from '@smash-tracker/shared';
import { PostEventSynthesisCard } from './PostEventSynthesisCard';

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigate };
});

let creditsResult: { data: CreditsStatus | undefined; refetch: () => void } = {
  data: { freeAccess: false, balance: 5, packs: [] },
  refetch: vi.fn(),
};
vi.mock('@/hooks/useBilling', () => ({
  useCredits: () => creditsResult,
}));

let synthesisJobResult: { data: SynthesisJobStatusResponse | undefined } = {
  data: { job: null },
};
let practicePlanResult: { data: { plan: StoredPracticePlan } | undefined } = {
  data: undefined,
};
const submitMutateSpy = vi.fn();
vi.mock('@/hooks/usePostEventSynthesis', () => ({
  useSynthesisJob: () => synthesisJobResult,
  usePracticePlan: () => practicePlanResult,
  useSubmitSynthesis: () => ({ mutate: submitMutateSpy }),
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { ApiError: MockApiError };
});

import { ApiError } from '@/lib/api';

function makePlan(overrides: Partial<StoredPracticePlan> = {}): StoredPracticePlan {
  return {
    entryKey: 'entry-1',
    createdAt: 1,
    summary: 'Overview of your event.',
    focusAreas: [],
    ...overrides,
  };
}

function renderCard(props: { entryKey?: string; annotatedEvidenceCount?: number } = {}) {
  const merged = { entryKey: 'entry-1', annotatedEvidenceCount: 0, ...props };
  return render(
    <MemoryRouter>
      <PostEventSynthesisCard {...merged} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  creditsResult = { data: { freeAccess: false, balance: 5, packs: [] }, refetch: vi.fn() };
  synthesisJobResult = { data: { job: null } };
  practicePlanResult = { data: undefined };
});

/** Text markers unique to each of the five mutually exclusive states. */
const STATE_MARKERS = {
  needAnnotations: 'Annotate your matches first',
  buyCta: 'Get practice plan — 1 credit',
  queued: 'Queued',
  running: 'Generating…',
  failed: 'Failed — refunding your credit…',
  succeeded: 'Ready',
} as const;

function expectOnlyMarkersPresent(present: Array<keyof typeof STATE_MARKERS>) {
  for (const [key, text] of Object.entries(STATE_MARKERS)) {
    const query = screen.queryByText(text);
    if (present.includes(key as keyof typeof STATE_MARKERS)) {
      expect(query).toBeInTheDocument();
    } else {
      expect(query).not.toBeInTheDocument();
    }
  }
}

describe('PostEventSynthesisCard', () => {
  it('state 1: zero annotations, no job -> needAnnotations copy, NO purchase button anywhere', () => {
    renderCard({ annotatedEvidenceCount: 0 });

    expect(screen.getByText('Annotate your matches first')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The plan is built only from your own stored evidence — add at least one timestamp or tag in the VOD Manager, then come back.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get practice plan/ })).not.toBeInTheDocument();
    expectOnlyMarkersPresent(['needAnnotations']);
  });

  it('state 2: annotations exist, no job -> the single primary buyCta, no refunded badge', () => {
    renderCard({ annotatedEvidenceCount: 3 });

    expect(
      screen.getByRole('button', { name: /Get practice plan — 1 credit/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Failed — your credit was refunded.')).not.toBeInTheDocument();
    expectOnlyMarkersPresent(['buyCta']);
  });

  it('state 2 (refunded terminal): annotations exist -> buyCta button PLUS the muted refunded badge', () => {
    synthesisJobResult = {
      data: { job: { jobId: 'job-1', status: 'refunded', updatedAt: 1 } },
    };
    renderCard({ annotatedEvidenceCount: 3 });

    expect(
      screen.getByRole('button', { name: /Get practice plan — 1 credit/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Failed — your credit was refunded.')).toBeInTheDocument();
    expectOnlyMarkersPresent(['buyCta']);
  });

  it('state 3: queued job -> the outline Queued badge, no purchase affordance', () => {
    synthesisJobResult = { data: { job: { jobId: 'job-1', status: 'queued', updatedAt: 1 } } };
    renderCard({ annotatedEvidenceCount: 3 });

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get practice plan/ })).not.toBeInTheDocument();
    expectOnlyMarkersPresent(['queued']);
  });

  it('state 3: running job -> the spinning Generating… badge, no purchase affordance', () => {
    synthesisJobResult = { data: { job: { jobId: 'job-1', status: 'running', updatedAt: 1 } } };
    renderCard({ annotatedEvidenceCount: 3 });

    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get practice plan/ })).not.toBeInTheDocument();
    expectOnlyMarkersPresent(['running']);
  });

  it('state 4: failed job -> the destructive badge with failedPendingRefund copy', () => {
    synthesisJobResult = { data: { job: { jobId: 'job-1', status: 'failed', updatedAt: 1 } } };
    renderCard({ annotatedEvidenceCount: 3 });

    expect(screen.getByText('Failed — refunding your credit…')).toBeInTheDocument();
    expectOnlyMarkersPresent(['failed']);
  });

  it('state 5: succeeded job -> the success badge + View plan/Hide plan toggle, no repurchase affordance', async () => {
    const user = userEvent.setup();
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'succeeded', updatedAt: 1, resultRef: 'plan-1' },
      },
    };
    practicePlanResult = { data: { plan: makePlan() } };
    renderCard({ annotatedEvidenceCount: 3 });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get practice plan/ })).not.toBeInTheDocument();
    expectOnlyMarkersPresent(['succeeded']);

    const viewButton = screen.getByRole('button', { name: 'View plan' });
    expect(screen.queryByText('Overview of your event.')).not.toBeInTheDocument();

    await user.click(viewButton);
    expect(screen.getByText('Overview of your event.')).toBeInTheDocument();
    const hideButton = screen.getByRole('button', { name: 'Hide plan' });

    await user.click(hideButton);
    expect(screen.queryByText('Overview of your event.')).not.toBeInTheDocument();
  });

  it('every {{cite:...}} token in the plan renders a CitationChip whose activation navigates to /vod?match=<sourceVodRef>', async () => {
    const user = userEvent.setup();
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'succeeded', updatedAt: 1, resultRef: 'plan-1' },
      },
    };
    practicePlanResult = {
      data: {
        plan: makePlan({
          focusAreas: [
            {
              title: 'Punish game',
              evidence:
                'You dropped the punish {{cite:matchId=match-42;seconds=90;label=Set 2, game 3}}.',
              drills: ['Practice combo A'],
            },
          ],
        }),
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    const chip = screen.getByRole('button', { name: /Set 2, game 3/ });
    await user.click(chip);

    expect(navigate).toHaveBeenCalledWith('/vod?match=match-42');
    expect(screen.getByText('Practice combo A')).toBeInTheDocument();
  });

  it('renders the submit-failed message inline for a non-payment purchase failure', async () => {
    const user = userEvent.setup();
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: /Get practice plan — 1 credit/ }));
    const [, callOptions] = submitMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(new Error('boom'));
    });

    expect(
      screen.getByText('Something went wrong starting your plan. Please try again.'),
    ).toBeInTheDocument();
  });

  it('does NOT render the submit-failed message for a 402 rejection (handled in Task 3)', async () => {
    const user = userEvent.setup();
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: /Get practice plan — 1 credit/ }));
    const [, callOptions] = submitMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    expect(
      screen.queryByText('Something went wrong starting your plan. Please try again.'),
    ).not.toBeInTheDocument();
  });
});
