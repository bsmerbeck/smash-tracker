import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BoundedList,
  LIST_CAP,
  LIST_CAP_RAIL,
  LIST_INLINE_MAX,
  LIST_PASS_MAX,
  LIST_PASS_STEP,
} from './BoundedList';

const LABELS = {
  showAll: 'Show all',
  showFewer: 'Show fewer',
  showMore: 'Show 50 more',
  terminus: 'All →',
};

function makeRows(count: number, prefix = 'row') {
  return Array.from({ length: count }, (_, i) => <li key={i}>{`${prefix}-${i}`}</li>);
}

describe('BoundedList constants', () => {
  it('exports the exact cap ladder values from UI-SPEC §3', () => {
    expect(LIST_CAP).toBe(8);
    expect(LIST_CAP_RAIL).toBe(5);
    expect(LIST_INLINE_MAX).toBe(25);
    expect(LIST_PASS_MAX).toBe(100);
    expect(LIST_PASS_STEP).toBe(50);
  });
});

describe('BoundedList', () => {
  it('renders exactly LIST_CAP rows and zero controls at exactly the cap', () => {
    const { container } = render(
      <BoundedList rows={makeRows(LIST_CAP)} cap={LIST_CAP} labels={LABELS} empty={<p>none</p>} />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(LIST_CAP);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders LIST_CAP rows and one control at LIST_CAP + 1', () => {
    const { container } = render(
      <BoundedList
        rows={makeRows(LIST_CAP + 1)}
        cap={LIST_CAP}
        labels={LABELS}
        empty={<p>none</p>}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(LIST_CAP);
    expect(screen.getByText('Show all')).toBeInTheDocument();
  });

  it('expands inline to 25 and becomes "Show fewer" when total is exactly 25', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BoundedList
        rows={makeRows(LIST_INLINE_MAX)}
        cap={LIST_CAP}
        labels={LABELS}
        empty={<p>none</p>}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(LIST_CAP);
    await user.click(screen.getByText('Show all'));
    expect(container.querySelectorAll('li')).toHaveLength(LIST_INLINE_MAX);
    expect(screen.getByText('Show fewer')).toBeInTheDocument();
  });

  it('the first activation expands to exactly 25 and becomes a terminus anchor when total is 26', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BoundedList
        rows={makeRows(LIST_INLINE_MAX + 1)}
        cap={LIST_CAP}
        labels={LABELS}
        empty={<p>none</p>}
        terminusHref="/opponents"
      />,
    );
    await user.click(screen.getByText('Show all'));
    expect(container.querySelectorAll('li')).toHaveLength(LIST_INLINE_MAX);
    const terminus = screen.getByText('All →');
    expect(terminus.closest('a')).toHaveAttribute('href', '/opponents');
  });

  it('full-page mode renders exactly LIST_PASS_MAX rows on the first pass with a "Show 50 more" control', () => {
    const { container } = render(
      <BoundedList
        rows={makeRows(250)}
        cap={LIST_CAP}
        mode="full-page"
        labels={LABELS}
        empty={<p>none</p>}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(LIST_PASS_MAX);
    expect(screen.getByText('Show 50 more')).toBeInTheDocument();
  });

  it('renders the empty node and no control with zero rows', () => {
    render(<BoundedList rows={[]} cap={LIST_CAP} labels={LABELS} empty={<p>Nothing here</p>} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('never re-sorts — renders rows in the exact order given', () => {
    const rows = ['zebra', 'apple', 'mango'].map((label) => <li key={label}>{label}</li>);
    const { container } = render(
      <BoundedList rows={rows} cap={LIST_CAP} labels={LABELS} empty={<p>none</p>} />,
    );
    const texts = Array.from(container.querySelectorAll('li')).map((li) => li.textContent);
    expect(texts).toEqual(['zebra', 'apple', 'mango']);
  });

  it('contains no maximum-height or vertical-overflow utility anywhere in the source (no nested scroller)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/BoundedList.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/max-h-\S+/);
    expect(source).not.toMatch(/overflow-y-\S+/);
  });
});
