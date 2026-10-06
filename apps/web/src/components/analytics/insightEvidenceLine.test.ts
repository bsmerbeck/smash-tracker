import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  ACCOUNT_SCOPE,
  INSIGHT_TEMPLATES,
  buildRateClaim,
  type EvidenceClaim,
  type Insight,
  type InsightScope,
  type InsightState,
  type InsightTemplate,
  type Match,
  type RateValue,
} from '@smash-tracker/shared';
import { EIGHT_K_FIXTURE_OPTIONS, generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import i18n from '@/i18n';
import { formatGrouped } from '@/lib/format';
import { formatPercent } from '@/lib/formatPercent';
import {
  EVIDENCE_SHAPE_DEFAULT,
  buildInsightEvidenceLine,
  resolveEvidenceShape,
  type EvidenceShape,
} from './insightEvidenceLine';

/**
 * Plan 39.1-52 (UAT 39.1 tests 7, 26, 29, 31, 34, 35 — F2/F8/F22/F23): ONE
 * evidence-line builder for every insight caption, labelling each sample by
 * what it is. The expectation table below is hand-written here and never
 * imported from the module under test, so the module cannot grade itself.
 */

const t = i18n.getFixedT('en') as unknown as TFunction;
const LOCALE = 'en';
const NOW_MS = 1_800_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const HORIZON_WORDS = /last 30|last event|last 90 days/;

/** The 19 per-template defaults (plan 39.1-52 GREEN list). */
const EXPECTED_DEFAULT: Record<string, EvidenceShape> = {
  formNow: 'horizon',
  characterMovers: 'horizon',
  rivalMovers: 'horizon',
  ratingMove: 'horizon',
  rosterShift: 'horizon',
  rosterCore: 'lifetime',
  bestMatchup: 'lifetime',
  worstMatchup: 'lifetime',
  secondaryPayoff: 'lifetime',
  pocketCost: 'lifetime',
  lastEventRecap: 'event',
  tiltCost: 'host',
  sessionFatigue: 'host',
  settingGap: 'host',
  volumeForm: 'host',
  mixShift: 'host',
  playRhythm: 'host',
  tierGap: 'host',
  matchupOrPlayer: 'host',
};

/** The per-branch overrides: rosterShift's hidden/steady branches share one 0-game claim. */
const EXPECTED_BY_STATE: Record<string, Partial<Record<InsightState, EvidenceShape>>> = {
  rosterShift: { hidden: 'lifetime', steady: 'lifetime' },
};

function expectedShape(insight: Insight): EvidenceShape {
  return (
    EXPECTED_BY_STATE[insight.templateId]?.[insight.state] ?? EXPECTED_DEFAULT[insight.templateId]!
  );
}

/** Branch-reach rows (7c): every one must be produced by some fixture below. */
const REQUIRED_BRANCHES: { templateId: string; states: InsightState[]; shape: EvidenceShape }[] = [
  { templateId: 'secondaryPayoff', states: ['suggestion', 'trend'], shape: 'lifetime' },
  { templateId: 'secondaryPayoff', states: ['locked'], shape: 'lifetime' },
  { templateId: 'secondaryPayoff', states: ['steady'], shape: 'lifetime' },
  { templateId: 'pocketCost', states: ['hidden'], shape: 'lifetime' },
  { templateId: 'pocketCost', states: ['fact', 'steady'], shape: 'lifetime' },
  { templateId: 'rosterShift', states: ['hidden'], shape: 'lifetime' },
  { templateId: 'rosterShift', states: ['steady'], shape: 'lifetime' },
  { templateId: 'rosterShift', states: ['trend'], shape: 'horizon' },
];

const SUBJECT_FIGHTER_ID = 8;

function characterScope(fighterId: number = SUBJECT_FIGHTER_ID): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

function tierScope(matches: Match[]): InsightScope {
  const a = matches.filter((_, index) => index % 2 === 0);
  const b = matches.filter((_, index) => index % 2 === 1);
  const ids = new Set(matches.map((m) => m.id));
  return {
    kind: 'account',
    key: 'tier:side-excluded',
    axes: {},
    filter: (all) => all.filter((m) => ids.has(m.id)),
    tierCohorts: {
      a,
      b,
      aEvents: a.length > 0 ? 1 : 0,
      bEvents: b.length > 0 ? 1 : 0,
      estimatedEvents: 0,
      knownEvents: matches.length > 0 ? 2 : 0,
    },
  };
}

function scopeFor(template: InsightTemplate, matches: Match[]): InsightScope {
  if (template.id === 'tierGap') return tierScope(matches);
  return template.scopeKind === 'character' ? characterScope() : ACCOUNT_SCOPE;
}

function nowAfter(matches: Match[]): number {
  return matches.reduce((max, m) => Math.max(max, m.time), 0) + ONE_HOUR_MS;
}

function buildEvery(matches: Match[]): Insight[] {
  const nowMs = nowAfter(matches);
  return INSIGHT_TEMPLATES.flatMap((template) =>
    template.build({ matches, scope: scopeFor(template, matches), horizon: 'last30', nowMs }),
  );
}

function sequence(
  games: { fighterId: number; opponentId: number; win: boolean }[],
  prefix: string,
): Match[] {
  return games.map((g, i) => ({
    id: `${prefix}-${i}`,
    fighter_id: g.fighterId,
    opponent_id: g.opponentId,
    time: NOW_MS - (games.length - i) * ONE_HOUR_MS,
    win: g.win,
  }));
}

function block(fighterId: number, wins: number, losses: number, opponentId: number) {
  return [
    ...Array.from({ length: wins }, () => ({ fighterId, opponentId, win: true })),
    ...Array.from({ length: losses }, () => ({ fighterId, opponentId, win: false })),
  ];
}

/** secondaryPayoff: the main (1) and secondary (2) share one opponent character. */
function payoffFixture(p: {
  mainGames: number;
  mainWins: number;
  secGames: number;
  secWins: number;
}): Match[] {
  return sequence(
    [
      ...block(1, p.mainWins, p.mainGames - p.mainWins, 50),
      ...block(1, 60 - p.mainGames, 0, 90),
      ...block(2, p.secWins, p.secGames - p.secWins, 50),
      ...block(2, 25 - p.secGames, 0, 91),
    ],
    `payoff-${p.secGames}-${p.secWins}`,
  );
}

/** pocketCost: a 60-game main plus `pocketFighters` pocket fighters of `gamesEach` games. */
function pocketFixture(pocketFighters: number, gamesEach: number): Match[] {
  const pockets = Array.from({ length: pocketFighters }, (_, f) =>
    block(100 + f, 1, gamesEach - 1, 23),
  ).flat();
  return sequence([...block(1, 45, 15, 23), ...pockets], `pocket-${pocketFighters}-${gamesEach}`);
}

/** rosterShift: `oldTotal` older games then `recentTotal` newer ones; fighter 1 takes the first N of each block. */
function shiftFixture(p: {
  oldX: number;
  recentX: number;
  oldTotal?: number;
  recentTotal?: number;
}): Match[] {
  const { oldX, recentX, oldTotal = 270, recentTotal = 30 } = p;
  const old = Array.from({ length: oldTotal }, (_, i) => ({
    fighterId: i < oldX ? 1 : 2,
    opponentId: 23,
    win: true,
  }));
  const recent = Array.from({ length: recentTotal }, (_, i) => ({
    fighterId: i < recentX ? 1 : 2,
    opponentId: 23,
    win: true,
  }));
  return sequence([...old, ...recent], `shift-${oldX}-${recentX}-${oldTotal}`);
}

/** MkLeo-shaped matchups for fighter 8: 36–40 into one character, 40–10 into another. */
function matchupFixture(): Match[] {
  return sequence([...block(8, 36, 40, 20), ...block(8, 40, 10, 21)], 'matchups');
}

/** sparg0-shaped roster: the main at 3,408–1,156 plus a small secondary. */
function sparg0RosterFixture(): Match[] {
  return sequence([...block(1, 3408, 1156, 23), ...block(2, 300, 200, 23)], 'sparg0');
}

const LARGE = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
const THIN = generateSyntheticMatches({ seed: 8_008, count: 8 });

const BRANCH_FIXTURES: Match[][] = [
  payoffFixture({ mainGames: 30, mainWins: 15, secGames: 20, secWins: 18 }), // suggestion
  payoffFixture({ mainGames: 20, mainWins: 10, secGames: 10, secWins: 9 }), // trend
  payoffFixture({ mainGames: 20, mainWins: 10, secGames: 20, secWins: 10 }), // steady
  payoffFixture({ mainGames: 20, mainWins: 12, secGames: 5, secWins: 5 }), // locked
  pocketFixture(4, 5), // pocketCost fact/steady (20 pooled pocket games)
  pocketFixture(2, 5), // pocketCost hidden (10 pooled pocket games)
  shiftFixture({ oldX: 0, recentX: 5, oldTotal: 0, recentTotal: 10 }), // rosterShift hidden
  shiftFixture({ oldX: 45, recentX: 10 }), // rosterShift trend
  shiftFixture({ oldX: 48, recentX: 10 }), // rosterShift steady
  matchupFixture(),
];

const PRODUCED: Insight[] = [LARGE, THIN, ...BRANCH_FIXTURES].flatMap(buildEvery);

function recordOf(claim: EvidenceClaim<RateValue>): string {
  if (claim.kind !== 'evidenced') throw new Error('recordOf needs an evidenced claim');
  return `${formatGrouped(claim.value.wins, LOCALE)}–${formatGrouped(claim.value.losses, LOCALE)}`;
}

/** The en allTimeOnly caption for an evidenced claim, built here from the locale directly. */
function expectedAllTimeOnly(claim: EvidenceClaim<RateValue>): string {
  if (claim.kind !== 'evidenced') throw new Error('expectedAllTimeOnly needs an evidenced claim');
  const tier = claim.sample.confidenceTier;
  const values = { record: recordOf(claim), rate: formatPercent(claim.value.rate, LOCALE) };
  return tier
    ? t('insights.evidence.allTimeOnly', {
        ...values,
        cue: t(`shared.evidence.sampleCueGlyph.${tier}`, { count: claim.value.total }),
      })
    : t('insights.evidence.allTimeOnly', { ...values, context: 'bare' });
}

function claimOf(wins: number, losses: number): EvidenceClaim<RateValue> {
  const total = wins + losses;
  return buildRateClaim({
    rate: { wins, losses, total, rate: total > 0 ? wins / total : 0 },
    refreshedAt: NOW_MS,
    dateRange: { fromMs: null, toMs: null },
  });
}

function handInsight(overrides: Partial<Insight>): Insight {
  const recent = claimOf(10, 5);
  return {
    id: 'formNow:account:last30',
    templateId: 'formNow',
    scopeKey: 'account',
    horizon: 'last30',
    kind: 'fact',
    state: 'steady',
    recent,
    baseline: claimOf(60, 40),
    deltaPoints: null,
    window: { horizon: 'last30', fromMs: NOW_MS - 1000, toMs: NOW_MS, games: 15, scoped: false },
    salience: 0,
    copy: { key: 'insights.formNow.steady', values: {} },
    doors: [],
    countedMatchIds: [],
    ...overrides,
  };
}

function captionFor(insight: Insight): string | null {
  return buildInsightEvidenceLine(insight, t, LOCALE);
}

describe('buildInsightEvidenceLine — a sample is labelled by what it is (plan 39.1-52)', () => {
  it('non-vacuity: the fixtures produce insights from every registered template', () => {
    const ids = new Set(PRODUCED.map((insight) => insight.templateId));
    expect([...ids].sort()).toEqual(INSIGHT_TEMPLATES.map((tpl) => tpl.id).sort());
  });

  it('(1) a sparg0-shaped rosterCore caption reads all time, never last 30', () => {
    const insight = buildEvery(sparg0RosterFixture()).find((i) => i.templateId === 'rosterCore');
    expect(insight?.state).toBe('fact');
    const line = captionFor(insight!);
    expect(line).toContain('3,408–1,156 · 75% all time');
    expect(line).not.toContain('last 30');
  });

  it('(2) bestMatchup / worstMatchup captions are the allTimeOnly form (MkLeo-shaped Toughest record)', () => {
    const produced = buildEvery(matchupFixture());
    const worst = produced.find((i) => i.templateId === 'worstMatchup');
    const best = produced.find((i) => i.templateId === 'bestMatchup');
    expect(worst?.state).toBe('fact');
    expect(best?.state).toBe('fact');
    expect(captionFor(worst!)).toBe(expectedAllTimeOnly(worst!.recent));
    expect(captionFor(worst!)).toMatch(/^36–40 · 47% all time · /);
    expect(captionFor(best!)).toBe(expectedAllTimeOnly(best!.recent));
  });

  it('(3) pocketCost names the pocket record in the allTimeOnly form', () => {
    const insight = buildEvery(pocketFixture(4, 5)).find((i) => i.templateId === 'pocketCost');
    expect(insight && insight.state !== 'hidden').toBe(true);
    const line = captionFor(insight!);
    expect(line).toBe(expectedAllTimeOnly(insight!.recent));
    expect(line).toMatch(/^4–16 · 20% all time/);
  });

  it('(4) a baseline with 0 games never prints "over 0"', () => {
    const zeroBaseline: EvidenceClaim<RateValue> = {
      ...(claimOf(10, 5) as Extract<EvidenceClaim<RateValue>, { kind: 'evidenced' }>),
      value: { wins: 0, losses: 0, total: 0, rate: 0 },
    };
    const insight = handInsight({ templateId: 'ratingMove', baseline: zeroBaseline });
    const line = captionFor(insight);
    expect(line).not.toBeNull();
    expect(line!).not.toMatch(/over 0\b/);
  });

  it('(5) no confidence tier → no dangling separator', () => {
    const base = claimOf(2, 0);
    const tierless: EvidenceClaim<RateValue> = {
      kind: 'evidenced',
      claimType: 'fact',
      value: { wins: 2, losses: 0, total: 2, rate: 1 },
      sample: { ...base.sample, confidenceTier: null },
    };
    const line = captionFor(handInsight({ recent: tierless }));
    expect(line).not.toBeNull();
    expect(/·\s*$/.test(line!)).toBe(false);
    expect(/·\s*·/.test(line!)).toBe(false);
  });

  it('(6) a horizon insight whose recent claim is not evidenced prints the lifetime-only form', () => {
    const insight = handInsight({ recent: claimOf(2, 0), baseline: claimOf(30, 20) });
    expect(insight.recent.kind).toBe('abstained');
    const line = captionFor(insight);
    expect(line).toBe(expectedAllTimeOnly(insight.baseline));
    expect(line ?? '').not.toContain('2–0 · last 30');
  });

  describe('(7) shape conformance by (template, state)', () => {
    it('(7a) EVIDENCE_SHAPE_DEFAULT classifies exactly the registry ids', () => {
      expect(Object.keys(EVIDENCE_SHAPE_DEFAULT).sort()).toEqual(
        INSIGHT_TEMPLATES.map((tpl) => tpl.id).sort(),
      );
      expect(Object.keys(EXPECTED_DEFAULT).sort()).toEqual(
        INSIGHT_TEMPLATES.map((tpl) => tpl.id).sort(),
      );
    });

    it('(7b) every produced insight resolves to its expected (template, state) shape', () => {
      const wrong = PRODUCED.filter((i) => resolveEvidenceShape(i) !== expectedShape(i)).map(
        (i) => `${i.templateId}:${i.state} → ${resolveEvidenceShape(i)} (want ${expectedShape(i)})`,
      );
      expect([...new Set(wrong)]).toEqual([]);
    });

    it('(7c) the fixtures reach every mixed-branch row', () => {
      const missing = REQUIRED_BRANCHES.filter(
        (row) =>
          !PRODUCED.some(
            (i) =>
              i.templateId === row.templateId &&
              row.states.includes(i.state) &&
              expectedShape(i) === row.shape,
          ),
      ).map((row) => `${row.templateId}:${row.states.join('|')}`);
      expect(missing).toEqual([]);
    });

    it('(7d) window invariance — the shape and caption never read insight.window', () => {
      for (const insight of PRODUCED) {
        const shape = resolveEvidenceShape(insight);
        const caption = captionFor(insight);
        for (const [fromMs, toMs] of [
          [null, null],
          [0, 1],
        ] as const) {
          const moved = { ...insight, window: { ...insight.window, fromMs, toMs } };
          expect(resolveEvidenceShape(moved)).toBe(shape);
          expect(captionFor(moved)).toBe(caption);
        }
      }
    });

    it('(7e) one shared recent/baseline claim is never a horizon sample', () => {
      const wrong = PRODUCED.filter(
        (i) => i.recent === i.baseline && resolveEvidenceShape(i) === 'horizon',
      ).map((i) => `${i.templateId}:${i.state}`);
      expect([...new Set(wrong)]).toEqual([]);
    });

    it('(7f) lifetime captions are allTimeOnly; rosterShift trend is twoHorizon; empty samples print nothing', () => {
      const problems: string[] = [];
      for (const insight of PRODUCED) {
        const shape = expectedShape(insight);
        const caption = captionFor(insight);
        const label = `${insight.templateId}:${insight.state}`;
        if ((shape === 'lifetime' || shape === 'event') && insight.recent.kind !== 'evidenced') {
          if (caption !== null) problems.push(`${label} printed "${caption}" for an empty sample`);
          continue;
        }
        if (shape === 'lifetime') {
          if (caption !== expectedAllTimeOnly(insight.recent)) {
            problems.push(`${label} printed "${caption}"`);
          }
          if (caption !== null && HORIZON_WORDS.test(caption)) {
            problems.push(`${label} carries a horizon word: "${caption}"`);
          }
        }
        if (insight.templateId === 'rosterShift' && insight.state === 'trend') {
          if (!caption || !caption.includes('last 30') || !caption.includes('all time over')) {
            problems.push(`${label} is not the twoHorizon form: "${caption}"`);
          }
        }
      }
      expect([...new Set(problems)]).toEqual([]);
    });
  });
});
