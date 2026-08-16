import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiquipediaStockEvidence } from './LiquipediaStockEvidence';

describe('LiquipediaStockEvidence', () => {
  it('renders nothing when no stocks evidence is supplied', () => {
    const { container } = render(<LiquipediaStockEvidence stocks={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the singular form for exactly 1 stock left', () => {
    render(<LiquipediaStockEvidence stocks={{ stocksLeft: 1 }} />);
    expect(screen.getByText('1 stock left')).toBeInTheDocument();
  });

  it('renders the plural form for a stock count other than 1', () => {
    render(<LiquipediaStockEvidence stocks={{ stocksLeft: 2 }} />);
    expect(screen.getByText('2 stocks left')).toBeInTheDocument();
  });

  it('renders the plural form for a zero stock count', () => {
    render(<LiquipediaStockEvidence stocks={{ stocksLeft: 0 }} />);
    expect(screen.getByText('0 stocks left')).toBeInTheDocument();
  });

  it('renders the stocks attribution badge, clearly marked as from Liquipedia', () => {
    render(<LiquipediaStockEvidence stocks={{ stocksLeft: 2 }} />);
    expect(screen.getByText('Stock count from Liquipedia')).toBeInTheDocument();
  });
});
