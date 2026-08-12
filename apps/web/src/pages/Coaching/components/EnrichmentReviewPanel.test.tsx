import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { EnrichmentReviewPanel } from './EnrichmentReviewPanel';

const useEnrichmentReview = vi.fn();
const mutate = vi.fn();
const useConfirmEnrichmentCandidate = vi.fn(() => ({ mutate, isPending: false }));

vi.mock('@/hooks/useEnrichmentReview', () => ({
  useEnrichmentReview: () => useEnrichmentReview(),
  useConfirmEnrichmentCandidate: () => useConfirmEnrichmentCandidate(),
}));

const BASE_STATUS = {
  isResearch: true,
  isPending: false,
  isError: false,
  isForbidden: false,
  data: null,
  retry: vi.fn(),
};

function makeObservation(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 535578,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1_770_000_000_000,
    observedAtMs: 1_770_000_000_000,
    matchingStatus: 'ambiguous',
    ...overrides,
  };
}

describe('EnrichmentReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConfirmEnrichmentCandidate.mockReturnValue({ mutate, isPending: false });
  });

  it('renders nothing when the workspace is not a research workspace', () => {
    useEnrichmentReview.mockReturnValue({ ...BASE_STATUS, isResearch: false });
    render(<EnrichmentReviewPanel />);
    expect(screen.queryByTestId('enrichment-review-panel')).not.toBeInTheDocument();
  });

  it('renders nothing while the query is pending', () => {
    useEnrichmentReview.mockReturnValue({ ...BASE_STATUS, isPending: true });
    render(<EnrichmentReviewPanel />);
    expect(screen.queryByTestId('enrichment-review-panel')).not.toBeInTheDocument();
  });

  it("renders nothing when the query reports forbidden (the research family's uniform 404)", () => {
    useEnrichmentReview.mockReturnValue({ ...BASE_STATUS, isForbidden: true });
    render(<EnrichmentReviewPanel />);
    expect(screen.queryByTestId('enrichment-review-panel')).not.toBeInTheDocument();
  });

  it('renders a localized inline error affordance, not a blank panel, on a real load failure', () => {
    useEnrichmentReview.mockReturnValue({ ...BASE_STATUS, isError: true });
    render(<EnrichmentReviewPanel />);
    expect(screen.getByTestId('enrichment-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('enrichment-review-load-error')).toBeInTheDocument();
  });

  it('renders an empty state when the queue is empty', () => {
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: { observations: [], counts: { ambiguous: 0, conflicting: 0, unmatched: 0, total: 0 } },
    });
    render(<EnrichmentReviewPanel />);
    expect(screen.getByTestId('enrichment-review-empty')).toBeInTheDocument();
  });

  it('lists an ambiguous observation with its source link, bracket key, players, raw scores, and derived-round explanation-only copy', () => {
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: {
        observations: [
          makeObservation({
            bracketKey: '8DEWBracketA r1m1',
            players: [
              { rawTag: 'Sparg0', canonicalPage: null, flag: 'mx' },
              { rawTag: 'Lui$', canonicalPage: null, flag: 'us' },
            ],
            rawScores: ['3', '2'],
            derivedRoundLabel: 'Winners Quarterfinals',
            candidateTargetSetIds: ['set-a', 'set-b'],
            resolutionReasons: ['both players matched', 'date matched'],
          }),
        ],
        counts: { ambiguous: 1, conflicting: 0, unmatched: 0, total: 1 },
      },
    });
    render(<EnrichmentReviewPanel />);

    const item = screen.getByTestId('enrichment-review-item-obs-1');
    expect(within(item).getByText('Ambiguous')).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'View source' })).toHaveAttribute(
      'href',
      'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    );
    expect(item.textContent).toContain('8DEWBracketA r1m1');
    expect(item.textContent).toContain('Sparg0');
    expect(item.textContent).toContain('Lui$');
    expect(item.textContent).toContain('3');
    expect(item.textContent).toContain('explanation only');
    expect(within(item).getByText('set-a')).toBeInTheDocument();
    expect(within(item).getByText('set-b')).toBeInTheDocument();
    expect(item.textContent).toContain('both players matched');
  });

  it('renders no-candidates copy when an unmatched observation carries no candidate target sets', () => {
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: {
        observations: [makeObservation({ observationId: 'obs-2', matchingStatus: 'unmatched' })],
        counts: { ambiguous: 0, conflicting: 0, unmatched: 1, total: 1 },
      },
    });
    render(<EnrichmentReviewPanel />);
    expect(screen.getByTestId('enrichment-review-item-obs-2-no-candidates')).toBeInTheDocument();
  });

  it('confirming a candidate calls the mutation with the selected targetSetId and removes the item from the rendered queue', async () => {
    const user = userEvent.setup();
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: {
        observations: [makeObservation({ candidateTargetSetIds: ['set-a', 'set-b'] })],
        counts: { ambiguous: 1, conflicting: 0, unmatched: 0, total: 1 },
      },
    });
    mutate.mockImplementation((_vars, options) => {
      options?.onSuccess?.();
    });
    render(<EnrichmentReviewPanel />);

    await user.click(screen.getByRole('radio', { name: 'set-b' }));
    await user.click(screen.getByRole('button', { name: 'Confirm match' }));

    expect(mutate).toHaveBeenCalledWith(
      { observationId: 'obs-1', targetSetId: 'set-b' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.queryByTestId('enrichment-review-item-obs-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('enrichment-review-empty')).toBeInTheDocument();
  });

  it('disables the confirm button until a candidate is selected', () => {
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: {
        observations: [makeObservation({ candidateTargetSetIds: ['set-a'] })],
        counts: { ambiguous: 1, conflicting: 0, unmatched: 0, total: 1 },
      },
    });
    render(<EnrichmentReviewPanel />);
    expect(screen.getByRole('button', { name: 'Confirm match' })).toBeDisabled();
  });

  it('never renders any observation value as markup', () => {
    useEnrichmentReview.mockReturnValue({
      ...BASE_STATUS,
      data: {
        observations: [makeObservation({ bracketKey: '<img src=x onerror=alert(1)>' })],
        counts: { ambiguous: 1, conflicting: 0, unmatched: 0, total: 1 },
      },
    });
    render(<EnrichmentReviewPanel />);
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('enrichment-review-item-obs-1').textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});
