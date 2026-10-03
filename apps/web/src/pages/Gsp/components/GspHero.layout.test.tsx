import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GspPoint } from '@smash-tracker/shared';
import { GspHero } from './GspHero';

vi.mock('@/hooks/useGspLive', () => ({ useGspLive: () => ({ data: undefined }) }));
vi.mock('@/hooks/useGspSettings', () => ({
  useUpdateGspSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/**
 * Plan 41-05 (C2, DD-41-17; superseding plan 39.1-49's OOS-9 per-card figure
 * classes): the hero is ONE compact card whose content root carries
 * `data-slot="gsp-hero"` and holds a five-figure `StatRow` — two columns
 * below the 860px page-container rule with the lead spanning both, so a
 * '10,880,284' figure at 390px has the full row width.
 */
function renderHero(series?: GspPoint[]) {
  const readings: GspPoint[] =
    series ??
    Array.from({ length: 25 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 60_000,
      gsp: 10_000_000 + i * 40_000,
      win: i % 3 !== 0,
    }));
  return render(
    <GspHero series={readings} settings={{ eliteThreshold: 14_000_000, updatedAt: 0 }} />,
  );
}

describe('GspHero one-card StatRow (plan 41-05)', () => {
  it('is one card whose content root is the gsp-hero measurement target, holding five figures', () => {
    const { container } = renderHero();
    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards).toHaveLength(1);
    const root = container.querySelector('[data-slot="gsp-hero"]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('data-slot')).toBe('gsp-hero');
    // the Card keeps its own slot — the stretch oracle selects it
    expect(root).not.toBe(cards[0]);
    expect(cards[0]!.contains(root)).toBe(true);
    const row = root!.querySelector('[data-slot="stat-row"]')!;
    expect(row.children).toHaveLength(5);
  });

  it('collapses to two columns below the 860px container with the lead spanning both', () => {
    const { container } = renderHero();
    const row = container.querySelector('[data-slot="stat-row"]')!;
    expect(row.hasAttribute('data-lead-span')).toBe(true);
    const classes = row.className.split(/\s+/);
    expect(classes).toContain('@max-[860px]/page:grid-cols-2');
    expect(classes).toContain('@max-[860px]/page:[&>*:first-child]:col-span-2');
    expect(classes).toContain('grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]');
  });

  it('carries no data-coloured text and no per-figure off-scale classes', () => {
    const { container } = renderHero();
    const html = container.innerHTML;
    expect(html).not.toMatch(/text-(emerald|amber)-/);
    expect(html).not.toMatch(/(^|[\s"])text-3xl/);
    expect(html).not.toMatch(/font-bold/);
  });

  it('keeps five figures (each an em dash with the no-GSP caption) when nothing is logged', () => {
    const { container } = renderHero([]);
    const row = container.querySelector('[data-slot="stat-row"]')!;
    expect(row.children).toHaveLength(5);
    // every figure but the (always populated) Elite threshold reads "—" + "No GSP logged yet"
    const empties = Array.from(row.children).filter((child) =>
      (child.textContent ?? '').includes('No GSP logged yet'),
    );
    expect(empties).toHaveLength(4);
    for (const child of empties) expect(child.textContent).toContain('—');
  });
});
