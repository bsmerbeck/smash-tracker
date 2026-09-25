import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/syntheticMatches.js';
import { buildPeriodSeries } from './periodSeries.js';
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

/**
 * Five insight scopes derived DATA-DRIVEN from a real fixture (never
 * hand-picked ids that might not appear in it) — account-wide, one fighter,
 * one opponent character, one opponent player and one stage — the same five
 * `39.1-02-PLAN.md` Task 3 names. Filtering happens here, at the test-data
 * boundary, exactly as `InsightScope.filter` (plan 39.1-01) does it — never
 * inside `buildPeriodSeries` itself.
 */
function buildFixtureScopes(matches: Match[]): Array<{ name: string; matches: Match[] }> {
  const sampleFighterId = matches[0]?.fighter_id;
  const sampleOpponentCharacterId = matches[0]?.opponent_id;
  const sampleOpponentTag = matches.find((m) => m.opponent !== undefined)?.opponent;
  const sampleStageId = matches.find((m) => m.map !== undefined)?.map?.id;
  return [
    { name: 'account-wide', matches },
    {
      name: 'one fighter',
      matches:
        sampleFighterId === undefined
          ? []
          : matches.filter((m) => m.fighter_id === sampleFighterId),
    },
    {
      name: 'one opponent character',
      matches:
        sampleOpponentCharacterId === undefined
          ? []
          : matches.filter((m) => m.opponent_id === sampleOpponentCharacterId),
    },
    {
      name: 'one opponent player',
      matches:
        sampleOpponentTag === undefined
          ? []
          : matches.filter((m) => m.opponent === sampleOpponentTag),
    },
    {
      name: 'one stage',
      matches:
        sampleStageId === undefined ? [] : matches.filter((m) => m.map?.id === sampleStageId),
    },
  ];
}

describe('markBounds oracle — VIZ-01 §13.9 (engine half, page half lands in plan 39.1-21)', () => {
  it('bounds every insight scope on the 8k and 50k fixtures at both the default and narrow-plot targets, non-vacuously', () => {
    const measured: string[] = [];
    let sawScopeOverTen = false;

    for (const [fixtureLabel, options] of [
      ['8k', EIGHT_K_FIXTURE_OPTIONS],
      ['50k', FIFTY_K_FIXTURE_OPTIONS],
    ] as const) {
      const matches = generateSyntheticMatches(options);
      for (const scope of buildFixtureScopes(matches)) {
        const atDefault = buildPeriodSeries({
          matches: scope.matches,
          target: MARK_BOUND_LINE_POINTS,
        });
        const atNarrow = buildPeriodSeries({ matches: scope.matches, target: NARROW_PLOT_TARGET });

        expect(atDefault.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
        expect(atNarrow.points.length).toBeLessThanOrEqual(NARROW_PLOT_TARGET);

        if (fixtureLabel === '8k' && atDefault.points.length > 10) {
          sawScopeOverTen = true;
        }
        measured.push(
          `${fixtureLabel} / ${scope.name}: grain=${atDefault.grain} points=${atDefault.points.length} (narrow grain=${atNarrow.grain} points=${atNarrow.points.length})`,
        );
      }
    }

    // Non-vacuity companion (Task 3): the bound assertions above must not pass merely because every scope returned an empty series.
    expect(sawScopeOverTen).toBe(true);
    // Every fixture x scope pair produced a measurement — see this test's console output / the plan SUMMARY for the real, run-measured numbers.
    expect(measured).toHaveLength(10);
    // Printed so the real, run-measured numbers can be transcribed into the plan SUMMARY (UI-SPEC §13: never recalled).
    console.log(measured.join('\n'));
  });
});
