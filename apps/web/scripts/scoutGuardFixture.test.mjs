import { describe, expect, it } from 'vitest';
import { scoutReportDataSchema } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { buildScoutGuardReport } from './scoutGuardFixture.mjs';

/**
 * Plan 39.1-49: the Scout guard route's `POST /api/scout` answer is built from
 * the harness dataset and must pass the SAME schema the page parses it with —
 * a report the page rejects would leave guard:layout measuring an error box.
 */
const dataset = generateSyntheticMatches({ seed: 39_149_001, count: 300 });

function mostFrequentTag(matches) {
  const counts = new Map();
  for (const match of matches) {
    const tag = match.opponent ?? 'Anonymous';
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

describe('buildScoutGuardReport (plan 39.1-49 scout fixture)', () => {
  it('scout fixture schema: a synthetic dataset yields a scoutReportDataSchema-valid report with one game per match', () => {
    const report = buildScoutGuardReport(dataset);
    expect(() => scoutReportDataSchema.parse(report)).not.toThrow();
    expect(report.games).toHaveLength(dataset.length);
    expect(report.sampledGames).toBe(dataset.length);
  });

  it('carries 1-10 recent events and 1-10 common opponents sorted by sets descending, characters by games descending', () => {
    const report = buildScoutGuardReport(dataset);
    expect(report.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(report.recentEvents.length).toBeLessThanOrEqual(10);
    expect(report.commonOpponents.length).toBeGreaterThanOrEqual(1);
    expect(report.commonOpponents.length).toBeLessThanOrEqual(10);
    const sets = report.commonOpponents.map((o) => o.sets);
    expect(sets).toEqual([...sets].sort((a, b) => b - a));
    const games = report.characters.map((c) => c.games);
    expect(games).toEqual([...games].sort((a, b) => b - a));
    for (const event of report.recentEvents) {
      expect(event.eventName.length).toBeGreaterThanOrEqual(30);
      expect(event.eventName.length).toBeLessThanOrEqual(50);
    }
  });

  it("names the scouted player after the dataset's most frequent opponent tag", () => {
    expect(buildScoutGuardReport(dataset).player.gamerTag).toBe(mostFrequentTag(dataset));
  });

  it('is deterministic: two calls deep-equal', () => {
    expect(buildScoutGuardReport(dataset)).toEqual(buildScoutGuardReport(dataset));
  });

  it('an empty dataset is still schema-valid', () => {
    const report = buildScoutGuardReport([]);
    expect(() => scoutReportDataSchema.parse(report)).not.toThrow();
    expect(report.games).toEqual([]);
  });
});
