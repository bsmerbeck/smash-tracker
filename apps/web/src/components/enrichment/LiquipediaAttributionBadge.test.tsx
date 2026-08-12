import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResearchEnrichmentAttributionEntry } from '@smash-tracker/shared';
import { LiquipediaAttributionBadge, LiquipediaLicenseNote } from './LiquipediaAttributionBadge';

function makeAttribution(
  overrides: Partial<ResearchEnrichmentAttributionEntry> = {},
): ResearchEnrichmentAttributionEntry {
  return {
    matchKey: 'match-1',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 535578,
    ...overrides,
  };
}

describe('LiquipediaAttributionBadge', () => {
  it('renders nothing when no attribution record is supplied', () => {
    const { container } = render(<LiquipediaAttributionBadge attribution={null} variant="stage" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a distinct label for a stage source', () => {
    render(<LiquipediaAttributionBadge attribution={makeAttribution()} variant="stage" />);
    expect(screen.getByText('Stage data from Liquipedia')).toBeInTheDocument();
  });

  it('renders a distinct label for a VOD source', () => {
    render(<LiquipediaAttributionBadge attribution={makeAttribution()} variant="vod" />);
    expect(screen.getByText('VOD from Liquipedia')).toBeInTheDocument();
  });

  it('renders an anchor whose href is EXACTLY the stored source page URL and opens in a new tab with no-opener no-referrer', () => {
    const distinctiveUrl = 'https://liquipedia.net/smash/Some/Distinctive_Page_Title';
    render(
      <LiquipediaAttributionBadge
        attribution={makeAttribution({ sourcePageUrl: distinctiveUrl })}
        variant="stage"
      />,
    );
    const anchor = screen.getByTestId('liquipedia-attribution-link');
    expect(anchor).toHaveAttribute('href', distinctiveUrl);
    expect(anchor).toHaveAttribute('target', '_blank');
    const rel = anchor.getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('renders no anchor when no source page URL is present', () => {
    render(
      <LiquipediaAttributionBadge
        attribution={makeAttribution({ sourcePageUrl: undefined })}
        variant="stage"
      />,
    );
    expect(screen.queryByTestId('liquipedia-attribution-link')).not.toBeInTheDocument();
  });

  it('renders the hazardless qualifier (including the raw source stage text) for a hazardless stage form', () => {
    render(
      <LiquipediaAttributionBadge
        attribution={makeAttribution({ rawStage: 'Φ Town and City', stageForm: 'hazardless' })}
        variant="stage"
      />,
    );
    const qualifier = screen.getByTestId('liquipedia-attribution-qualifier');
    expect(qualifier.textContent).toContain('Φ Town and City');
  });

  it('does not render a qualifier for the unstated normal stage form', () => {
    render(
      <LiquipediaAttributionBadge
        attribution={makeAttribution({ rawStage: 'Battlefield', stageForm: 'normal' })}
        variant="stage"
      />,
    );
    expect(screen.queryByTestId('liquipedia-attribution-qualifier')).not.toBeInTheDocument();
  });

  it('never renders any value as markup', () => {
    render(
      <LiquipediaAttributionBadge
        attribution={makeAttribution({
          rawStage: '<img src=x onerror=alert(1)>',
          stageForm: 'hazardless',
        })}
        variant="stage"
      />,
    );
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('liquipedia-attribution-qualifier').textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('LiquipediaLicenseNote', () => {
  it('renders the licence line with a link to the CC BY-SA deed', () => {
    render(<LiquipediaLicenseNote />);
    const link = screen.getByRole('link', { name: 'CC BY-SA 3.0' });
    expect(link).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/3.0/');
    const rel = link.getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });
});
