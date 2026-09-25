import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import en from '@/i18n/locales/en.json';
import { DroppedClaimsNote } from './DroppedClaimsNote';

/**
 * Plan 39-10 (UI-SPEC E8): the note renders only for a finite integer count
 * of at least one. Every other value renders NO text node at all — and no
 * rendered string, anywhere, may contain `NaN`.
 */
const NOTHING: Array<{ label: string; count: unknown }> = [
  { label: 'absent', count: undefined },
  { label: 'null', count: null },
  { label: '0', count: 0 },
  { label: '-1', count: -1 },
  { label: '1.5', count: 1.5 },
  { label: 'non-numeric string', count: 'two' },
  { label: 'numeric string', count: '2' },
  { label: 'NaN', count: Number.NaN },
  { label: 'Infinity', count: Number.POSITIVE_INFINITY },
];

describe('DroppedClaimsNote', () => {
  it.each(NOTHING)('$label -> renders nothing (no text node, no NaN)', ({ count }) => {
    const { container } = render(<DroppedClaimsNote count={count} />);
    expect(container.textContent).toBe('');
    expect(container.childNodes).toHaveLength(0);
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('1 -> the singular sentence, matched exactly against the shipped copy', () => {
    const { container } = render(<DroppedClaimsNote count={1} />);
    expect(container.textContent).toBe(en.reports.droppedClaims_one);
    expect(container.textContent).toBe(
      "1 claim couldn't be verified and was removed from this report.",
    );
  });

  it('2 -> the plural sentence with the stored count, matched exactly', () => {
    const { container } = render(<DroppedClaimsNote count={2} />);
    expect(container.textContent).toBe(en.reports.droppedClaims_other.replace('{{count}}', '2'));
    expect(container.textContent).toBe(
      "2 claims couldn't be verified and were removed from this report.",
    );
    expect(container.textContent).not.toContain('NaN');
  });

  it('uses the muted footer treatment — no colour, no icon', () => {
    const { container } = render(<DroppedClaimsNote count={3} />);
    const note = container.querySelector('[data-dropped-claims-note]');
    expect(note).toHaveClass('text-xs', 'text-muted-foreground');
    expect(note?.querySelector('svg')).toBeNull();
  });
});
