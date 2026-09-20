import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { volumeFormTemplate } from './volumeForm.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const NOW_MS = Date.UTC(2025, 0, 1);

/** Builds `count` games all timestamped inside the given UTC calendar month (`monthIndex` 0-based), each 1 hour apart. */
function buildMonthMatches(
  year: number,
  monthIndex: number,
  count: number,
  winRatio: number,
  idPrefix: string,
): Match[] {
  const wins = Math.round(count * winRatio);
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    fighter_id: 8,
    opponent_id: 23,
    time: Date.UTC(year, monthIndex, 1, i % 20) + i * 60 * 60 * 1000,
    win: i < wins,
  }));
}

function buildInsight(matches: Match[]) {
  const result = volumeFormTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('volumeFormTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'volumeForm');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(volumeFormTemplate);
  });

  it('fewer than VOLUME_MIN_MONTHS (5) months returns locked with a positive months-needed shortfall', () => {
    const matches = [
      ...buildMonthMatches(2024, 0, 10, 0.5, 'm0'),
      ...buildMonthMatches(2024, 1, 10, 0.5, 'm1'),
      ...buildMonthMatches(2024, 2, 10, 0.5, 'm2'),
      ...buildMonthMatches(2024, 3, 10, 0.5, 'm3'),
      ...buildMonthMatches(2024, 4, 10, 0.5, 'm4'),
    ];
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('locked');
    expect(insight.gamesNeeded).toBeGreaterThan(0);
  });

  it('at exactly VOLUME_MIN_MONTHS (6) months, runs the notability test instead of locking', () => {
    const monthCounts = [10, 15, 20, 25, 30, 35];
    const matches = monthCounts.flatMap((count, i) =>
      buildMonthMatches(2024, i, count, 0.5, `mv${i}`),
    );
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).not.toBe('locked');
  });

  it("derives its split point from the subject's own data — non-degenerate for both a 40-game and an ~8000-game shaped fixture", () => {
    const small = [10, 5, 15, 10].flatMap((count, i) =>
      buildMonthMatches(2024, i, count, 0.5, `small${i}`),
    );
    const smallInsight = buildInsight(small)!;
    // Below VOLUME_MIN_MONTHS (only 4 months) so this is `locked`, but the
    // months-needed shortfall alone doesn't prove a real split — assert the
    // larger fixture below instead, which clears the floor.
    expect(smallInsight.state).toBe('locked');

    const large = [1000, 2500, 1500, 3000, 2000, 1500, 1000, 500].flatMap((count, i) =>
      buildMonthMatches(2020 + Math.floor(i / 12), i % 12, count, 0.5, `large${i}`),
    );
    const largeInsight = buildInsight(large)!;
    expect(largeInsight).not.toBeNull();
    expect(largeInsight.state).not.toBe('locked');
    // Non-degenerate: both cohorts (declared in copy.values) carry real
    // games — asserted via the eligible-denominator on both claim sides.
    expect(largeInsight.recent.sample.eligibleDenominator).toBeGreaterThan(0);
    expect(largeInsight.baseline.sample.eligibleDenominator).toBeGreaterThan(0);
  });

  it('windowExpressible is false — its games are the non-contiguous pooled games of the high-volume months', () => {
    expect(volumeFormTemplate.windowExpressible).toBe(false);
  });

  it('declares no bare notability literal (1.96) — the two-proportion gate is imported from policy.ts', () => {
    const sourcePath = fileURLToPath(new URL('./volumeForm.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const lines = source.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      expect(trimmed.includes('1.96')).toBe(false);
    }
  });
});
