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

  describe('plan 39.1-36 measurement hooks (honest-none-chip)', () => {
    it('a narrow cell wraps the horizon label under the value inside the chip instead of spilling into the next column (flex-wrap root, no fixed height)', () => {
      render(
        <DeltaChip
          state="down"
          valueLabel="\u221284"
          horizonLabel="last 30"
          ariaLabel="rating chip"
        />,
      );
      const root = screen.getByLabelText('rating chip');
      expect(root.className).toMatch(/\bflex-wrap\b/);
      expect(root.className).not.toMatch(/(^|\s)h-5(\s|$)/);
      expect(root.className).toMatch(/\bmin-h-5\b/);
    });

    it('steady / thin / none values read in muted ink, up / down in foreground ink (UI-SPEC §7.5, sketch 001-C .chip--steady)', () => {
      const cases: [DeltaChipState, string][] = [
        ['steady', 'text-muted-foreground'],
        ['thin', 'text-muted-foreground'],
        ['none', 'text-muted-foreground'],
        ['up', 'text-foreground'],
        ['down', 'text-foreground'],
      ];
      for (const [state, ink] of cases) {
        const { unmount } = render(
          <DeltaChip
            state={state}
            valueLabel={`value-${state}`}
            horizonOwnedByParent
            ariaLabel={`ink ${state}`}
          />,
        );
        expect(screen.getByText(`value-${state}`).className, state).toMatch(
          new RegExp(`(^|\\s)${ink}(\\s|$)`),
        );
        unmount();
      }
    });

    it('the root carries data-slot="delta-chip", data-state and, when given, data-recent-games', () => {
      render(
        <DeltaChip
          state="steady"
          valueLabel="Steady"
          horizonLabel="last 30"
          ariaLabel="steady chip"
          recentGames={30}
        />,
      );
      const root = screen.getByLabelText('steady chip');
      expect(root.getAttribute('data-slot')).toBe('delta-chip');
      expect(root.getAttribute('data-state')).toBe('steady');
      expect(root.getAttribute('data-recent-games')).toBe('30');
    });

    it('omits data-recent-games when the prop is not given', () => {
      render(<DeltaChip state="up" valueLabel="+7 pts" horizonOwnedByParent ariaLabel="plain" />);
      const root = screen.getByLabelText('plain');
      expect(root.getAttribute('data-state')).toBe('up');
      expect(root.hasAttribute('data-recent-games')).toBe(false);
    });

    it('none state renders the hollow circle and "· last 30" after "no games"', () => {
      render(
        <DeltaChip
          state="none"
          valueLabel="no games"
          horizonLabel="last 30"
          ariaLabel="empty window"
          recentGames={0}
        />,
      );
      const root = screen.getByLabelText('empty window');
      expect(root.getAttribute('data-state')).toBe('none');
      expect(root.querySelector('circle')!.getAttribute('fill')).toBe('none');
      expect(root.textContent).toBe('no games· last 30');
    });

    it('thin state renders the hollow circle and "n 2 · no direction" with no horizon suffix', () => {
      render(
        <DeltaChip
          state="thin"
          valueLabel="n 2 · no direction"
          horizonOwnedByParent
          ariaLabel="thin window"
          recentGames={2}
        />,
      );
      const root = screen.getByLabelText('thin window');
      expect(root.getAttribute('data-state')).toBe('thin');
      expect(root.getAttribute('data-recent-games')).toBe('2');
      expect(root.querySelector('circle')!.getAttribute('fill')).toBe('none');
      expect(root.textContent).toBe('n 2 · no direction');
    });
  });

  it('renders the value when horizonOwnedByParent is set, even without its own horizonLabel', () => {
    render(<DeltaChip state="up" valueLabel="+7 pts" horizonOwnedByParent ariaLabel="owned" />);
    expect(screen.getByText('+7 pts')).toBeInTheDocument();
  });
});
