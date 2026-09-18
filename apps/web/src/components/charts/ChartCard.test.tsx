import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartCard } from './ChartCard';

describe('ChartCard', () => {
  it('renders the abstention sentence and none of its children when abstained', () => {
    render(
      <ChartCard title="Win Rate Trend" abstained={{ gamesNeeded: 2 }}>
        <div data-testid="chart-body">chart</div>
      </ChartCard>,
    );
    expect(screen.getByText(/2/)).toBeInTheDocument();
    expect(screen.queryByTestId('chart-body')).not.toBeInTheDocument();
  });

  it('renders exactly one CardDescription and its children when not abstained', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" caption="Recorded fact from your match log.">
        <div data-testid="chart-body">chart</div>
      </ChartCard>,
    );
    expect(container.querySelectorAll('[data-slot="card-description"]')).toHaveLength(1);
    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });

  it('renders the header-right slot as a CardAction', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" headerRight={<span data-testid="cue">3 games</span>}>
        <div>chart</div>
      </ChartCard>,
    );
    expect(container.querySelector('[data-slot="card-action"]')).toBeInTheDocument();
    expect(screen.getByTestId('cue')).toBeInTheDocument();
  });
});
