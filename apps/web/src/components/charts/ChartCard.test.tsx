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

describe('ChartCard — insight slot and density (UI-SPEC §7.9, §6.2)', () => {
  it('a render passing neither the insight prop nor the density prop produces the same element structure and class list as before', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" caption="Recorded fact from your match log.">
        <div data-testid="chart-body">chart</div>
      </ChartCard>,
    );
    const card = container.querySelector('[data-slot="card"]');
    expect(card?.className).not.toMatch(/shadow-none/);
    expect(container.querySelectorAll('[data-slot="card-description"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="chart-card-insight"]')).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="chart-card-caption-footer"]'),
    ).not.toBeInTheDocument();
  });

  it('with an insight node, the rendered order is insight, plot, caption — and the caption moves out of the header CardDescription', () => {
    const { container } = render(
      <ChartCard
        title="Win Rate Trend"
        caption="Recorded fact from your match log."
        insight={<p data-testid="insight-verdict">You are trending up.</p>}
      >
        <div data-testid="chart-body">plot</div>
      </ChartCard>,
    );
    // Caption no longer renders as the header CardDescription.
    expect(container.querySelectorAll('[data-slot="card-description"]')).toHaveLength(0);
    const content = container.querySelector('[data-slot="card-content"]');
    expect(content).not.toBeNull();
    const orderedText = content!.textContent ?? '';
    const insightIndex = orderedText.indexOf('You are trending up.');
    const plotIndex = orderedText.indexOf('plot');
    const captionIndex = orderedText.indexOf('Recorded fact from your match log.');
    expect(insightIndex).toBeGreaterThanOrEqual(0);
    expect(plotIndex).toBeGreaterThan(insightIndex);
    expect(captionIndex).toBeGreaterThan(plotIndex);
    expect(screen.getByTestId('insight-verdict')).toBeInTheDocument();
  });

  it('with an insight node of null, no empty wrapper element for the slot is rendered', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" insight={null}>
        <div data-testid="chart-body">plot</div>
      </ChartCard>,
    );
    expect(container.querySelector('[data-slot="chart-card-insight"]')).not.toBeInTheDocument();
    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });

  it('with the abstention prop set AND an insight node supplied, the abstention branch renders and the insight node does not', () => {
    render(
      <ChartCard
        title="Win Rate Trend"
        abstained={{ gamesNeeded: 2 }}
        insight={<p data-testid="insight-verdict">Should not render</p>}
      >
        <div data-testid="chart-body">chart</div>
      </ChartCard>,
    );
    expect(screen.getByText(/2/)).toBeInTheDocument();
    expect(screen.queryByTestId('insight-verdict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-body')).not.toBeInTheDocument();
  });

  it('WR-B01 (39.1-REVIEW.md): renders the evidence-type caption in the footer when the card is abstained AND the insight slot is merely reserved (insight={null}) — the MatchupsPage.tsx win-rate-trend call-site pattern', () => {
    const { container } = render(
      <ChartCard
        title="Win Rate Trend"
        caption="Recorded fact from your match log."
        abstained={{ gamesNeeded: 2 }}
        insight={null}
      >
        <div data-testid="chart-body">chart</div>
      </ChartCard>,
    );
    // Header CardDescription is suppressed once an insight slot is reserved
    // (even an empty one) — the caption's only remaining home is the footer.
    expect(container.querySelectorAll('[data-slot="card-description"]')).toHaveLength(0);
    expect(container.querySelector('[data-slot="chart-card-caption-footer"]')).toBeInTheDocument();
    expect(screen.getByText('Recorded fact from your match log.')).toBeInTheDocument();
    // The abstention sentence itself still renders alongside it.
    expect(screen.getByText(/2/)).toBeInTheDocument();
  });

  it('compact density renders the 20px padding class and no shadow class; the installed card component is composed, never edited', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" density="compact">
        <div>chart</div>
      </ChartCard>,
    );
    const card = container.querySelector('[data-slot="card"]');
    expect(card?.className).toMatch(/\bsm:py-5\b/);
    expect(card?.className).toMatch(/\bshadow-none\b/);
    expect(card?.className).not.toMatch(/\bshadow-sm\b/);
  });

  it('default density (omitted or explicit) renders no shadow-none class', () => {
    const { container } = render(
      <ChartCard title="Win Rate Trend" density="default">
        <div>chart</div>
      </ChartCard>,
    );
    const card = container.querySelector('[data-slot="card"]');
    expect(card?.className).not.toMatch(/shadow-none/);
  });
});
