import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchupOrPlayerTemplate } from './matchupOrPlayer.js';
import { SUBJECT_TEMPLATES } from './subject.js';
import type { InsightScope } from '../types.js';
import type { Match } from '../../match.js';

const SUBJECT_FIGHTER_ID = 8;
const OPPONENT_CHARACTER_ID = 2;
const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function pairingScope(): InsightScope {
  return {
    kind: 'character',
    key: `character:${SUBJECT_FIGHTER_ID}:vs:${OPPONENT_CHARACTER_ID}`,
    axes: { fighter: SUBJECT_FIGHTER_ID, vs: OPPONENT_CHARACTER_ID },
    filter: (matches) =>
      matches.filter(
        (m) => m.fighter_id === SUBJECT_FIGHTER_ID && m.opponent_id === OPPONENT_CHARACTER_ID,
      ),
  };
}

function buildRow(id: string, index: number, opponentTag: string, win: boolean): Match {
  return {
    id,
    fighter_id: SUBJECT_FIGHTER_ID,
    opponent_id: OPPONENT_CHARACTER_ID,
    time: NOW_MS - (500 - index) * ONE_HOUR_MS,
    win,
    opponent: opponentTag,
    matchType: 'offline-tourney',
  };
}

describe('matchupOrPlayerTemplate (Task 3: player-driven vs matchup-driven)', () => {
  it('declares windowExpressible: false and assertsDirection: true', () => {
    expect(matchupOrPlayerTemplate.windowExpressible).toBe(false);
    expect(matchupOrPlayerTemplate.assertsDirection).toBe(true);
  });

  it('returns hidden at 19 games in the pairing (below 20) even with 3+ distinct opponents', () => {
    const matches: Match[] = [];
    let i = 0;
    const perTag: Array<[string, number]> = [
      ['a', 7],
      ['b', 6],
      ['c', 6],
    ];
    for (const [tag, count] of perTag) {
      for (let g = 0; g < count; g += 1) {
        matches.push(buildRow(`hidden19-${i}`, i, tag, g % 2 === 0));
        i += 1;
      }
    }
    expect(matches.length).toBe(19);
    const insights = matchupOrPlayerTemplate.build({
      matches,
      scope: pairingScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.state).toBe('hidden');
  });

  it('returns hidden at 2 distinct opponents even with 20+ games', () => {
    const matches: Match[] = [];
    for (let i = 0; i < 12; i += 1) {
      matches.push(buildRow(`opp1-${i}`, i, 'onlyone', i % 2 === 0));
    }
    for (let i = 0; i < 10; i += 1) {
      matches.push(buildRow(`opp2-${i}`, 12 + i, 'onlytwo', i % 2 === 0));
    }
    expect(matches.length).toBeGreaterThanOrEqual(20);
    const insights = matchupOrPlayerTemplate.build({
      matches,
      scope: pairingScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.state).toBe('hidden');
  });

  it('returns the player-driven key when one opponent supplies a disproportionate share of losses', () => {
    const matches: Match[] = [];
    let i = 0;
    // Contributor: 8 games, ALL losses.
    for (let g = 0; g < 8; g += 1) {
      matches.push(buildRow(`contrib-${i}`, i, 'bigloser', false));
      i += 1;
    }
    // Two other opponents: 9 and 8 games respectively, ALL wins.
    for (let g = 0; g < 9; g += 1) {
      matches.push(buildRow(`other1-${i}`, i, 'otherone', true));
      i += 1;
    }
    for (let g = 0; g < 8; g += 1) {
      matches.push(buildRow(`other2-${i}`, i, 'othertwo', true));
      i += 1;
    }
    expect(matches.length).toBe(25);
    const insights = matchupOrPlayerTemplate.build({
      matches,
      scope: pairingScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.copy.key).toBe('insights.matchupOrPlayer.player');
    expect(insights[0]!.state).toBe('trend');
  });

  it('returns the matchup-driven key and deltaPoints === null over an evenly-spread fixture', () => {
    const matches: Match[] = [];
    let i = 0;
    for (const tag of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      for (let g = 0; g < 5; g += 1) {
        matches.push(buildRow(`${tag}-${i}`, i, tag, g % 2 === 0));
        i += 1;
      }
    }
    expect(matches.length).toBe(25);
    const insights = matchupOrPlayerTemplate.build({
      matches,
      scope: pairingScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.copy.key).toBe('insights.matchupOrPlayer.matchup');
    expect(insights[0]!.deltaPoints).toBeNull();
  });

  it('SUBJECT_TEMPLATES length is now exactly 6', () => {
    expect(SUBJECT_TEMPLATES).toHaveLength(6);
  });

  it('every template this plan registers declares windowExpressible, and matchupOrPlayer is the only false one', () => {
    const expected: Record<string, boolean> = {
      characterMovers: true,
      rivalMovers: true,
      lastEventRecap: true,
      bestMatchup: true,
      worstMatchup: true,
      matchupOrPlayer: false,
    };
    for (const template of SUBJECT_TEMPLATES) {
      expect(typeof template.windowExpressible).toBe('boolean');
      expect(template.windowExpressible).toBe(expected[template.id]);
    }
  });

  it('no file this task creates declares a bare 20 or 3 numeric-literal notability threshold, except the one declared geometry-constant line', () => {
    const files = ['bestWorstMatchup.ts', 'matchupOrPlayer.ts'];
    const exemptionLine = 'const MATCHUP_OR_PLAYER_MIN_DISTINCT_OPPONENTS = 3;';
    for (const file of files) {
      const sourcePath = fileURLToPath(new URL(`./${file}`, import.meta.url));
      const source = readFileSync(sourcePath, 'utf8');
      const lines = source.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === exemptionLine) {
          continue;
        }
        // Strip strings/comments loosely: only check non-comment code lines for a bare 20/3
        // token (word-boundary numeric literal, not part of a larger number or identifier).
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        const bareTwentyOrThree = /(?<![\w.])(20|3)(?![\w.])/.test(trimmed);
        if (bareTwentyOrThree) {
          // Allow known non-notability numeric contexts (array indices, hour/day arithmetic,
          // door counts) by requiring the match not be inside a comment-only doc line — already
          // filtered above. Any remaining bare 20/3 in these two template files is a real finding.
          expect(`${file}: "${trimmed}"`).toBe(`${file}: <no bare 20 or 3 literal>`);
        }
      }
    }
  });

  it('no file this plan creates re-declares the windowExpressible field itself', () => {
    const files = ['bestWorstMatchup.ts', 'matchupOrPlayer.ts'];
    for (const file of files) {
      const sourcePath = fileURLToPath(new URL(`./${file}`, import.meta.url));
      const source = readFileSync(sourcePath, 'utf8');
      expect(source).not.toMatch(/windowExpressible\s*:\s*boolean/);
      expect(source).not.toMatch(/interface\s+\w*\s*\{[^}]*windowExpressible/s);
    }
  });
});
