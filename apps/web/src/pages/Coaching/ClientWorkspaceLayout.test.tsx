import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ClientWorkspaceLayout } from './ClientWorkspaceLayout';

const useResearchSubject = vi.fn();

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
}));

/**
 * Plan 30-06: `ClientWorkspaceLayout` now also mounts `DataCoveragePanel`.
 * This suite's own scope is the banner/pending/error affordances and the
 * outlet-withholding gate — `DataCoveragePanel`'s own content is covered by
 * `DataCoveragePanel.test.tsx` — so the panel is mocked to render nothing,
 * exactly as it would on an `isResearch: false` resolution, keeping this
 * file's pre-existing assertions unaffected and avoiding a `QueryClientProvider`
 * dependency this file has no other reason to carry.
 */
vi.mock('./components/DataCoveragePanel', () => ({
  DataCoveragePanel: () => null,
}));

/**
 * 30.2 gap-closure: `EnrichmentReviewPanel` is mounted by this layout too,
 * and — unlike the coverage panel — is rendered here FOR REAL so the mount
 * itself is under test. Only its data hooks are mocked, exactly as
 * `EnrichmentReviewPanel.test.tsx` does, so this file needs no
 * `QueryClientProvider`.
 */
const useEnrichmentReview = vi.fn();

vi.mock('@/hooks/useEnrichmentReview', () => ({
  useEnrichmentReview: () => useEnrichmentReview(),
  useConfirmEnrichmentCandidate: () => ({ mutate: vi.fn(), isPending: false }),
}));

const REVIEW_STATUS_HIDDEN = {
  isResearch: false,
  isPending: false,
  isError: false,
  isForbidden: false,
  data: null,
  retry: vi.fn(),
};

beforeEach(() => {
  useEnrichmentReview.mockReturnValue(REVIEW_STATUS_HIDDEN);
});

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/coach/tetra/overview']}>
      <Routes>
        <Route path="/coach/:clientId" element={<ClientWorkspaceLayout />}>
          <Route path="overview" element={<div>workspace content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ClientWorkspaceLayout', () => {
  it('mounts the banner exactly once for a research subject, alongside the outlet content', () => {
    useResearchSubject.mockReturnValue({
      isResearch: true,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.getAllByTestId('research-snapshot-banner')).toHaveLength(1);
    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('renders no banner and unchanged content for an ordinary subject', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();
    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('withholds page content while the kind lookup is pending, and renders the loading affordance instead', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: true,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders the outlet once the kind resolves', () => {
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });

    renderLayout();

    expect(screen.getByText('workspace content')).toBeInTheDocument();
  });

  it('renders a localized error affordance with a retry control and no page content on a failed kind lookup', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: true,
      retry,
    });

    renderLayout();

    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    expect(screen.getByTestId('research-kind-load-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't verify this workspace")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // 30.2 gap-closure: the enrichment review queue's mount ------------------

  describe('EnrichmentReviewPanel mount', () => {
    function resolveResearchSubject() {
      useResearchSubject.mockReturnValue({
        isResearch: true,
        isPending: false,
        isError: false,
        retry: vi.fn(),
      });
    }

    it('mounts the review panel for an admin-shaped queue response', () => {
      resolveResearchSubject();
      useEnrichmentReview.mockReturnValue({
        ...REVIEW_STATUS_HIDDEN,
        isResearch: true,
        data: {
          observations: [],
          counts: { ambiguous: 0, conflicting: 0, unmatched: 0, total: 0 },
        },
      });

      renderLayout();

      expect(screen.getByTestId('enrichment-review-panel')).toBeInTheDocument();
      expect(screen.getByText('workspace content')).toBeInTheDocument();
    });

    it('renders no review chrome when the server rejects the queue read (the research family’s uniform not-for-you rejection)', () => {
      resolveResearchSubject();
      useEnrichmentReview.mockReturnValue({
        ...REVIEW_STATUS_HIDDEN,
        isResearch: true,
        isForbidden: true,
      });

      renderLayout();

      expect(screen.queryByTestId('enrichment-review-panel')).not.toBeInTheDocument();
      // The rest of the workspace is untouched — hiding the panel is never a
      // page-level failure.
      expect(screen.getByText('workspace content')).toBeInTheDocument();
    });

    it('renders no review chrome at all on an ordinary (non-research) workspace', () => {
      useResearchSubject.mockReturnValue({
        isResearch: false,
        isPending: false,
        isError: false,
        retry: vi.fn(),
      });

      renderLayout();

      expect(screen.queryByTestId('enrichment-review-panel')).not.toBeInTheDocument();
    });
  });
});
