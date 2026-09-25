import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CohortComposition, SampleMeta, UnknownBucket } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SampleCue, SampleCueGlyph, UnknownRow, MixedContextBadge } from './EvidenceCues';

function makeSample(overrides: Partial<SampleMeta> = {}): SampleMeta {
  return {
    rawSampleSize: 12,
    eligibleDenominator: 12,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt: 0,
    evidencePolicyVersion: 1,
    recencyTreatment: 'unweighted',
    confidenceTier: 'medium',
    ...overrides,
  };
}

function makeCohort(overrides: Partial<CohortComposition> = {}): CohortComposition {
  return {
    online: 0,
    offline: 0,
    unspecified: 0,
    manual: 0,
    startgg: 0,
    parrygg: 0,
    mixedContext: false,
    minorityShare: 0,
    minorityLabel: null,
    majorityLabel: null,
    ...overrides,
  };
}

describe('SampleCue', () => {
  it('renders the count and confidence tier via a whole re-keyed sentence (medium, plural)', () => {
    render(
      <SampleCue sample={makeSample({ eligibleDenominator: 12, confidenceTier: 'medium' })} />,
    );
    expect(screen.getByText(/12 games/)).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/)).toBeInTheDocument();
  });

  it('selects the singular plural pair at count 1 (UI-SPEC §9.2 rule 8)', () => {
    render(<SampleCue sample={makeSample({ eligibleDenominator: 1, confidenceTier: 'low' })} />);
    expect(screen.getByText('1 game · low confidence')).toBeInTheDocument();
  });

  it('selects the high-tier whole sentence (plural) for a large count', () => {
    render(
      <SampleCue sample={makeSample({ eligibleDenominator: 4564, confidenceTier: 'high' })} />,
    );
    expect(screen.getByText('4564 games · high confidence')).toBeInTheDocument();
  });

  it('renders nothing below the abstention floor (no confidence tier)', () => {
    const { container } = render(<SampleCue sample={makeSample({ confidenceTier: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SampleCueGlyph', () => {
  it('renders the dot indicator for each tier with a whole-sentence accessible label', () => {
    const { rerender } = render(
      <SampleCueGlyph sample={makeSample({ eligibleDenominator: 5, confidenceTier: 'low' })} />,
    );
    expect(screen.getByRole('img', { name: 'low confidence, 5 games' })).toHaveTextContent('●○○');

    rerender(
      <SampleCueGlyph sample={makeSample({ eligibleDenominator: 12, confidenceTier: 'medium' })} />,
    );
    expect(screen.getByRole('img', { name: 'medium confidence, 12 games' })).toHaveTextContent(
      '●●○',
    );

    rerender(
      <SampleCueGlyph sample={makeSample({ eligibleDenominator: 4564, confidenceTier: 'high' })} />,
    );
    expect(screen.getByRole('img', { name: 'high confidence, 4564 games' })).toHaveTextContent(
      '●●●',
    );
  });

  it('selects the singular plural pair at count 1', () => {
    render(
      <SampleCueGlyph sample={makeSample({ eligibleDenominator: 1, confidenceTier: 'low' })} />,
    );
    expect(screen.getByRole('img', { name: 'low confidence, 1 game' })).toBeInTheDocument();
  });

  it('renders nothing below the abstention floor (no confidence tier)', () => {
    const { container } = render(<SampleCueGlyph sample={makeSample({ confidenceTier: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UnknownRow', () => {
  it('renders nothing for a null bucket', () => {
    const { container } = render(<UnknownRow bucket={null} as="li" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the singular copy for a bucket of exactly one game (as="li")', () => {
    const bucket: UnknownBucket = { games: 1, wins: 1, losses: 0 };
    render(
      <ul>
        <UnknownRow bucket={bucket} as="li" />
      </ul>,
    );
    expect(screen.getByText('Unknown (1 game, excluded)')).toBeInTheDocument();
  });

  it('renders the plural copy for a multi-game bucket (as="tr")', () => {
    const bucket: UnknownBucket = { games: 3, wins: 1, losses: 2 };
    render(
      <table>
        <tbody>
          <UnknownRow bucket={bucket} as="tr" />
        </tbody>
      </table>,
    );
    expect(screen.getByText('Unknown (3 games, excluded)')).toBeInTheDocument();
  });
});

describe('MixedContextBadge', () => {
  function renderBadge(cohort: CohortComposition) {
    return render(
      <TooltipProvider>
        <MixedContextBadge cohort={cohort} />
      </TooltipProvider>,
    );
  }

  it('renders nothing when mixedContext is false', () => {
    const { container } = renderBadge(makeCohort({ mixedContext: false }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders exactly one outline badge when mixedContext is true', () => {
    renderBadge(
      makeCohort({
        mixedContext: true,
        minorityShare: 0.3,
        minorityLabel: 'manual',
        majorityLabel: 'startgg',
      }),
    );
    const badge = screen.getByText('Mixed context');
    expect(badge).toHaveAttribute('data-variant', 'outline');
    expect(screen.getAllByText('Mixed context')).toHaveLength(1);
  });
});
