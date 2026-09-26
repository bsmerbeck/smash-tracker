import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { buildStageEventSeries } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import type { TrendEventPoint } from '@/components/charts/TrendLine';

/**
 * Plan 39.1-39 (UI-SPEC §10.2, kit rule "tooltip fields are pre-resolved on
 * the point object"): the ONE host mapper from an event series (anchors or
 * bins) to TrendLine points with a readable `context.eventLabel`, shared by
 * the hub and stage detail. Loaded dynamically so a RED run fails on an
 * assertion rather than a missing module.
 */
type Mod = {
  buildEventTrendPoints: (input: {
    series: unknown[];
    opponentTag: string;
    t: typeof i18n.t;
    locale: string;
  }) => TrendEventPoint[];
  buildEventKeysForMatch: (series: unknown[]) => (match: Match) => string[];
};

async function load(): Promise<Mod> {
  // A variable specifier keeps Vite's import analysis from failing the whole
  // file at transform time while the module does not exist yet (RED).
  const specifier = '@/lib/eventTrendPoints';
  const mod = (await import(/* @vite-ignore */ specifier).catch(() => null)) as Mod | null;
  expect(mod, 'lib/eventTrendPoints exists').not.toBeNull();
  expect(typeof mod!.buildEventTrendPoints).toBe('function');
  expect(typeof mod!.buildEventKeysForMatch).toBe('function');
  return mod!;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: 'rival',
    map: { id: 1, name: 'Battlefield' },
    notes: '',
    matchType: 'none',
    ...overrides,
  } as Match;
}

const sessionStart = Date.UTC(2026, 2, 3, 18);
const mixed: Match[] = [
  makeMatch({ id: 's1', time: sessionStart, win: true }),
  makeMatch({ id: 's2', time: sessionStart + 60_000, win: false }),
  makeMatch({ id: 't1', time: sessionStart + 10 * DAY_MS, win: true, eventName: 'Genesis 9' }),
];

describe('buildEventTrendPoints (plan 39.1-39)', () => {
  it("a session anchor's eventLabel is 'Session · <locale date>', a tournament's is its name", async () => {
    const { buildEventTrendPoints } = await load();
    const series = buildStageEventSeries({ matches: mixed, stageId: 1, refreshedAt: 1 });
    const points = buildEventTrendPoints({ series, opponentTag: 'rival', t: i18n.t, locale: 'en' });
    expect(points.map((p) => p.context.eventLabel)).toEqual(['Session · Mar 3, 2026', 'Genesis 9']);
    expect(points[0]!.eventKey).toBe(series[0]!.key);
    expect(points[0]!.context.opponentTag).toBe('rival');
    expect(points[1]!.wins).toBe(1);
  });

  it("a bin's eventLabel is its period label; no label anywhere carries '::' or an ISO timestamp", async () => {
    const { buildEventTrendPoints } = await load();
    const daily = Array.from({ length: 150 }, (_, i) =>
      makeMatch({ id: `d${i}`, time: Date.UTC(2026, 0, 5, 18) + i * DAY_MS, win: i % 2 === 0 }),
    );
    const shared = (await import('@smash-tracker/shared')) as Record<string, unknown>;
    const bin = shared.binEventSeries as (s: unknown[]) => Array<{ key: string; label: string }>;
    const bins = bin(buildStageEventSeries({ matches: daily, stageId: 1, refreshedAt: 1 }));
    const points = buildEventTrendPoints({
      series: bins,
      opponentTag: '',
      t: i18n.t,
      locale: 'en',
    });
    expect(points.length).toBeLessThanOrEqual(60);
    expect(points[0]!.eventKey).toMatch(/^bin:week:/);
    expect(points[0]!.context.eventLabel).toBe(bins[0]!.label);
    for (const point of [
      ...points,
      ...buildEventTrendPoints({
        series: buildStageEventSeries({ matches: mixed, stageId: 1, refreshedAt: 1 }),
        opponentTag: '',
        t: i18n.t,
        locale: 'en',
      }),
    ]) {
      expect(point.context.eventLabel).not.toContain('::');
      expect(point.context.eventLabel).not.toMatch(ISO);
    }
  });

  it('ChartTooltip rendered with a mapped session point shows the session label and no ISO text', async () => {
    const { buildEventTrendPoints } = await load();
    const series = buildStageEventSeries({ matches: mixed, stageId: 1, refreshedAt: 1 });
    const [sessionPoint] = buildEventTrendPoints({
      series,
      opponentTag: 'rival',
      t: i18n.t,
      locale: 'en',
    });
    const { container } = render(
      createElement(ChartTooltip, { active: true, payload: [{ payload: sessionPoint }] }),
    );
    expect(container.textContent).toContain('Session · Mar 3, 2026');
    expect(container.textContent).not.toMatch(ISO);
  });

  it('buildEventKeysForMatch maps a game to its anchor key and its bin key at every grain', async () => {
    const { buildEventKeysForMatch } = await load();
    const series = buildStageEventSeries({ matches: mixed, stageId: 1, refreshedAt: 1 });
    const keysFor = buildEventKeysForMatch(series);
    const keys = keysFor(mixed[0]!);
    expect(keys[0]).toBe(series[0]!.key);
    expect(keys).toContain(`bin:month:${Date.UTC(2026, 2, 1)}`);
    expect(keys).toContain(`bin:week:${Date.UTC(2026, 2, 2)}`);
    expect(keys).toContain(`bin:quarter:${Date.UTC(2026, 0, 1)}`);
    expect(keys).toContain(`bin:year:${Date.UTC(2026, 0, 1)}`);
    expect(keysFor(makeMatch({ id: 'nope', time: 1, win: true }))).toEqual([]);
  });
});
