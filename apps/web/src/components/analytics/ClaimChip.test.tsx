import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClaimChip, type ClaimChipKind } from './ClaimChip';

describe('ClaimChip', () => {
  const kinds: ClaimChipKind[] = ['fact', 'trend', 'suggestion'];

  it.each(kinds)(
    'renders the %s kind with an aria-hidden shape and the word in the accessible name',
    (kind) => {
      render(
        <ClaimChip
          kind={kind}
          label={kind === 'fact' ? 'Fact' : kind === 'trend' ? 'Trend' : 'Suggestion'}
        />,
      );
      const badge = screen.getByText(
        kind === 'fact' ? 'Fact' : kind === 'trend' ? 'Trend' : 'Suggestion',
      );
      const svg = badge.querySelector('svg')!;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    },
  );

  it('renders a dashed border and the locked suffix from the label prop when locked', () => {
    render(<ClaimChip kind="fact" locked label="Fact · locked" />);
    const badge = screen.getByText('Fact · locked');
    expect(badge.className).toContain('border-dashed');
  });

  it('renders no dashed border when not locked', () => {
    render(<ClaimChip kind="trend" label="Trend" />);
    const badge = screen.getByText('Trend');
    expect(badge.className).not.toContain('border-dashed');
  });

  it('renders exactly the closed vocabulary of three kinds — a fourth is a TypeScript error', () => {
    // @ts-expect-error — 'other' is not a member of ClaimChipKind
    const invalid = <ClaimChip kind="other" label="Other" />;
    expect(invalid).toBeTruthy();
  });
});
