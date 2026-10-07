import { describe, expect, it } from 'vitest';
import type { Insight } from '@smash-tracker/shared';

/**
 * Plan 39.1-59 (UAT 39.1-33 F17): `headStatesScopedWindow` moves out of
 * MatchupChart so Fighter Analysis states the D-15 bound the way Matchups
 * does. Imported inside each case so the RED run fails per case, not at load.
 */
const MODULE_SPECIFIER = './scopedRecencyVerdict';

type Predicate = (insight: Insight) => boolean;

async function loadPredicate(): Promise<Predicate> {
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(() => null)) as {
    headStatesScopedWindow?: Predicate;
  } | null;
  expect(mod?.headStatesScopedWindow, 'headStatesScopedWindow is exported').toBeTypeOf('function');
  return mod!.headStatesScopedWindow!;
}

interface Conditions {
  locked: boolean;
  last30: boolean;
  scoped: boolean;
  evidenced: boolean;
}

function insightFor({ locked, last30, scoped, evidenced }: Conditions): Insight {
  return {
    state: locked ? 'locked' : 'thinRecent',
    horizon: last30 ? 'last30' : 'lastEvent',
    window: {
      horizon: last30 ? 'last30' : 'lastEvent',
      fromMs: null,
      toMs: null,
      games: 0,
      scoped,
    },
    baseline: evidenced
      ? { kind: 'evidenced', claimType: 'fact' }
      : { kind: 'abstained', claimType: 'fact', reason: 'insufficient-sample', gamesNeeded: 1 },
  } as unknown as Insight;
}

describe('headStatesScopedWindow — the D-15 scoped-window truth table', () => {
  const ALL: Conditions = { locked: true, last30: true, scoped: true, evidenced: true };

  it('locked + last30 + scoped + evidenced baseline holds', async () => {
    const headStatesScopedWindow = await loadPredicate();
    expect(headStatesScopedWindow(insightFor(ALL))).toBe(true);
  });

  for (const flipped of Object.keys(ALL) as (keyof Conditions)[]) {
    it(`flipping ${flipped} alone gives false`, async () => {
      const headStatesScopedWindow = await loadPredicate();
      expect(headStatesScopedWindow(insightFor({ ...ALL, [flipped]: false }))).toBe(false);
    });
  }
});
