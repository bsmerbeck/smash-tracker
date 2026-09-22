import { describe, expect, it } from 'vitest';
import { formNowTemplate } from './formNow.js';
import { ACCOUNT_SCOPE } from '../types.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../../testUtils/index.js';

const NOW_MS = 1_700_100_000_000;

describe('formNowTemplate (Task 1 tracer: a Match[] plus a horizon become one honest FormNow insight)', () => {
  it('declares windowExpressible: true', () => {
    expect(formNowTemplate.windowExpressible).toBe(true);
  });

  it('returns [] over zero games in scope, never a synthesised card', () => {
    const insights = formNowTemplate.build({
      matches: emptyWorkspace(),
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toEqual([]);
  });

  it('returns exactly one locked Insight over one game (below the abstention floor), with a null deltaPoints', () => {
    const insights = formNowTemplate.build({
      matches: oneGameWorkspace(),
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.state).toBe('locked');
    expect(insights[0]!.deltaPoints).toBeNull();
    expect(insights[0]!.gamesNeeded).toBe(2);
    // Review finding CR-A02: `insights.formNow.locked_other`'s `{{count}}`
    // is "games STILL NEEDED" — must equal `gamesNeeded`, never the 1 game
    // already played.
    expect(insights[0]!.copy.values.count).toBe(2);
  });

  it('over an 8k synthetic fixture returns one Insight whose window.games equals the n its primary door carries', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const insights = formNowTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    const insight = insights[0]!;
    const gamesDoor = insight.doors.find((door) => door.kind === 'games');
    expect(gamesDoor).toBeDefined();
    expect(insight.window.games).toBe(gamesDoor!.count);
    expect(insight.window.games).toBe(30);
  });

  it('produces a stable id of the form templateId:scopeKey:horizonKey', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const insights = formNowTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights[0]!.id).toBe('formNow:account:last30');
  });
});
