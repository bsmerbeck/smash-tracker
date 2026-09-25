import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * WR-02 (39.1-REVIEW.md) for the career timeline's time axis: coarse
 * gridlines (years, months) stay on UTC boundaries because the engine buckets
 * calendar periods in UTC (`calendarBucketBounds`); day ticks fall on the
 * host's LOCAL midnights, like every other fine-grain date label. The zone is
 * pinned before `timeAxisTicks.ts` is imported (its formatters are cached per
 * locale and capture the host zone on first use), and restored afterwards —
 * the `periodTicks.timezone.test.ts` precedent.
 */
const originalTz = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  return previous;
});

import { selectTimeAxisTicks } from './timeAxisTicks';

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe('selectTimeAxisTicks — America/Los_Angeles (WR-02)', () => {
  it('year gridlines stay on UTC Jan 1 boundaries', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2018, 11, 18, 18),
      endMs: Date.UTC(2026, 7, 7, 12),
      plotWidthPx: 1000,
      locale: 'en',
    });
    expect(ticks.gridlines[0]).toBe(Date.UTC(2019, 0, 1));
    expect(ticks.labels[0]!.text).toBe('2019');
  });

  it('month gridlines stay on UTC month starts', () => {
    const ticks = selectTimeAxisTicks({
      startMs: Date.UTC(2026, 6, 3),
      endMs: Date.UTC(2026, 8, 16),
      plotWidthPx: 600,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Aug', 'Sep']);
  });

  it('day ticks fall on LOCAL midnights', () => {
    const ticks = selectTimeAxisTicks({
      startMs: new Date(2026, 2, 3, 12).getTime(),
      endMs: new Date(2026, 2, 7, 6).getTime(),
      plotWidthPx: 600,
      locale: 'en',
    });
    expect(ticks.gridlines).toEqual([
      new Date(2026, 2, 4).getTime(),
      new Date(2026, 2, 5).getTime(),
      new Date(2026, 2, 6).getTime(),
      new Date(2026, 2, 7).getTime(),
    ]);
    expect(ticks.labels.map((l) => l.text)).toEqual(['Mar 4', 'Mar 5', 'Mar 6', 'Mar 7']);
  });
});
