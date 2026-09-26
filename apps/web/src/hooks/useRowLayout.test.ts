import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NARROW_LAYOUT_QUERY, useRowLayout } from '@/hooks/useRowLayout';

/**
 * Plan 39.1-49: the provider-free phone layout switch the stacked-row hosts
 * read (FilteredMatchList's read-once matchMedia mechanism plus an explicit
 * override). jsdom has no matchMedia, so every case stubs it explicitly.
 */
function stubMatchMedia(matches: boolean) {
  const listeners: Array<(event: { matches: boolean }) => void> = [];
  const mql = {
    matches,
    media: NARROW_LAYOUT_QUERY,
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: () => {},
    addListener: (fn: (event: { matches: boolean }) => void) => listeners.push(fn),
    removeListener: () => {},
  };
  const matchMedia = vi.fn((query: string) => ({ ...mql, media: query, matches }));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  return { matchMedia, mql, listeners };
}

describe('useRowLayout (plan 39.1-49)', () => {
  afterEach(() => {
    // @ts-expect-error — jsdom has no matchMedia; restore that default.
    delete window.matchMedia;
  });

  it('the query is the sm breakpoint (below 640px)', () => {
    expect(NARROW_LAYOUT_QUERY).toBe('(max-width: 639px)');
  });

  it('the override wins over the media query', () => {
    stubMatchMedia(true);
    expect(renderHook(() => useRowLayout('table')).result.current).toBe('table');
    stubMatchMedia(false);
    expect(renderHook(() => useRowLayout('stack')).result.current).toBe('stack');
  });

  it("returns 'stack' when matchMedia matches (max-width: 639px)", () => {
    const { matchMedia } = stubMatchMedia(true);
    expect(renderHook(() => useRowLayout()).result.current).toBe('stack');
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 639px)');
  });

  it("returns 'table' when matchMedia is unavailable", () => {
    expect(typeof window.matchMedia).toBe('undefined');
    expect(renderHook(() => useRowLayout()).result.current).toBe('table');
  });

  it('is read-once: a later media change does not switch it', () => {
    let matches = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches,
        media: NARROW_LAYOUT_QUERY,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    });
    const { result, rerender } = renderHook(() => useRowLayout());
    expect(result.current).toBe('table');
    matches = true;
    rerender();
    expect(result.current).toBe('table');
  });
});
