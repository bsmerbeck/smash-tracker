import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARK_BOUND_LINE_POINTS,
  MARK_BOUND_BARS,
  MARK_BOUND_HEAT_CELLS,
  MARK_BOUND_STRIP_TICKS,
  NARROW_PLOT_TARGET,
  PERIOD_TREND_MIN_PERIODS,
} from './markBounds.js';

/** Mirrors `purity.test.ts`'s file-walking discipline, scoped to a name-uniqueness check. */
const insightDir = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const BOUND_CONSTANT_NAMES = [
  'MARK_BOUND_LINE_POINTS',
  'MARK_BOUND_BARS',
  'MARK_BOUND_HEAT_CELLS',
  'MARK_BOUND_STRIP_TICKS',
  'NARROW_PLOT_TARGET',
  'PERIOD_TREND_MIN_PERIODS',
] as const;

describe('markBounds (VIZ-01, UI-SPEC §11, §7.13)', () => {
  it('exports the four hard mark-count caps plus the narrow-plot target and locked-period floor', () => {
    expect(MARK_BOUND_LINE_POINTS).toBe(60);
    expect(MARK_BOUND_BARS).toBe(36);
    expect(MARK_BOUND_HEAT_CELLS).toBe(108);
    expect(MARK_BOUND_STRIP_TICKS).toBe(60);
    expect(NARROW_PLOT_TARGET).toBe(30);
    expect(PERIOD_TREND_MIN_PERIODS).toBe(8);
  });

  it('declares each bound constant exactly once, in markBounds.ts, under packages/shared/src/insight/', () => {
    const files = listSourceFiles(insightDir);
    expect(files.length).toBeGreaterThan(0);
    for (const name of BOUND_CONSTANT_NAMES) {
      const declaredIn = files
        .filter((file) => new RegExp(`\\bexport const ${name}\\b`).test(readFileSync(file, 'utf8')))
        .map((file) => relative(insightDir, file));
      expect(declaredIn).toEqual(['markBounds.ts']);
    }
  });
});
