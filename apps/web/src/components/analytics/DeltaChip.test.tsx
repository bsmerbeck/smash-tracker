import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeltaChip, type DeltaChipState } from './DeltaChip';

const COLOR_CLASS_PATTERN = /\b(text|bg)-(win|loss|steady|primary|destructive|emerald|red)-?\d*\b/;

describe('DeltaChip', () => {
  it('up state renders a filled triangle glyph and keeps the numeric value in foreground ink', () => {
    render(
      <DeltaChip state="up" valueLabel="+7 pts" horizonLabel="last 30" ariaLabel="up 7 points" />,
    );
    const svg = document.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe('8');
    expect(svg.getAttribute('height')).toBe('8');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('path')).not.toBeNull();

    const valueNode = screen.getByText('+7 pts');
    expect(valueNode.className).not.toMatch(COLOR_CLASS_PATTERN);
  });

  it('down state renders a filled triangle glyph and keeps the numeric value in foreground ink', () => {
    render(
      <DeltaChip
        state="down"
        valueLabel="−7 pts"
        horizonLabel="last 30"
        ariaLabel="down 7 points"
      />,
    );
    const svg = document.querySelector('svg')!;
    expect(svg.querySelector('path')).not.toBeNull();
    const valueNode = screen.getByText('−7 pts');
    expect(valueNode.className).not.toMatch(COLOR_CLASS_PATTERN);
  });

  it('steady state renders a flat bar glyph', () => {
    render(
      <DeltaChip state="steady" valueLabel="steady" horizonLabel="last 30" ariaLabel="steady" />,
    );
    const svg = document.querySelector('svg')!;
    expect(svg.querySelector('rect')).not.toBeNull();
  });

  it('thin state renders a hollow circle glyph', () => {
    render(
      <DeltaChip
        state="thin"
        valueLabel="5–2 · too few to call"
        horizonLabel="last 30"
        ariaLabel="thin sample"
      />,
    );
    const svg = document.querySelector('svg')!;
    const circle = svg.querySelector('circle')!;
    expect(circle).not.toBeNull();
    expect(circle.getAttribute('fill')).toBe('none');
  });

  it('none state renders a hollow circle glyph', () => {
    render(
      <DeltaChip
        state="none"
        valueLabel="1 games · last 30"
        horizonLabel="last 30"
        ariaLabel="no games"
      />,
    );
    const svg = document.querySelector('svg')!;
    const circle = svg.querySelector('circle')!;
    expect(circle).not.toBeNull();
    expect(circle.getAttribute('fill')).toBe('none');
  });

  it('collapsed state renders nothing at all', () => {
    const { container } = render(
      <DeltaChip state="collapsed" valueLabel="+7 pts" horizonLabel="last 30" ariaLabel="hidden" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('no state renders a text glyph character in the chip text content', () => {
    const states: DeltaChipState[] = ['up', 'down', 'steady', 'thin', 'none'];
    for (const state of states) {
      const { container, unmount } = render(
        <DeltaChip
          state={state}
          valueLabel="7 pts"
          horizonLabel="last 30"
          ariaLabel={`state ${state}`}
        />,
      );
      expect(container.textContent).not.toMatch(/[▲▼●○•]/);
      unmount();
    }
  });

  it('renders tabIndex 0 and the aria label on the chip root', () => {
    render(
      <DeltaChip state="up" valueLabel="+7 pts" horizonLabel="last 30" ariaLabel="up seven" />,
    );
    const root = screen.getByLabelText('up seven');
    expect(root.getAttribute('tabindex')).toBe('0');
  });

  it('does not render a numeric value when neither horizonLabel nor horizonOwnedByParent is given', () => {
    const { container } = render(<DeltaChip state="up" valueLabel="+7 pts" ariaLabel="bare" />);
    expect(container.textContent).not.toContain('+7 pts');
  });

  it('renders the value when horizonOwnedByParent is set, even without its own horizonLabel', () => {
    render(<DeltaChip state="up" valueLabel="+7 pts" horizonOwnedByParent ariaLabel="owned" />);
    expect(screen.getByText('+7 pts')).toBeInTheDocument();
  });
});
