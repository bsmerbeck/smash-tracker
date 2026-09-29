import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
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

  // Plan 39.1-50 (orchestrator addition OOS-40-A): the steady dash and its
  // text are ONE flex item, top-aligned, so a wrapping door (or a text that
  // wraps onto two lines) never strands the dash on a line of its own or
  // centres it between the text's lines. guard:layout's insight-line-dash
  // family proves the same in a real browser at 1440 and 390.
  it.each([false, true])(
    'steady (door=%s): the dash and its text share one top-aligned body group, the door its own item',
    (withDoor) => {
      const { container } = render(
        <MemoryRouter>
          <InsightLine
            text="Setting — no notable online/offline gap (54% vs 59%)."
            tone="steady"
            door={withDoor ? <Link to="/x">See the 265 games</Link> : undefined}
          />
        </MemoryRouter>,
      );
      const line = container.querySelector('[data-slot="insight-line"]')!;
      const svg = line.querySelector('svg')!;
      const text = line.querySelector('[data-slot="insight-line-text"]')!;
      const body = svg.parentElement!;
      expect(body).toHaveAttribute('data-slot', 'insight-line-body');
      expect(text.parentElement).toBe(body);
      expect(body.parentElement).toBe(line);
      expect(body.className).toMatch(/\bitems-start\b/);
      expect(body.className).toMatch(/\bmin-w-0\b/);
      const items = Array.from(line.children).map((el) => el.getAttribute('data-slot'));
      expect(items).toEqual(
        withDoor ? ['insight-line-body', 'insight-line-door'] : ['insight-line-body'],
      );
    },
  );

  describe('T-39.1-27 (gap closure): an optional single door', () => {
    it('with a door node, renders exactly one link inside [data-slot="insight-line-door"], in both tones', () => {
      const door = <a href="/foo?claim=settingGap#games">See the 3 games</a>;

      const { container: steadyContainer } = render(
        <InsightLine text="steady text" tone="steady" door={door} />,
      );
      const steadyDoorSlot = steadyContainer.querySelector('[data-slot="insight-line-door"]');
      expect(steadyDoorSlot).not.toBeNull();
      expect(steadyDoorSlot!.querySelectorAll('a').length).toBe(1);

      const { container: notableContainer } = render(
        <InsightLine text="notable text" tone="notable" chip={<span>chip</span>} door={door} />,
      );
      const notableDoorSlot = notableContainer.querySelector('[data-slot="insight-line-door"]');
      expect(notableDoorSlot).not.toBeNull();
      expect(notableDoorSlot!.querySelectorAll('a').length).toBe(1);
    });

    it('with no door, the rendered markup carries no door slot and no flex-wrap class (byte-identical to the no-door render)', () => {
      const { container: steadyContainer } = render(
        <InsightLine text="steady text" tone="steady" />,
      );
      expect(steadyContainer.querySelector('[data-slot="insight-line-door"]')).toBeNull();
      const steadyLine = steadyContainer.querySelector('[data-slot="insight-line"]')!;
      expect(steadyLine.className).not.toMatch(/flex-wrap/);

      const { container: notableContainer } = render(
        <InsightLine text="notable text" tone="notable" chip={<span>chip</span>} />,
      );
      expect(notableContainer.querySelector('[data-slot="insight-line-door"]')).toBeNull();
      const notableLine = notableContainer.querySelector('[data-slot="insight-line"]')!;
      expect(notableLine.className).not.toMatch(/flex-wrap/);
    });
  });
});

describe('InsightLine door link tone (plan 39.1-39, UI-SPEC §4.3)', () => {
  it.each(['steady', 'notable'] as const)(
    '%s tone: the non-primary door reads in the muted link tone, never brand red',
    (tone) => {
      render(
        <InsightLine
          text="line"
          tone={tone}
          chip={<span>chip</span>}
          door={<a href="/games">See the 3 games</a>}
        />,
      );
      const classes = screen.getByRole('link', { name: 'See the 3 games' }).className.split(/\s+/);
      expect(classes).toContain('text-muted-foreground');
      expect(classes).toContain('hover:text-foreground');
      expect(classes).not.toContain('text-primary');
    },
  );
});
