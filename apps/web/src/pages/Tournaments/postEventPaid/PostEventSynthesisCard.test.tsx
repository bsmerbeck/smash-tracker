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
import {
  ABSTAINED_CLAIM,
  CLAIMS_ERA_PLAN,
  GAMEPLAN_CONNECTIVE,
  OVERVIEW_CONNECTIVE,
  STAGE_CLAIM,
  USAGE_CLAIM,
  H2H_CLAIM,
} from '@/test/claimReportFixtures';
import { CLAIMS_ERA_PLAN_WITH_ACTIONS } from '@/test/actionFixtures';
import { PostEventSynthesisCard } from './PostEventSynthesisCard';

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn() }),
}));

vi.mock('@/components/billing/BuyCreditsDialog', () => ({
  BuyCreditsDialog: ({ open, returnTo }: { open: boolean; returnTo?: unknown }) =>
    open ? (
      <div data-testid="buy-credits-dialog" data-return-to={JSON.stringify(returnTo)} />
    ) : null,
}));

let creditsResult: {
  data: CreditsStatus | undefined;
  refetch: () => void;
} = {
  data: {
    freeAccess: false,
    balance: 5,
    packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
  },
  refetch: vi.fn(),
};
vi.mock('@/hooks/useBilling', () => ({
  useCredits: () => creditsResult,
}));

// Isolated component render (no AuthProvider ancestor) — mirrors
// `DashboardPrepActionSlot.test.tsx`'s established pattern of mocking the
// profile-derived hook directly.
const useIsDemoAccount = vi.fn(() => false);
vi.mock('@/hooks/useIsDemoAccount', () => ({
  useIsDemoAccount: () => useIsDemoAccount(),
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
  creditsResult = {
    data: {
      freeAccess: false,
      balance: 5,
      packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
    },
    refetch: vi.fn(),
  };
  synthesisJobResult = { data: { job: null } };
  practicePlanResult = { data: undefined };
  useIsDemoAccount.mockReturnValue(false);
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

  it('IN-04: the citation deep-link URL-encodes the matchId (token grammar permits &/= in matchId)', async () => {
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
              evidence: 'Watch this {{cite:matchId=a&b=c;seconds=5;label=Odd id}}.',
              drills: [],
            },
          ],
        }),
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));
    await user.click(screen.getByRole('button', { name: /Odd id/ }));

    // Unencoded, `&b=c` would split into a second query parameter.
    expect(navigate).toHaveBeenCalledWith('/vod?match=a%26b%3Dc');
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

  it('does NOT render the submit-failed message for a 402 rejection — it opens the buy dialog instead', async () => {
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

  it('a 402 submit auto-opens BuyCreditsDialog with returnTo {returnTo:"prep", entryKey}', async () => {
    const user = userEvent.setup();
    renderCard({ entryKey: 'entry-1', annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: /Get practice plan — 1 credit/ }));
    const [, callOptions] = submitMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    const dialog = screen.getByTestId('buy-credits-dialog');
    expect(dialog).toBeInTheDocument();
    expect(JSON.parse(dialog.getAttribute('data-return-to') ?? '{}')).toEqual({
      returnTo: 'prep',
      entryKey: 'entry-1',
    });
  });

  it('after a 402, the persistent three-part insufficient-credits hint renders (body + link-variant buyCta + toGenerate)', async () => {
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
      screen.getByText(
        (_, element) =>
          element?.textContent === "You're out of credits. Buy credits to get your practice plan.",
      ),
    ).toBeInTheDocument();
  });
});

// Phase 30.3 (Gate 6, owner/Codex hard gate): no Buy Credits control
// anywhere it renders, for a demo/research account — the dialog mount and
// the inline insufficient-credits "Buy credits" link both gate on
// `canBuyCredits`, which folds in `!isDemoAccount`.
describe('PostEventSynthesisCard — demo account gating', () => {
  it('never renders BuyCreditsDialog for a demo account, even after a 402', async () => {
    useIsDemoAccount.mockReturnValue(true);
    const user = userEvent.setup();
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: /Get practice plan — 1 credit/ }));
    const [, callOptions] = submitMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    expect(screen.queryByTestId('buy-credits-dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Buy credits/ })).not.toBeInTheDocument();
  });

  it('positive control: an ordinary account still gets the Buy Credits dialog after a 402', async () => {
    useIsDemoAccount.mockReturnValue(false);
    const user = userEvent.setup();
    renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: /Get practice plan — 1 credit/ }));
    const [, callOptions] = submitMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    expect(screen.getByTestId('buy-credits-dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-09, RPT-06): the expanded plan view renders a claims-era
// plan's claim-anchored sections through the shared ClaimAtomLine.
// ---------------------------------------------------------------------------
describe('PostEventSynthesisCard — claims-era practice plan (plan 39-09)', () => {
  const succeeded = {
    data: {
      job: {
        jobId: 'job-1',
        status: 'succeeded' as const,
        updatedAt: 1,
        resultRef: 'plan-1',
      },
    },
  };

  it('renders one claim line per surviving claim id in stored order, with app-rendered figures', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = { data: { plan: CLAIMS_ERA_PLAN } };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    const ids = [...container.querySelectorAll('[data-claim-id]')].map((node) =>
      node.getAttribute('data-claim-id'),
    );
    expect(ids).toEqual([H2H_CLAIM.id, STAGE_CLAIM.id, USAGE_CLAIM.id]);
    const figures = [...container.querySelectorAll('[data-claim-figure]')].map(
      (node) => node.textContent,
    );
    expect(figures).toEqual(['7–3 · 70%', '34–21 · 62%', '60% (12/20)']);
    // The summary (= overview connective) renders once; the game-plan connective leads its section.
    expect(screen.getAllByText(OVERVIEW_CONNECTIVE)).toHaveLength(1);
    expect(screen.getByText(GAMEPLAN_CONNECTIVE)).toBeInTheDocument();
  });

  it('an all-abstained section renders the abstention sentence and no bullets', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = { data: { plan: CLAIMS_ERA_PLAN } };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    const watchFor = container.querySelector('[data-plan-claim-section="watchFor"]') as HTMLElement;
    expect(watchFor).toHaveTextContent('Not enough data yet — 2 more games needed.');
    expect(watchFor.querySelectorAll('li')).toHaveLength(0);
    expect(container.querySelector(`[data-claim-id="${ABSTAINED_CLAIM.id}"]`)).toBeNull();
  });

  it('a legacy plan (no claims/sections) keeps its focus-area rendering and renders no claim section', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = { data: { plan: makePlan() } };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    expect(container.querySelectorAll('[data-plan-claim-section]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-claim-id]')).toHaveLength(0);
  });
});

/**
 * Plan 39-10 (D-21, review C4-M2): the post-event validation caption. The
 * CAUSE keys on `failureReason === 'validation'` (an allowlist of one); the
 * RETURN clause keys on the terminal `refunded` status AND a loaded
 * `freeAccess === false` credits read.
 *
 * Why the extra viewer check on THIS card: `failJob` writes the refunded
 * terminal for a ZERO-SPEND post_event_synthesis failure too (Phase 28
 * CR-02, so the entry stays resubmittable) with no refundCredit call, and
 * the job record persists no spend fact — so `status === 'refunded'` alone
 * would tell a free-access viewer a credit came back that was never debited.
 * Every spend site sets `spent = !freeAccess`, which is the fact the client
 * CAN read. Residual (recorded in the 39-10 SUMMARY): a uid whose allowlist
 * status changed between the job and this view.
 */
describe('PostEventSynthesisCard — validation-failure caption (plan 39-10, D-21)', () => {
  const CAUSE = "There isn't enough match evidence yet to build a verified practice plan.";
  const RETURN = 'Your credit was returned.';

  function caption(): HTMLElement | null {
    return document.querySelector('[data-validation-caption]');
  }

  it('C1-H1: a SPENT synthesis at the refunded terminal renders BOTH clauses under the refunded badge, cause then return', () => {
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'refunded', updatedAt: 1, failureReason: 'validation' },
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });
    const spans = Array.from(caption()!.querySelectorAll('span')).map((span) => span.textContent);
    expect(spans).toEqual([CAUSE, RETURN]);
    expect(caption()!.textContent).toBe(`${CAUSE}${RETURN}`);
    const badge = screen.getByText('Failed — your credit was refunded.');
    expect(badge.nextElementSibling).toBe(caption());
  });

  it('the ZERO-SPEND free-access synthesis (refunded terminal, no refund ever — Phase 28 CR-02) renders the cause and NOT the return clause', () => {
    creditsResult = { data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() };
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'refunded', updatedAt: 1, failureReason: 'validation' },
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });
    expect(caption()!.textContent).toBe(CAUSE);
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
    expect(document.querySelector('[data-validation-caption-return]')).toBeNull();
  });

  it('an unloaded credits read withholds the return clause (says less, never something false)', () => {
    creditsResult = { data: undefined, refetch: vi.fn() };
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'refunded', updatedAt: 1, failureReason: 'validation' },
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });
    expect(caption()!.textContent).toBe(CAUSE);
  });

  it('a failed (pending) validation job renders the cause under the destructive badge, without the return clause', () => {
    synthesisJobResult = {
      data: {
        job: { jobId: 'job-1', status: 'failed', updatedAt: 1, failureReason: 'validation' },
      },
    };
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText('Failed — refunding your credit…').nextElementSibling).toBe(caption());
    expect(caption()!.textContent).toBe(CAUSE);
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
  });

  it.each([
    { label: 'absent', failureReason: undefined },
    { label: 'refusal', failureReason: 'refusal' },
    { label: 'truncated', failureReason: 'truncated' },
    { label: 'unparseable', failureReason: 'unparseable' },
    { label: 'an unrecognised future value', failureReason: 'some_future_cause' },
  ])('failureReason $label renders NO caption on either terminal shape', ({ failureReason }) => {
    for (const status of ['failed', 'refunded'] as const) {
      synthesisJobResult = {
        data: {
          job: {
            jobId: 'job-1',
            status,
            updatedAt: 1,
            ...(failureReason ? { failureReason } : {}),
          },
        },
      };
      const { unmount } = renderCard({ annotatedEvidenceCount: 3 });
      expect(caption()).toBeNull();
      expect(screen.queryByText(CAUSE)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('the caption carries no amount and no digit in either shape (D-21)', () => {
    for (const status of ['failed', 'refunded'] as const) {
      synthesisJobResult = {
        data: { job: { jobId: 'job-1', status, updatedAt: 1, failureReason: 'validation' } },
      };
      const { unmount } = renderCard({ annotatedEvidenceCount: 3 });
      expect(caption()!.textContent).not.toMatch(/\p{Nd}/u);
      unmount();
    }
  });
});

describe('PostEventSynthesisCard — dropped-claims and withheld-prose footer (plan 39-10, D-07 / D-20)', () => {
  const succeeded = {
    data: {
      job: { jobId: 'job-1', status: 'succeeded' as const, updatedAt: 1, resultRef: 'plan-1' },
    },
  };
  const WITHHELD_TWO =
    "Commentary for 2 sections was withheld because it couldn't be verified against your match data.";
  const DROPPED_ONE = "1 claim couldn't be verified and was removed from this report.";

  it('a claims-era plan renders each note exactly once in the expanded plan view, after the last section', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = {
      data: { plan: { ...CLAIMS_ERA_PLAN, droppedClaimCount: 1, strippedSectionCount: 2 } },
    };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.queryByText(WITHHELD_TWO)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    expect(screen.getAllByText(WITHHELD_TWO)).toHaveLength(1);
    expect(screen.getAllByText(DROPPED_ONE)).toHaveLength(1);
    const sections = container.querySelectorAll('[data-plan-claim-section]');
    const last = sections[sections.length - 1]!;
    const dropped = container.querySelector('[data-dropped-claims-note]')!;
    expect(last.compareDocumentPosition(dropped) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain('NaN');
  });

  it("a LEGACY plan discloses its stored dropped count (28-06's field) but never a withheld-prose note", async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = {
      data: {
        plan: makePlan({
          focusAreas: [{ title: 'Ledge', evidence: 'Watch the ledge.', drills: [] }],
          droppedClaimCount: 1,
          strippedSectionCount: 2,
        }),
      },
    };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });
    await user.click(screen.getByRole('button', { name: 'View plan' }));

    expect(screen.getAllByText(DROPPED_ONE)).toHaveLength(1);
    expect(container.querySelector('[data-withheld-prose-note]')).toBeNull();
  });
});

/**
 * Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25) — LIVE BUG: a
 * zero-spend free-access synthesis failure terminates at `refunded` (Phase 28
 * CR-02) with no refund, yet the v2.5 badge said "your credit was refunded".
 * Refund wording now renders only for a charged job; `wasCharged` decides when
 * present, older jobs fall back to the loaded credits read, unknown says only
 * "Failed".
 */
describe('PostEventSynthesisCard — honest failure badge (post-plan fix 39-10)', () => {
  const PENDING_REFUND = 'Failed — refunding your credit…';
  const REFUNDED = 'Failed — your credit was refunded.';
  const NO_CHARGE = 'Failed — no credit was used.';
  const CHARGE_UNKNOWN = 'Failed';
  const RETURN = 'Your credit was returned.';
  const FREE_ACCESS = { data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() };

  function job(overrides: Partial<NonNullable<SynthesisJobStatusResponse['job']>>) {
    synthesisJobResult = {
      data: { job: { jobId: 'job-1', status: 'refunded', updatedAt: 1, ...overrides } },
    };
  }

  function expectNoRefundWording() {
    expect(screen.queryByText(PENDING_REFUND)).not.toBeInTheDocument();
    expect(screen.queryByText(REFUNDED)).not.toBeInTheDocument();
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/refund/i);
  }

  it('paid, refunded (wasCharged true): the refunded badge and the caption return clause', () => {
    job({ status: 'refunded', failureReason: 'validation', wasCharged: true });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(REFUNDED)).toBeInTheDocument();
    expect(screen.getByText(RETURN)).toBeInTheDocument();
  });

  it('paid, failed (wasCharged true): the pending-refund badge', () => {
    job({ status: 'failed', wasCharged: true });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(PENDING_REFUND)).toBeInTheDocument();
  });

  it('THE LIVE BUG — CR-02 zero-spend free-access refunded terminal, recorded wasCharged false: "no credit was used", no refund wording', () => {
    creditsResult = FREE_ACCESS;
    job({ status: 'refunded', failureReason: 'validation', wasCharged: false });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('THE LIVE BUG — older CR-02 record (no wasCharged), free-access viewer: falls back to the credits read, "no credit was used"', () => {
    creditsResult = FREE_ACCESS;
    job({ status: 'refunded' });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('free-access failed (pending) job: "no credit was used" under the destructive badge slot', () => {
    creditsResult = FREE_ACCESS;
    job({ status: 'failed', failureReason: 'validation' });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(NO_CHARGE).nextElementSibling).toBe(
      document.querySelector('[data-validation-caption]'),
    );
    expectNoRefundWording();
  });

  it('STATUS CHANGED LATER — charged, viewer now free-access: wasCharged true beats the current freeAccess read', () => {
    creditsResult = FREE_ACCESS;
    job({ status: 'refunded', failureReason: 'validation', wasCharged: true });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(REFUNDED)).toBeInTheDocument();
    expect(screen.getByText(RETURN)).toBeInTheDocument();
  });

  it('STATUS CHANGED LATER — ran free, viewer now billable: wasCharged false beats the current freeAccess read', () => {
    job({ status: 'refunded', failureReason: 'validation', wasCharged: false });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('unknown charge (no wasCharged, credits not loaded): a plain "Failed", never refund wording, never a no-charge claim', () => {
    creditsResult = { data: undefined, refetch: vi.fn() };
    job({ status: 'refunded' });
    renderCard({ annotatedEvidenceCount: 3 });
    expect(screen.getByText(CHARGE_UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByText(NO_CHARGE)).not.toBeInTheDocument();
    expectNoRefundWording();
  });
});

// ---------------------------------------------------------------------------
// Plan 39-11 (RPT-09 / D-12, review C3-M2): the PAID recommended-actions block
// renders ONCE inside the expanded plan view, after the last focus area /
// claim section — claims-era plans only.
// ---------------------------------------------------------------------------
describe('PostEventSynthesisCard — recommended actions (plan 39-11)', () => {
  const succeeded = {
    data: {
      job: {
        jobId: 'job-1',
        status: 'succeeded' as const,
        updatedAt: 1,
        resultRef: 'plan-1',
      },
    },
  };

  it('renders the paid block once in the expanded plan, after the last claim section, with three rows and one door each', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = { data: { plan: CLAIMS_ERA_PLAN_WITH_ACTIONS } };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });

    expect(container.querySelector('[data-recommended-actions]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View plan' }));

    const blocks = container.querySelectorAll('[data-recommended-actions="paid"]');
    expect(blocks).toHaveLength(1);
    const rows = blocks[0]!.querySelectorAll<HTMLElement>('[data-action-row]');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelectorAll('a')).toHaveLength(1);
    }
    const lastSection = container.querySelector('[data-plan-claim-section="watchFor"]')!;
    expect(
      lastSection.compareDocumentPosition(blocks[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('a legacy plan (no claims/sections) renders no recommended-actions block', async () => {
    const user = userEvent.setup();
    synthesisJobResult = succeeded;
    practicePlanResult = { data: { plan: makePlan() } };
    const { container } = renderCard({ annotatedEvidenceCount: 3 });

    await user.click(screen.getByRole('button', { name: 'View plan' }));

    expect(container.querySelector('[data-recommended-actions]')).toBeNull();
  });
});
