import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router';
import type {
  CreditsStatus,
  PrepPresenceMap,
  PrepReportJobStatusEntry,
  ScoutBinding,
  ScoutBindingMap,
  ScoutReportRecord,
} from '@smash-tracker/shared';
import { PrepPaidReportsCard } from './PrepPaidReportsCard';

const toastSuccess = vi.fn();
const toastPlain = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastPlain(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
  }),
}));

const postCanonicalEventSpy = vi.fn();
vi.mock('@/lib/canonicalEvents', () => ({
  postCanonicalEvent: (...args: unknown[]) => postCanonicalEventSpy(...args),
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

let jobsByOpponentName: Record<string, PrepReportJobStatusEntry> = {};
vi.mock('@/hooks/usePrepReportJobs', () => ({
  usePrepReportJobs: () => ({ jobsByOpponentName }),
}));

const generateMutateSpy = vi.fn();
const generateMutateAsyncSpy = vi.fn();
const startBundleMutateSpy = vi.fn();
const executeBundleChildrenSpy = vi.fn();
vi.mock('@/hooks/usePrepPaidReports', () => ({
  useGeneratePrepReport: () => ({ mutate: generateMutateSpy, mutateAsync: generateMutateAsyncSpy }),
  useStartPrepBundle: () => ({ mutate: startBundleMutateSpy }),
  executeBundleChildren: (...args: unknown[]) => executeBundleChildrenSpy(...args),
}));

vi.mock('./OpponentBindingConfirm', () => ({
  OpponentBindingConfirm: ({ name, binding }: { name: string; binding?: ScoutBinding }) => (
    <div data-testid={`binding-${name}`}>
      {binding ? `confirmed:${name}` : `unconfirmed:${name}`}
    </div>
  ),
}));

vi.mock('@/components/billing/BuyCreditsDialog', () => ({
  BuyCreditsDialog: ({ open, returnTo }: { open: boolean; returnTo?: unknown }) =>
    open ? (
      <div data-testid="buy-credits-dialog" data-return-to={JSON.stringify(returnTo)} />
    ) : null,
}));

vi.mock('@/pages/Scout/components/ScoutAiReportCard', () => ({
  ScoutAiReportCard: ({ record }: { record: ScoutReportRecord }) => (
    <div data-testid="ai-report-card">{record.id}</div>
  ),
}));

const reportsGetSpy = vi.fn();
vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError: MockApiError,
    api: { reports: { get: (...args: unknown[]) => reportsGetSpy(...args) } },
  };
});

import { ApiError } from '@/lib/api';

function makeBinding(overrides: Partial<ScoutBinding> = {}): ScoutBinding {
  return {
    provider: 'startgg',
    startggUserSlug: 'user/abc',
    displayTag: 'Alpha',
    method: 'matchHistory',
    confirmedAt: 1,
    ...overrides,
  };
}

function makeJob(overrides: Partial<PrepReportJobStatusEntry> = {}): PrepReportJobStatusEntry {
  return {
    opponentName: 'Alpha',
    jobId: 'job-1',
    status: 'queued',
    updatedAt: 1,
    ...overrides,
  };
}

function Probe() {
  const [params] = useSearchParams();
  return <div data-testid="search-params">{params.toString()}</div>;
}

function renderCard(
  props: {
    entryKey?: string;
    likelyOpponents?: PrepPresenceMap;
    scoutBindings?: ScoutBindingMap;
  } = {},
  options: { strictMode?: boolean; initialEntries?: string[] } = {},
) {
  const merged = {
    entryKey: 'entry-1',
    likelyOpponents: {} as PrepPresenceMap,
    scoutBindings: {} as ScoutBindingMap,
    ...props,
  };
  const card = <PrepPaidReportsCard {...merged} />;
  return render(
    <MemoryRouter initialEntries={options.initialEntries ?? ['/tournaments/entry-1/prep']}>
      <Probe />
      {options.strictMode ? <StrictMode>{card}</StrictMode> : card}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  jobsByOpponentName = {};
  creditsResult = {
    data: {
      freeAccess: false,
      balance: 5,
      packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
    },
    refetch: vi.fn(),
  };
  useIsDemoAccount.mockReturnValue(false);
});

describe('PrepPaidReportsCard', () => {
  it('renders the empty state with zero curated opponents — no purchase affordance, no bundle row', () => {
    renderCard({ likelyOpponents: {} });
    expect(screen.getByText('Add likely opponents to get reports')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get all three/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get report/ })).not.toBeInTheDocument();
  });

  it('renders opponents in the same alphabetical order LikelyOpponentsCard uses', () => {
    renderCard({ likelyOpponents: { zeta: true, alpha: true } });
    const names = screen.getAllByText(/^(alpha|zeta)$/);
    expect(names.map((el) => el.textContent)).toEqual(['alpha', 'zeta']);
  });

  it('shows the confirm-player affordance and NO purchase CTA for an unconfirmed opponent', () => {
    renderCard({ likelyOpponents: { Rival: true }, scoutBindings: {} });
    expect(screen.getByTestId('binding-Rival')).toHaveTextContent('unconfirmed:Rival');
    expect(screen.queryByRole('button', { name: /Get report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows a bundle checkbox and single-purchase button for a confirmed opponent with no job', () => {
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });
    expect(
      screen.getByRole('checkbox', { name: 'Include Rival in the 3-opponent bundle' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get report — 1 credit/ })).toBeInTheDocument();
  });

  it('shows the status badge and neither a purchase button nor a checkbox for a queued/running job', () => {
    jobsByOpponentName = { Rival: makeJob({ opponentName: 'Rival', status: 'queued' }) };
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    jobsByOpponentName = { Rival: makeJob({ opponentName: 'Rival', status: 'running' }) };
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });
    expect(screen.getByText('Generating…')).toBeInTheDocument();
  });

  it('shows the destructive badge and pending-refund copy for a failed job', () => {
    jobsByOpponentName = { Rival: makeJob({ opponentName: 'Rival', status: 'failed' }) };
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });
    expect(screen.getByText('Failed — refunding your credit…')).toBeInTheDocument();
  });

  it('shows the muted refunded badge AND restores the purchase button and checkbox', () => {
    jobsByOpponentName = { Rival: makeJob({ opponentName: 'Rival', status: 'refunded' }) };
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });
    expect(screen.getByText('Failed — your credit was refunded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get report — 1 credit/ })).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Include Rival in the 3-opponent bundle' }),
    ).toBeInTheDocument();
  });

  it('shows the ready badge plus a view-report toggle for a succeeded job, expanding the existing report viewer', async () => {
    const user = userEvent.setup();
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'succeeded', resultRef: 'report-1' }),
    };
    reportsGetSpy.mockResolvedValue({ id: 'report-1' } as ScoutReportRecord);
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    const viewButton = screen.getByRole('button', { name: 'View report' });
    await user.click(viewButton);

    expect(reportsGetSpy).toHaveBeenCalledWith('report-1');
    expect(await screen.findByTestId('ai-report-card')).toHaveTextContent('report-1');
    expect(screen.getByRole('button', { name: 'Hide report' })).toBeInTheDocument();
  });

  it('disables the fourth bundle-checkbox selection once three are checked (a fourth pick is impossible)', async () => {
    const user = userEvent.setup();
    const likelyOpponents: PrepPresenceMap = { A: true, B: true, C: true, D: true };
    const scoutBindings: ScoutBindingMap = {
      A: makeBinding({ displayTag: 'A' }),
      B: makeBinding({ displayTag: 'B' }),
      C: makeBinding({ displayTag: 'C' }),
      D: makeBinding({ displayTag: 'D' }),
    };
    renderCard({ likelyOpponents, scoutBindings });

    await user.click(screen.getByRole('checkbox', { name: 'Include A in the 3-opponent bundle' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include B in the 3-opponent bundle' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include C in the 3-opponent bundle' }));

    const fourth = screen.getByRole('checkbox', { name: 'Include D in the 3-opponent bundle' });
    expect(fourth).toBeDisabled();
  });

  it('enables the bundle button only when exactly three are selected', async () => {
    const user = userEvent.setup();
    const likelyOpponents: PrepPresenceMap = { A: true, B: true, C: true };
    const scoutBindings: ScoutBindingMap = {
      A: makeBinding({ displayTag: 'A' }),
      B: makeBinding({ displayTag: 'B' }),
      C: makeBinding({ displayTag: 'C' }),
    };
    renderCard({ likelyOpponents, scoutBindings });

    const bundleButton = screen.getByRole('button', { name: /Get all three — 3 credits/ });
    expect(bundleButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Include A in the 3-opponent bundle' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include B in the 3-opponent bundle' }));
    expect(bundleButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Include C in the 3-opponent bundle' }));
    expect(bundleButton).toBeEnabled();
  });

  it('states the reason inline (never a bare disabled control) with fewer than three curated opponents', () => {
    renderCard({ likelyOpponents: { A: true } });
    expect(
      screen.getByText(
        'Add 2 more likely opponents above to make the 3-opponent bundle available.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get all three/ })).toBeDisabled();
  });

  it('states the need-confirmed reason inline when three are curated but fewer than three are confirmed', () => {
    renderCard({
      likelyOpponents: { A: true, B: true, C: true },
      scoutBindings: { A: makeBinding({ displayTag: 'A' }) },
    });
    expect(
      screen.getByText('Confirm 2 more players above to make the 3-opponent bundle available.'),
    ).toBeInTheDocument();
  });

  it('fires the impression event exactly once on mount with an empty payload, safe under a Strict Mode double render', () => {
    renderCard({}, { strictMode: true });
    expect(postCanonicalEventSpy).toHaveBeenCalledTimes(1);
    expect(postCanonicalEventSpy).toHaveBeenCalledWith('prep_offer_viewed', {});
  });

  it('auto-opens the buy dialog and leaves a persistent inline hint on a payment-required purchase error', async () => {
    const user = userEvent.setup();
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });

    await user.click(screen.getByRole('button', { name: /Get report — 1 credit/ }));
    const [, callOptions] = generateMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    expect(screen.getByTestId('buy-credits-dialog')).toBeInTheDocument();
    // The sentence is split across sibling text nodes/a nested Button
    // (`{t('...')} {'Buy credits'} {t('...')}`), so match on the
    // containing element's full text rather than a single node.
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "You're out of credits. Buy credits to get this report.",
      ),
    ).toBeInTheDocument();
  });

  it('renders the submit-failed message inline for a non-payment purchase failure', async () => {
    const user = userEvent.setup();
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });

    await user.click(screen.getByRole('button', { name: /Get report — 1 credit/ }));
    const [, callOptions] = generateMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(new Error('boom'));
    });

    expect(
      screen.getByText('Something went wrong starting this report. Please try again.'),
    ).toBeInTheDocument();
  });

  it('runs the three returned child jobs through executeBundleChildren on a successful bundle purchase', async () => {
    const user = userEvent.setup();
    const likelyOpponents: PrepPresenceMap = { A: true, B: true, C: true };
    const scoutBindings: ScoutBindingMap = {
      A: makeBinding({ displayTag: 'A' }),
      B: makeBinding({ displayTag: 'B' }),
      C: makeBinding({ displayTag: 'C' }),
    };
    renderCard({ likelyOpponents, scoutBindings });

    await user.click(screen.getByRole('checkbox', { name: 'Include A in the 3-opponent bundle' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include B in the 3-opponent bundle' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include C in the 3-opponent bundle' }));
    await user.click(screen.getByRole('button', { name: /Get all three — 3 credits/ }));

    const bundleJobs = [
      { opponentName: 'A', jobId: 'j1', slot: 1 },
      { opponentName: 'B', jobId: 'j2', slot: 2 },
      { opponentName: 'C', jobId: 'j3', slot: 3 },
    ];
    const [, callOptions] = startBundleMutateSpy.mock.calls[0]!;
    act(() => {
      (
        callOptions as { onSuccess: (data: { bundleId: string; jobs: typeof bundleJobs }) => void }
      ).onSuccess({ bundleId: 'bundle-1', jobs: bundleJobs });
    });

    expect(executeBundleChildrenSpy).toHaveBeenCalledWith(generateMutateAsyncSpy, bundleJobs);
  });

  it('toasts the payment-received message, re-polls the balance, and strips the query parameter on a successful checkout return', async () => {
    vi.useFakeTimers();
    try {
      renderCard({}, { initialEntries: ['/tournaments/entry-1/prep?billing=success'] });

      expect(toastSuccess).toHaveBeenCalledWith(
        'Payment received — your report will start shortly.',
      );
      expect(screen.getByTestId('search-params')).toHaveTextContent('');

      act(() => {
        vi.advanceTimersByTime(2000 * 5);
      });
      expect(creditsResult.refetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toasts the cancelled message and strips the query parameter on a cancelled checkout return', () => {
    renderCard({}, { initialEntries: ['/tournaments/entry-1/prep?billing=cancelled'] });
    expect(toastPlain).toHaveBeenCalledWith('Checkout cancelled.');
    expect(screen.getByTestId('search-params')).toHaveTextContent('');
  });
});

// Phase 30.3 (Gate 6, owner/Codex hard gate): no Buy Credits control
// anywhere it renders, for a demo/research account — the dialog mount and
// the inline insufficient-credits "Buy credits" link both gate on
// `canBuyCredits`, which folds in `!isDemoAccount`.
describe('PrepPaidReportsCard — demo account gating', () => {
  it('never renders BuyCreditsDialog for a demo account, even after a 402', async () => {
    useIsDemoAccount.mockReturnValue(true);
    const user = userEvent.setup();
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });

    await user.click(screen.getByRole('button', { name: /Get report — 1 credit/ }));
    const [, callOptions] = generateMutateSpy.mock.calls[0]!;
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
    renderCard({
      likelyOpponents: { Rival: true },
      scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
    });

    await user.click(screen.getByRole('button', { name: /Get report — 1 credit/ }));
    const [, callOptions] = generateMutateSpy.mock.calls[0]!;
    act(() => {
      (callOptions as { onError: (error: unknown) => void }).onError(
        new ApiError(402, 'payment required'),
      );
    });

    expect(screen.getByTestId('buy-credits-dialog')).toBeInTheDocument();
  });
});

/**
 * Plan 39-10 (D-21, review C4-M2): the validation caption under the job-status
 * badge — a CAUSE sentence keyed on `failureReason === 'validation'` (an
 * allowlist of one) and a separate RETURN clause keyed on the terminal
 * `refunded` status AND a loaded `freeAccess === false` credits read.
 *
 * The fixtures are the two terminal shapes `failJob` actually writes (plans
 * 39-07/39-08 prove them on the FINAL record): a SPENT prep job's second,
 * authoritative `.set()` is `status: 'refunded'` carrying the cause (C1-H1);
 * a ZERO-SPEND free-access prep job never gets that write (it is gated on
 * `reason && (spent || reason === 'post_event_synthesis')`) and rests at
 * `status: 'failed'` with no refund at all.
 */
describe('PrepPaidReportsCard — validation-failure caption (plan 39-10, D-21)', () => {
  const CAUSE = "There isn't enough match evidence yet to build a verified report.";
  const RETURN = 'Your credit was returned.';
  const RIVAL = {
    likelyOpponents: { Rival: true } as PrepPresenceMap,
    scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
  };

  function caption(): HTMLElement | null {
    return document.querySelector('[data-validation-caption]');
  }

  it('C1-H1: a SPENT job at the refunded terminal with failureReason validation renders BOTH clauses, cause then return, matched exactly', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'refunded', failureReason: 'validation' }),
    };
    renderCard(RIVAL);
    const rendered = caption();
    expect(rendered).not.toBeNull();
    const spans = Array.from(rendered!.querySelectorAll('span')).map((span) => span.textContent);
    expect(spans).toEqual([CAUSE, RETURN]);
    expect(rendered!.textContent).toBe(`${CAUSE}${RETURN}`);
    // It sits under the existing refunded badge, which keeps its own wording.
    expect(screen.getByText('Failed — your credit was refunded.')).toBeInTheDocument();
  });

  it('C4-M2: the ZERO-SPEND allowlisted prep job (terminal failed, failureReason validation, no refund ever) renders the cause and NOT the return clause', () => {
    // Free-access uid: `spent` was false, so failJob never wrote `refunded`
    // and refundCredit never ran. The one case this status rule alone would
    // still overstate — a zero-spend post_event_synthesis failure, which DOES
    // rest at `refunded` with no refund (Phase 28 CR-02) and carries no spend
    // fact on the record — is closed on that card by the freeAccess check.
    creditsResult = { data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() };
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', failureReason: 'validation' }),
    };
    renderCard(RIVAL);
    expect(caption()).toHaveTextContent(CAUSE);
    expect(caption()!.textContent).toBe(CAUSE);
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
    expect(document.querySelector('[data-validation-caption-return]')).toBeNull();
  });

  it('a failed (not yet refunded) validation job renders the cause only, even for a billable viewer', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', failureReason: 'validation' }),
    };
    renderCard(RIVAL);
    expect(caption()!.textContent).toBe(CAUSE);
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
  });

  it('the return clause is withheld when the viewer is free-access, and while the credits read has not loaded', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'refunded', failureReason: 'validation' }),
    };
    creditsResult = { data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() };
    const { unmount } = renderCard(RIVAL);
    expect(caption()!.textContent).toBe(CAUSE);
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
    unmount();

    creditsResult = { data: undefined, refetch: vi.fn() };
    renderCard(RIVAL);
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
      jobsByOpponentName = {
        Rival: makeJob({ opponentName: 'Rival', status, failureReason }),
      };
      const { unmount } = renderCard(RIVAL);
      expect(caption()).toBeNull();
      expect(screen.queryByText(CAUSE)).not.toBeInTheDocument();
      expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('a bundle with several failed children renders one caption per child row', () => {
    jobsByOpponentName = {
      Alpha: makeJob({
        opponentName: 'Alpha',
        jobId: 'a',
        status: 'refunded',
        failureReason: 'validation',
      }),
      Bravo: makeJob({
        opponentName: 'Bravo',
        jobId: 'b',
        status: 'failed',
        failureReason: 'validation',
      }),
      Charlie: makeJob({
        opponentName: 'Charlie',
        jobId: 'c',
        status: 'refunded',
        failureReason: 'validation',
      }),
    };
    renderCard({
      likelyOpponents: { Alpha: true, Bravo: true, Charlie: true },
      scoutBindings: {
        Alpha: makeBinding({ displayTag: 'Alpha' }),
        Bravo: makeBinding({ displayTag: 'Bravo' }),
        Charlie: makeBinding({ displayTag: 'Charlie' }),
      },
    });
    const captions = document.querySelectorAll('[data-validation-caption]');
    expect(captions).toHaveLength(3);
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      const row = screen.getByText(name).closest('.rounded-md.border');
      expect(row?.querySelectorAll('[data-validation-caption]')).toHaveLength(1);
    }
    // Refund clause on exactly the two refunded children, never on the failed one.
    expect(document.querySelectorAll('[data-validation-caption-return]')).toHaveLength(2);
  });

  it('the caption carries no amount and no digit in either shape (D-21)', () => {
    for (const status of ['failed', 'refunded'] as const) {
      jobsByOpponentName = {
        Rival: makeJob({ opponentName: 'Rival', status, failureReason: 'validation' }),
      };
      const { unmount } = renderCard(RIVAL);
      expect(caption()!.textContent).not.toMatch(/\p{Nd}/u);
      unmount();
    }
  });
});

/**
 * Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25) — LIVE BUG: the
 * v2.5 status badges said "refunding your credit" / "your credit was
 * refunded" on free-access jobs that were never charged. Refund wording now
 * renders only when the job was actually charged: the job's own `wasCharged`
 * decides when present (even if the viewer's free-access status changed
 * later); an older job without it falls back to the loaded credits read; and
 * an unknown charge says only "Failed". Each badge is ONE i18n string.
 */
describe('PrepPaidReportsCard — honest failure badge (post-plan fix 39-10)', () => {
  const RIVAL = {
    likelyOpponents: { Rival: true } as PrepPresenceMap,
    scoutBindings: { Rival: makeBinding({ displayTag: 'Rival' }) },
  };
  const PENDING_REFUND = 'Failed — refunding your credit…';
  const REFUNDED = 'Failed — your credit was refunded.';
  const NO_CHARGE = 'Failed — no credit was used.';
  const CHARGE_UNKNOWN = 'Failed';
  const RETURN = 'Your credit was returned.';
  const FREE_ACCESS = { data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() };

  function expectNoRefundWording() {
    expect(screen.queryByText(PENDING_REFUND)).not.toBeInTheDocument();
    expect(screen.queryByText(REFUNDED)).not.toBeInTheDocument();
    expect(screen.queryByText(RETURN)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/refund/i);
  }

  it('paid, refunded (wasCharged true): the refunded badge AND the caption return clause', () => {
    jobsByOpponentName = {
      Rival: makeJob({
        opponentName: 'Rival',
        status: 'refunded',
        failureReason: 'validation',
        wasCharged: true,
      }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(REFUNDED)).toBeInTheDocument();
    expect(screen.getByText(RETURN)).toBeInTheDocument();
  });

  it('paid, failed (wasCharged true): the pending-refund badge', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', wasCharged: true }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(PENDING_REFUND)).toBeInTheDocument();
  });

  it('THE LIVE BUG — free-access viewer, older job (no wasCharged), failed: "no credit was used", no refund wording anywhere', () => {
    creditsResult = FREE_ACCESS;
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', failureReason: 'validation' }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('wasCharged false on a failed job: "no credit was used" even for a billable viewer', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', wasCharged: false }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('STATUS CHANGED LATER — charged while billable, viewer now free-access: wasCharged true beats the current freeAccess read', () => {
    creditsResult = FREE_ACCESS;
    jobsByOpponentName = {
      Rival: makeJob({
        opponentName: 'Rival',
        status: 'refunded',
        failureReason: 'validation',
        wasCharged: true,
      }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(REFUNDED)).toBeInTheDocument();
    expect(screen.getByText(RETURN)).toBeInTheDocument();
    expect(screen.queryByText(NO_CHARGE)).not.toBeInTheDocument();
  });

  it('STATUS CHANGED LATER — ran free, viewer now billable: wasCharged false beats the current freeAccess read', () => {
    jobsByOpponentName = {
      Rival: makeJob({
        opponentName: 'Rival',
        status: 'failed',
        failureReason: 'validation',
        wasCharged: false,
      }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(NO_CHARGE)).toBeInTheDocument();
    expectNoRefundWording();
  });

  it('unknown charge (no wasCharged, credits not loaded): a plain "Failed" — never refund wording, never a no-charge claim', () => {
    creditsResult = { data: undefined, refetch: vi.fn() };
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed' }),
    };
    renderCard(RIVAL);
    expect(screen.getByText(CHARGE_UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByText(NO_CHARGE)).not.toBeInTheDocument();
    expectNoRefundWording();
  });

  it('each badge is ONE translated string (no concatenation): the badge element text equals the whole key value', () => {
    jobsByOpponentName = {
      Rival: makeJob({ opponentName: 'Rival', status: 'failed', wasCharged: false }),
    };
    renderCard(RIVAL);
    const badge = screen.getByText(NO_CHARGE);
    expect(badge.textContent).toBe(NO_CHARGE);
    expect(badge.childElementCount).toBe(0);
  });
});
