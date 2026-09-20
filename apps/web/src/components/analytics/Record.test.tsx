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
