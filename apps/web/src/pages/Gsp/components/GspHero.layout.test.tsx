import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GspPoint } from '@smash-tracker/shared';
import { GspHero } from './GspHero';

vi.mock('@/hooks/useGspLive', () => ({ useGspLive: () => ({ data: undefined }) }));
vi.mock('@/hooks/useGspSettings', () => ({
  useUpdateGspSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/**
 * Plan 39.1-49 (OOS-9): at 390px the GspHero figures ('10,880,284') left
 * their half-width cards. Below 640px every figure uses the `figure` role
 * size (text-xl font-semibold); from `sm:` up it keeps today's text-3xl
 * font-bold, so desktop is unchanged.
 */
function renderHero() {
  const series: GspPoint[] = Array.from({ length: 25 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    gsp: 10_000_000 + i * 40_000,
    win: i % 3 !== 0,
  }));
  return render(
    <GspHero series={series} settings={{ eliteThreshold: 14_000_000, updatedAt: 0 }} />,
  );
}

describe('GspHero phone figures (plan 39.1-49, OOS-9)', () => {
  it('GspHero phone-figure: every figure span carries the phone figure size plus sm:text-3xl sm:font-bold, none an unprefixed text-3xl', () => {
    const { container } = renderHero();
    const figures = Array.from(container.querySelectorAll('span')).filter((span) =>
      /(^|\s)(sm:)?text-3xl(\s|$)/.test(span.className),
    );
    expect(figures.length).toBeGreaterThanOrEqual(4);
    for (const figure of figures) {
      const classes = figure.className.split(/\s+/);
      expect(classes).toEqual(
        expect.arrayContaining(['text-xl', 'font-semibold', 'sm:text-3xl', 'sm:font-bold']),
      );
      expect(classes).not.toContain('text-3xl');
      expect(classes).not.toContain('font-bold');
    }
  });

  it('the grid root keeps lg:grid-cols-5 and data-slot gsp-hero', () => {
    const { container } = renderHero();
    const root = container.querySelector('[data-slot="gsp-hero"]');
    expect(root).not.toBeNull();
    expect(root!.className.split(/\s+/)).toContain('lg:grid-cols-5');
  });
});
