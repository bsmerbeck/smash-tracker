import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SegmentedControl, type SegmentedControlOption } from './SegmentedControl';

/**
 * Plan 39.1-47 (segmented-set-state, PD-47-1, sketch 003 B `.seg`): the ONE
 * segmented single-choice control, extracted from `HorizonSwitch`'s own
 * ToggleGroup markup so the advisor's Phase / Role controls and the page
 * horizon switch cannot drift into two implementations.
 */

const OPTIONS: SegmentedControlOption[] = [
  { value: 'a', label: 'Alpha option', shortLabel: 'Alpha' },
  { value: 'b', label: 'Beta option', shortLabel: 'Beta' },
  {
    value: 'c',
    label: 'Gamma option',
    unavailable: true,
    unavailableReason: 'Gamma is not available yet',
  },
];

function renderControl(props: Partial<React.ComponentProps<typeof SegmentedControl>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TooltipProvider>
      <SegmentedControl
        label="Pick one"
        value="a"
        onChange={onChange}
        options={OPTIONS}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onChange, ...utils };
}

describe('SegmentedControl (plan 39.1-47, segmented-set-state)', () => {
  it('is a labelled radiogroup with exactly one pressed option', () => {
    renderControl();
    const group = screen.getByRole('radiogroup', { name: 'Pick one' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Alpha option' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('can be named by an external element through ariaLabelledBy instead of a label', () => {
    render(
      <TooltipProvider>
        <span id="external-name">Named from outside</span>
        <SegmentedControl
          ariaLabelledBy="external-name"
          value="a"
          onChange={() => {}}
          options={OPTIONS}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Named from outside' })).toBeInTheDocument();
  });

  it('carries the accent on the pressed option only, inside that option', () => {
    const { container, rerender } = renderControl();
    const accents = container.querySelectorAll('[data-slot="segmented-control-accent"]');
    expect(accents).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Alpha option' }).contains(accents[0] ?? null)).toBe(
      true,
    );
    rerender(
      <TooltipProvider>
        <SegmentedControl label="Pick one" value="b" onChange={() => {}} options={OPTIONS} />
      </TooltipProvider>,
    );
    const moved = container.querySelectorAll('[data-slot="segmented-control-accent"]');
    expect(moved).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Beta option' }).contains(moved[0] ?? null)).toBe(
      true,
    );
  });

  it('reports a chosen available option once, and ignores a re-press of the pressed one', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControl();
    await user.click(screen.getByRole('radio', { name: 'Beta option' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
    await user.click(screen.getByRole('radio', { name: 'Alpha option' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('an unavailable option is aria-disabled, shows its reason in a tooltip and changes nothing when activated', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControl();
    const gamma = screen.getByRole('radio', { name: 'Gamma option' });
    expect(gamma).toHaveAttribute('aria-disabled', 'true');
    await user.hover(gamma);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Gamma is not available yet');
    await user.click(gamma);
    expect(onChange).not.toHaveBeenCalled();
    expect(gamma).toHaveAttribute('aria-checked', 'false');
  });

  it('an option without a reason is still guarded when unavailable, and no tooltip is mounted for it', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControl({
      options: [
        { value: 'a', label: 'Alpha option' },
        { value: 'b', label: 'Beta option', unavailable: true },
      ],
    });
    await user.click(screen.getByRole('radio', { name: 'Beta option' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.hover(screen.getByRole('radio', { name: 'Beta option' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('pins the accessible name to the full label while a short label is what shows on a narrow viewport', () => {
    renderControl();
    const alpha = screen.getByRole('radio', { name: 'Alpha option' });
    // Both label spans are aria-hidden so neither enters the accname; the
    // short one is the `sm:hidden` span, the full one the `hidden sm:inline`.
    const spans = alpha.querySelectorAll('span[aria-hidden="true"]');
    const texts = Array.from(spans).map((span) => span.textContent);
    expect(texts).toContain('Alpha');
    expect(texts).toContain('Alpha option');
  });

  it('an option with no short label renders its label once', () => {
    renderControl({ options: [{ value: 'a', label: 'Only label' }] });
    const only = screen.getByRole('radio', { name: 'Only label' });
    const texts = Array.from(only.querySelectorAll('span[aria-hidden="true"]'))
      .map((span) => span.textContent)
      .filter((text) => text === 'Only label');
    expect(texts).toHaveLength(1);
  });

  // UAT 39.1-22: below 640px the segments are content-sized (flex-auto,
  // never wrapping) rather than equal thirds, so a long short-label (fr
  // 'Dernier événement') takes the slack of the shorter segments.
  it('is full width with content-sized segments below 640px and content-width from 640px', () => {
    renderControl();
    const group = screen.getByRole('radiogroup');
    expect(group.className).toMatch(/\bw-full\b/);
    expect(group.className).toMatch(/\bsm:w-fit\b/);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toMatch(/(^|\s)flex-auto(\s|$)/);
      expect(radio.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
      expect(radio.className).not.toMatch(/(^|\s)flex-1(\s|$)/);
      expect(radio.className).toMatch(/\bsm:flex-none\b/);
    }
  });

  it('every transition utility in the source is paired with its reduced-motion counterpart', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/SegmentedControl.tsx'),
      'utf8',
    );
    const transitionLines = source
      .split('\n')
      .filter((line) => /\btransition-[a-z-]+/.test(line) || /\bduration-\S+/.test(line));
    expect(transitionLines.length).toBeGreaterThan(0);
    for (const line of transitionLines) {
      expect(line).toContain('motion-reduce:');
    }
  });

  it('holds no local selected state — the value is always the prop', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/SegmentedControl.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/useState/);
  });
});
