import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Record } from './Record';

describe('Record', () => {
  it('omits the rate below the 3-game abstention floor', () => {
    const { container } = render(<Record wins={2} losses={0} />);
    expect(container.textContent).toBe('2–0 · 2');
  });

  it('includes the rate at exactly 3 games (the abstention floor)', () => {
    const { container } = render(<Record wins={3} losses={0} />);
    expect(container.textContent).toBe('3–0 · 100% · 3');
  });

  it('renders grouped thousands and an en dash for large win/loss counts', () => {
    const { container } = render(<Record wins={3408} losses={1156} locale="en" />);
    expect(container.textContent).toContain('3,408–1,156');
    expect(container.textContent).not.toMatch(/3408-1156|3408–1156/);
  });

  it('bolds the W–L segment when emphasis is set', () => {
    const { container } = render(<Record wins={4} losses={1} emphasis />);
    const recordSpan = container.querySelector('span > span') as HTMLElement;
    expect(recordSpan.textContent).toBe('4–1');
    expect(recordSpan.className).toContain('font-semibold');
  });

  it('renders no hyphen-minus in place of the en dash', () => {
    const { container } = render(<Record wins={7} losses={3} />);
    expect(container.textContent).not.toContain('7-3');
    expect(container.textContent).toContain('7–3');
  });
});

/**
 * Plan 39.1-39 (UI-SPEC §7.4 "wraps whole", §6.5 rule 2): the root carries
 * the `data-slot="record"` measurement hook; an opt-in `wrap` prop wraps
 * whole tokens (W–L, · rate, · n) inside the host cell. Without `wrap` every
 * existing caller renders byte-identically apart from the attribute.
 */
describe('Record — measurement hook and whole-token wrap (plan 39.1-39)', () => {
  it('the root carries data-slot="record"', () => {
    const { container } = render(<Record wins={5} losses={3} />);
    expect(container.firstElementChild).toHaveAttribute('data-slot', 'record');
  });

  it("without wrap the root class list is exactly today's and the text is unchanged", () => {
    const { container } = render(
      <Record wins={1026} losses={184} locale="en" className="x-host" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/).sort()).toEqual(
      ['tabular-nums', 'whitespace-nowrap', 'x-host'].sort(),
    );
    expect(container.textContent).toBe('1,026–184 · 85% · 1,210');
  });

  it('with wrap the root is an inline-flex wrapping row with no whitespace-nowrap, and each token is its own nowrap span', () => {
    const { container } = render(<Record wins={1026} losses={184} locale="en" wrap />);
    const root = container.firstElementChild as HTMLElement;
    const classes = root.className.split(/\s+/);
    expect(classes).toContain('inline-flex');
    expect(classes).toContain('flex-wrap');
    expect(classes).not.toContain('whitespace-nowrap');
    const tokens = Array.from(root.children) as HTMLElement[];
    expect(tokens.map((t) => t.textContent)).toEqual(['1,026–184', '· 85%', '· 1,210']);
    for (const token of tokens) {
      expect(token.className.split(/\s+/)).toContain('whitespace-nowrap');
    }
  });

  it('with wrap the unit rides with the count and the sub-floor rule still omits the rate', () => {
    const { container } = render(<Record wins={2} losses={0} unit="games" wrap />);
    const tokens = Array.from((container.firstElementChild as HTMLElement).children);
    expect(tokens.map((t) => t.textContent)).toEqual(['2–0', '· 2 games']);
  });

  it('the sub-floor rule is unchanged without wrap', () => {
    const { container } = render(<Record wins={1} losses={1} />);
    expect(container.textContent).toBe('1–1 · 2');
  });
});
