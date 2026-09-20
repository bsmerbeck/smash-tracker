import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InsightLine } from './InsightLine';

describe('InsightLine', () => {
  it('steady tone renders one muted body line led by a decorative 8x2 bar glyph, with no card chrome', () => {
    const { container } = render(<InsightLine text="No other notable change." tone="steady" />);

    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('8');
    expect(svg.getAttribute('height')).toBe('2');

    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(screen.getByText('No other notable change.')).toBeInTheDocument();
  });

  it('notable tone renders at the verdict role with the chip node instead of the bar glyph', () => {
    render(
      <InsightLine text="Trend text" chip={<span data-testid="chip">chip</span>} tone="notable" />,
    );

    const line = screen.getByText('Trend text').closest('[data-slot="insight-line"]')!;
    expect(line.querySelector('svg')).toBeNull();
    expect(line.querySelector('[data-testid="chip"]')).not.toBeNull();
    expect(line.className).toContain('font-medium');
  });

  it('carries no doors and no dismiss control in either tone', () => {
    const { container: steadyContainer } = render(<InsightLine text="steady text" tone="steady" />);
    const { container: notableContainer } = render(
      <InsightLine text="notable text" tone="notable" chip={<span>chip</span>} />,
    );
    expect(steadyContainer.querySelector('button')).toBeNull();
    expect(notableContainer.querySelector('button')).toBeNull();
  });
});
