import { describe, expect, it } from 'vitest';
import type { HorizonKey, InsightState } from '@smash-tracker/shared';
import i18n from '@/i18n';

/**
 * Plan 39.1-36 (INS-04, D-07 honesty ladder): the ONE mapping from the
 * engine's honesty-ladder state to a DeltaChip. The module is imported
 * dynamically inside each test body so the RED run fails on an assertion,
 * not at file import (the module does not exist before GREEN).
 */
const MODULE_SPECIFIER = './deltaChipView';

async function loadView(): Promise<typeof import('./deltaChipView').deltaChipView> {
  // A non-literal specifier keeps Vite's import analysis from failing the
  // whole file at transform time while the module does not exist yet.
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(() => null)) as
    typeof import('./deltaChipView') | null;
  expect(mod, 'deltaChipView module exists').not.toBeNull();
  return mod!.deltaChipView;
}

const t = i18n.t.bind(i18n);

const ALL_STATES: InsightState[] = [
  'locked',
  'thinRecent',
  'thin',
  'steady',
  'trend',
  'suggestion',
];

describe('deltaChipView — one ladder-to-chip mapping (honest-none-chip)', () => {
  it('an empty recent window renders "no games" with the horizon as its own label', async () => {
    const deltaChipView = await loadView();
    for (const state of ALL_STATES) {
      const view = deltaChipView({
        state,
        deltaPoints: state === 'trend' || state === 'suggestion' ? 5 : null,
        recentGames: 0,
        horizon: 'last30',
        horizonOwnedByParent: false,
        t,
      });
      expect(view, `state ${state}`).not.toBeNull();
      expect(view!.state).toBe('none');
      expect(view!.valueLabel).toBe('no games');
      expect(view!.horizonLabel).toBe('last 30');
      expect(view!.recentGames).toBe(0);
    }
  });

  it('an empty recent window drops its own horizon label when the parent owns the horizon', async () => {
    const deltaChipView = await loadView();
    const view = deltaChipView({
      state: 'locked',
      deltaPoints: null,
      recentGames: 0,
      horizon: 'last30',
      horizonOwnedByParent: true,
      t,
    });
    expect(view!.state).toBe('none');
    expect(view!.horizonLabel).toBeUndefined();
    expect(view!.horizonOwnedByParent).toBe(true);
  });

  it('a 1-7 game window renders the thin "n N · no direction" chip for every non-collapsed state, never steady/up/down', async () => {
    const deltaChipView = await loadView();
    for (const recentGames of [1, 2, 3, 5, 7]) {
      for (const state of ALL_STATES) {
        const view = deltaChipView({
          state,
          deltaPoints: state === 'trend' || state === 'suggestion' ? -9 : null,
          recentGames,
          horizon: 'last30',
          horizonOwnedByParent: false,
          t,
        });
        expect(view, `state ${state} n ${recentGames}`).not.toBeNull();
        expect(view!.state).toBe('thin');
        expect(view!.valueLabel).toBe(`n ${recentGames} · no direction`);
        expect(view!.horizonLabel).toBeUndefined();
        expect(view!.horizonOwnedByParent).toBe(true);
        expect(view!.recentGames).toBe(recentGames);
      }
    }
  });

  it('collapsed renders no chip at all', async () => {
    const deltaChipView = await loadView();
    for (const recentGames of [0, 2, 30]) {
      expect(
        deltaChipView({
          state: 'collapsed',
          deltaPoints: null,
          recentGames,
          horizon: 'last30',
          horizonOwnedByParent: false,
          t,
        }),
      ).toBeNull();
    }
  });

  it('steady on 30 recent games reads "Steady" with the horizon', async () => {
    const deltaChipView = await loadView();
    const view = deltaChipView({
      state: 'steady',
      deltaPoints: null,
      recentGames: 30,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    expect(view!.state).toBe('steady');
    expect(view!.valueLabel).toBe('Steady');
    expect(view!.horizonLabel).toBe('last 30');
  });

  it('trend maps to down "-7 pts" and up "+9 pts"; suggestion maps like trend', async () => {
    const deltaChipView = await loadView();
    const down = deltaChipView({
      state: 'trend',
      deltaPoints: -7,
      recentGames: 30,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    expect(down!.state).toBe('down');
    expect(down!.valueLabel).toBe('-7 pts');
    const up = deltaChipView({
      state: 'trend',
      deltaPoints: 9,
      recentGames: 30,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    expect(up!.state).toBe('up');
    expect(up!.valueLabel).toBe('+9 pts');
    const suggestion = deltaChipView({
      state: 'suggestion',
      deltaPoints: -12,
      recentGames: 40,
      horizon: 'last90',
      horizonOwnedByParent: false,
      t,
    });
    expect(suggestion!.state).toBe('down');
    expect(suggestion!.valueLabel).toBe('-12 pts');
    expect(suggestion!.horizonLabel).toBe('last 90 days');
  });

  it('boundary 0 -> 1 recent games: none -> thin', async () => {
    const deltaChipView = await loadView();
    const base = { state: 'locked' as const, deltaPoints: null, horizon: 'last30' as const };
    expect(deltaChipView({ ...base, recentGames: 0, horizonOwnedByParent: false, t })!.state).toBe(
      'none',
    );
    expect(deltaChipView({ ...base, recentGames: 1, horizonOwnedByParent: false, t })!.state).toBe(
      'thin',
    );
  });

  it('boundary 2 -> 3 recent games: both thin, same copy shape', async () => {
    const deltaChipView = await loadView();
    const two = deltaChipView({
      state: 'locked',
      deltaPoints: null,
      recentGames: 2,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    const three = deltaChipView({
      state: 'thinRecent',
      deltaPoints: null,
      recentGames: 3,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    expect(two!.state).toBe('thin');
    expect(three!.state).toBe('thin');
    expect(two!.valueLabel).toBe('n 2 · no direction');
    expect(three!.valueLabel).toBe('n 3 · no direction');
  });

  it("boundary 7 -> 8 recent games: thin -> the engine's own state", async () => {
    const deltaChipView = await loadView();
    const seven = deltaChipView({
      state: 'steady',
      deltaPoints: null,
      recentGames: 7,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    const eight = deltaChipView({
      state: 'steady',
      deltaPoints: null,
      recentGames: 8,
      horizon: 'last30',
      horizonOwnedByParent: false,
      t,
    });
    expect(seven!.state).toBe('thin');
    expect(eight!.state).toBe('steady');
  });

  it('all three chip horizon labels resolve', async () => {
    const deltaChipView = await loadView();
    const expected: Record<HorizonKey, string> = {
      last30: 'last 30',
      lastEvent: 'last event',
      last90: 'last 90 days',
    };
    for (const horizon of Object.keys(expected) as HorizonKey[]) {
      const view = deltaChipView({
        state: 'steady',
        deltaPoints: null,
        recentGames: 30,
        horizon,
        horizonOwnedByParent: false,
        t,
      });
      expect(view!.horizonLabel).toBe(expected[horizon]);
    }
  });
});
