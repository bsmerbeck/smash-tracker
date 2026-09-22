import type { InsightTemplateId, Match } from '@smash-tracker/shared';

/**
 * Plan 39.1-29 (gap closure, SC4/INS-04): the registry-driven, typed host
 * inventory `insightDoorReachability.test.tsx` walks to prove every insight
 * template is reachable from a REAL rendered page — the Finding 10 lesson
 * (a library-level oracle nothing renders proves nothing). A test-support
 * module beside `mockAuth.ts`, not a test file itself: no `describe`/`it`.
 *
 * `INSIGHT_DOOR_HOSTS` is typed `Record<InsightTemplateId, readonly
 * InsightDoorHost[]>` — the TypeScript compiler itself rejects a missing
 * template id, and `insightDoorReachability.test.tsx`'s "registry coverage"
 * describe additionally asserts at runtime that every entry is non-empty.
 *
 * Fixture builders below are deterministic (real-clock relative — every
 * builder reads `Date.now()` at CALL time, mirroring the existing per-page
 * test convention in `FighterAnalysisPage.test.tsx`/`MatchDataPage.test.tsx`/
 * `TrendsPage.test.tsx`, never frozen), small, and ported from those pages'
 * own proven fixture builders rather than invented from scratch.
 */

export type InsightDoorSurface =
  | 'fighter-hero'
  | 'fighter-rail'
  | 'match-data-rail'
  | 'trends-rail'
  | 'trends-setting'
  | 'trends-mix'
  | 'matchups-chart'
  | 'matchups-card'
  | 'opponent-hub-trend';

export interface InsightDoorHostFixture {
  matches: Match[];
  /** The saved fighter selection (`getFighters` primary) the host page should resolve on. Ignored by pages that never call `getFighters` (TrendsPage). */
  primaryFighterId: number;
  /**
   * Insight ids (`${templateId}:${scopeKey}:${horizon}`) to pre-dismiss so a
   * CAPPED rail (fighter-rail/match-data-rail/trends-rail, cap 3) doesn't
   * hide the target template's card behind sibling candidates. Empty for
   * every non-rail surface (formNow/matchupOrPlayer/settingGap/mixShift/
   * volumeForm doors are never rail-capped).
   */
  dismissIds?: string[];
  /** The `/opponents/:opponentTag` route segment — only read by `opponent-hub-trend`. */
  opponentTag?: string;
  /** Extra search params appended to `personalPath` for a context-carrying variant (URL-seeded pairing, `vs`+`context`). */
  search?: string;
}

export interface InsightDoorHost {
  surface: InsightDoorSurface;
  /** Leading-slash path (with any query string already appended) under the personal (own-account) route family. */
  personalPath: string;
  coachMountable: boolean;
  /** A CSS selector, OR (prefixed `text:`) a card-title text to resolve via `getByText(...).closest('[data-slot="card"]')` — see `resolveDoorRegion` in the reachability suite. */
  doorRegion: string;
  terminusAnchorId: 'games' | 'matchup-table' | 'opponent-hub-list';
  fixture: () => InsightDoorHostFixture;
}

// ---------------------------------------------------------------------------
// Shared identities (mirrors the existing page tests' own sprite picks).
// ---------------------------------------------------------------------------
const MARIO_ID = 1;
const LUIGI_ID = 10;
const FOX_ID = 8;
const DK_ID = 2;
const WFT_ID = 50;
const MAIN_FILLER_OPPONENT = 90;
const SECONDARY_FILLER_OPPONENT = 91;

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const DEFAULT_HORIZON = 'last30';

function railInsightId(templateId: InsightTemplateId, scopeKey: string): string {
  return `${templateId}:${scopeKey}:${DEFAULT_HORIZON}`;
}

const FIGHTER_RAIL_TEMPLATE_IDS: InsightTemplateId[] = [
  'characterMovers',
  'rivalMovers',
  'lastEventRecap',
  'bestMatchup',
  'worstMatchup',
];
const MATCH_DATA_RAIL_TEMPLATE_IDS: InsightTemplateId[] = [
  'rosterCore',
  'rosterShift',
  'secondaryPayoff',
  'pocketCost',
  'bestMatchup',
  'worstMatchup',
];
const TRENDS_RAIL_TEMPLATE_IDS: InsightTemplateId[] = [
  'ratingMove',
  'tiltCost',
  'sessionFatigue',
  'bestMatchup',
  'worstMatchup',
];

function fighterRailScopeKey(fighterId: number): string {
  return `character:${fighterId}`;
}
const ACCOUNT_SCOPE_KEY = 'account';

function siblingDismissals(
  allIds: InsightTemplateId[],
  target: InsightTemplateId,
  scopeKey: string,
): string[] {
  return allIds.filter((id) => id !== target).map((id) => railInsightId(id, scopeKey));
}

function mk(
  overrides: Partial<Record<string, unknown>> & { id: string; time: number; win: boolean },
): Match {
  return {
    fighter_id: MARIO_ID,
    opponent_id: LUIGI_ID,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  } as Match;
}

function block(
  fighterId: number,
  opponentId: number,
  wins: number,
  losses: number,
  idPrefix: string,
  opts: {
    startMs: number;
    spacingMs?: number;
    matchType?: string;
    eventName?: string;
    opponentTag?: string;
  },
): Match[] {
  const spacing = opts.spacingMs ?? HOUR;
  const total = wins + losses;
  const out: Match[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push(
      mk({
        id: `${idPrefix}-${i}`,
        fighter_id: fighterId,
        opponent_id: opponentId,
        time: opts.startMs - (total - i) * spacing,
        win: i < wins,
        ...(opts.matchType ? { matchType: opts.matchType } : {}),
        ...(opts.eventName ? { eventName: opts.eventName } : {}),
        ...(opts.opponentTag ? { opponent: opts.opponentTag } : {}),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// formNow fixtures — a plain evenly-spaced recent win/loss run, well past
// ABSTENTION_FLOOR_GAMES (3), for whichever pairing/tag the host needs.
// ---------------------------------------------------------------------------

function formNowFighterHeroFixture(): InsightDoorHostFixture {
  const now = Date.now();
  const matches = Array.from({ length: 40 }, (_, i) =>
    mk({
      id: `hero-fn-${i}`,
      fighter_id: MARIO_ID,
      opponent_id: LUIGI_ID,
      time: now - (40 - i) * HOUR,
      win: i % 3 !== 0,
    }),
  );
  return { matches, primaryFighterId: MARIO_ID };
}

function formNowMatchupsChartFixture(seedFighterId: number): InsightDoorHostFixture {
  const now = Date.now();
  const opponents = ['alice', 'bob', 'carol', 'dave'];
  const matches = Array.from({ length: 40 }, (_, i) =>
    mk({
      id: `chart-fn-${i}`,
      fighter_id: seedFighterId,
      opponent_id: LUIGI_ID,
      time: now - (40 - i) * HOUR,
      opponent: opponents[i % opponents.length],
      win: i % 3 !== 0,
    }),
  );
  return { matches, primaryFighterId: MARIO_ID };
}

function formNowOpponentHubFixture(
  opponentTag = 'rival',
  opts: { matchType?: string; fighterId?: number; opponentId?: number } = {},
): InsightDoorHostFixture {
  const now = Date.now();
  const matches = Array.from({ length: 10 }, (_, i) =>
    mk({
      id: `hub-fn-${i}`,
      time: now - (10 - i) * HOUR,
      opponent: opponentTag,
      win: i % 3 !== 0,
      ...(opts.matchType ? { matchType: opts.matchType } : {}),
      ...(opts.fighterId != null ? { fighter_id: opts.fighterId } : {}),
      ...(opts.opponentId != null ? { opponent_id: opts.opponentId } : {}),
    }),
  );
  return { matches, primaryFighterId: MARIO_ID, opponentTag };
}

// ---------------------------------------------------------------------------
// Fighter Analysis rail fixtures (character:${MARIO_ID} scope).
// ---------------------------------------------------------------------------

/**
 * A genuine engineered mover: a 40-game 50%-win-rate baseline block against
 * one opponent character/tag, followed immediately by a 30-game 100%-win
 * -rate shift block against the SAME opponent character/tag — mirrors
 * `characterMovers.test.ts`'s `buildEngineeredMoverFixture`. A `steady`
 * (flat) win rate — e.g. the same rate throughout — renders as an
 * `insight-rail-lines` LINE, never a card with a door (`rail.ts`'s
 * `assembleRail`: `steady`/`thinRecent` -> lines, only `trend`/`suggestion`/
 * `fact`/`collapsed`/`thin` -> cards); the genuine delta here is what
 * produces a real `trend` CARD. Drives characterMovers (opponent-CHARACTER
 * grouped) AND rivalMovers (opponent-TAG grouped) identically, since both
 * blocks share the SAME `opponent_id` and `opponent` tag.
 */
function moverFixture(): Match[] {
  const now = Date.now();
  const opponentId = 86;
  const opponentTag = 'mover-rival';
  const baseline = block(MARIO_ID, opponentId, 20, 20, 'mover-old', {
    startMs: now - 70 * HOUR,
    opponentTag,
  });
  const shift = block(MARIO_ID, opponentId, 30, 0, 'mover-shift', {
    startMs: now,
    opponentTag,
  });
  return [...baseline, ...shift];
}

function lastEventRecapFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) =>
    mk({
      id: `ler-${i}`,
      fighter_id: MARIO_ID,
      opponent_id: LUIGI_ID,
      time: now - (5 - i) * HOUR,
      win: i % 2 === 0,
      eventName: 'Genesis 12',
    }),
  );
}

/** A clear best (high win rate) + worst (low win rate) opponent pairing — drives bestMatchup/worstMatchup on any scope (character or account; accountScope's filter is the identity so `fighterId` is irrelevant there). */
function bestWorstMatchupFixture(fighterId: number): Match[] {
  const now = Date.now();
  return [
    ...block(fighterId, LUIGI_ID, 2, 0, 'bw-lucky', { startMs: now - 200 * HOUR }),
    ...block(fighterId, FOX_ID, 22, 3, 'bw-best', { startMs: now - 150 * HOUR }),
    ...block(fighterId, DK_ID, 3, 22, 'bw-worst', { startMs: now - 100 * HOUR }),
  ];
}

function fighterRailHostFor(target: InsightTemplateId): InsightDoorHost {
  const scopeKey = fighterRailScopeKey(MARIO_ID);
  return {
    surface: 'fighter-rail',
    personalPath: '/fighter-analysis',
    coachMountable: true,
    doorRegion: '[data-slot="insight-rail-cards"]',
    terminusAnchorId: 'games',
    fixture: () => {
      const matches =
        target === 'lastEventRecap'
          ? lastEventRecapFixture()
          : target === 'bestMatchup' || target === 'worstMatchup'
            ? bestWorstMatchupFixture(MARIO_ID)
            : moverFixture();
      return {
        matches,
        primaryFighterId: MARIO_ID,
        dismissIds: siblingDismissals(FIGHTER_RAIL_TEMPLATE_IDS, target, scopeKey),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Match Data rail fixtures (account scope).
// ---------------------------------------------------------------------------

/** 45 mario games — clears `ROSTER_MAIN_MIN_GAMES` (20). Mirrors MatchDataPage.test.tsx's `richRosterFixture`. */
function rosterCoreFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 45 }, (_, i) =>
    mk({
      id: `roster-${i}`,
      fighter_id: MARIO_ID,
      time: now - (45 - i) * HOUR,
      win: i % 2 === 0,
    }),
  );
}

/** 200 baseline (offline-tourney) + 30 recent (quickplay) games on two different fighters — a real fighter-share shift. Mirrors insightDoorSameN.test.tsx's `buildRosterShiftFixture`. */
function rosterShiftFixture(): Match[] {
  const now = Date.now();
  const baselineFighter = 9;
  const recentFighter = 20;
  const matches: Match[] = [];
  for (let i = 0; i < 200; i += 1) {
    matches.push(
      mk({
        id: `rs-base-${i}`,
        fighter_id: baselineFighter,
        opponent_id: LUIGI_ID,
        time: now - (1000 - i) * HOUR,
        win: i % 2 === 0,
        matchType: 'offline-tourney',
      }),
    );
  }
  for (let i = 0; i < 30; i += 1) {
    matches.push(
      mk({
        id: `rs-recent-${i}`,
        fighter_id: recentFighter,
        opponent_id: LUIGI_ID,
        time: now - (30 - i) * HOUR,
        win: i % 2 === 0,
        matchType: 'quickplay',
      }),
    );
  }
  return matches;
}

/** Main fighter's payoff vs a secondary — mirrors insightCoachParity.test.tsx's `secondaryPayoffFixture`. */
function secondaryPayoffFixture(): Match[] {
  const now = Date.now();
  const mainBlock = [
    ...block(MARIO_ID, WFT_ID, 15, 15, 'sp-main-wft', { startMs: now - 300 * HOUR }),
    ...block(MARIO_ID, MAIN_FILLER_OPPONENT, 30, 0, 'sp-main-filler', {
      startMs: now - 200 * HOUR,
    }),
  ];
  const secondaryBlock = [
    ...block(DK_ID, WFT_ID, 18, 2, 'sp-sec-wft', { startMs: now - 100 * HOUR }),
    ...block(DK_ID, SECONDARY_FILLER_OPPONENT, 5, 0, 'sp-sec-filler', { startMs: now - 20 * HOUR }),
  ];
  return [...mainBlock, ...secondaryBlock];
}

/**
 * 60 main-fighter games at an 83% win rate + 8 distinct "pocket" fighters
 * (5 games each, 40 pooled, comfortably over `ROSTER_MAIN_MIN_GAMES`) at a
 * 20% win rate — a wide enough main-vs-pockets gap to clear
 * `isNotableCohortGap` and land `state: 'fact'` (not the flatter `'steady'`
 * a narrower gap produces — a `'steady'` PocketCost renders as an
 * `insight-line`, never a card with a door). Mirrors `pocketCost.test.ts`'s
 * own fixture shape, widened for notability.
 */
function pocketCostFixture(): Match[] {
  const now = Date.now();
  const matches: Match[] = [
    ...block(MARIO_ID, 23, 50, 10, 'pc-main', { startMs: now - 400 * HOUR }),
  ];
  for (let f = 0; f < 8; f += 1) {
    const fighterId = 100 + f;
    matches.push(
      ...block(fighterId, 23, 1, 4, `pc-pocket-${f}`, { startMs: now - (100 - f * 5) * HOUR }),
    );
  }
  return matches;
}

type MatchDataRailTemplateId = 'rosterCore' | 'rosterShift' | 'secondaryPayoff' | 'pocketCost';

function matchDataRailHostFor(target: MatchDataRailTemplateId): InsightDoorHost {
  return {
    surface: 'match-data-rail',
    personalPath: '/match-data',
    coachMountable: true,
    doorRegion: '[data-slot="insight-rail-cards"]',
    terminusAnchorId: 'games',
    fixture: () => {
      const matches =
        target === 'rosterCore'
          ? rosterCoreFixture()
          : target === 'rosterShift'
            ? rosterShiftFixture()
            : target === 'secondaryPayoff'
              ? secondaryPayoffFixture()
              : pocketCostFixture();
      return {
        matches,
        primaryFighterId: MARIO_ID,
        dismissIds: siblingDismissals(MATCH_DATA_RAIL_TEMPLATE_IDS, target, ACCOUNT_SCOPE_KEY),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Trends reads rail fixtures (account scope).
// ---------------------------------------------------------------------------

/** 5 small-sample games — clears `ABSTENTION_FLOOR_GAMES` (3) but stays a real, asserting "thin" fact. Mirrors TrendsPage.test.tsx's `ratingCardFixture`. */
function ratingMoveFixture(): Match[] {
  const now = Date.now();
  return [
    mk({ id: 'rm-g1', time: now - 5 * MINUTE, win: true }),
    mk({ id: 'rm-g2', time: now - 4 * MINUTE, win: false }),
    mk({ id: 'rm-g3', time: now - 3 * MINUTE, win: true }),
    mk({ id: 'rm-g4', time: now - 2 * MINUTE, win: false }),
    mk({ id: 'rm-g5', time: now - 1 * MINUTE, win: true }),
  ];
}

/** 8 wins then 5 losses, repeated 3x (39 games, 11 "spots" >= COHORT_MIN_SIDE_GAMES) — a real `trend` state. Mirrors `tiltCost.test.ts`'s `UNDERPERFORM_BLOCK`. */
function tiltCostFixture(): Match[] {
  const now = Date.now();
  const underperformBlock = [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
  ];
  const outcomes = [...underperformBlock, ...underperformBlock, ...underperformBlock];
  return outcomes.map((win, i) =>
    mk({
      id: `tc-${i}`,
      fighter_id: FOX_ID,
      opponent_id: 23,
      time: now - (outcomes.length - i) * MINUTE,
      win,
    }),
  );
}

/** 10 sessions of 21 games each, first 10 games of every session a win, the trailing game a loss — a clear `trend` fatigue read. Mirrors `sessionFatigue.test.ts`'s non-hidden case. */
function sessionFatigueFixture(): Match[] {
  const now = Date.now();
  const withinSessionGapMs = MINUTE;
  const betweenSessionGapMs = 4 * HOUR;
  const matches: Match[] = [];
  let t = now - 10 * (21 * withinSessionGapMs + betweenSessionGapMs);
  for (let s = 0; s < 10; s += 1) {
    for (let g = 0; g < 21; g += 1) {
      matches.push(
        mk({ id: `sf-s${s}g${g}`, fighter_id: FOX_ID, opponent_id: 23, time: t, win: g < 10 }),
      );
      t += withinSessionGapMs;
    }
    t += betweenSessionGapMs;
  }
  return matches;
}

type TrendsRailTemplateId = 'ratingMove' | 'tiltCost' | 'sessionFatigue';

function trendsRailHostFor(target: TrendsRailTemplateId): InsightDoorHost {
  return {
    surface: 'trends-rail',
    personalPath: '/trends',
    coachMountable: false,
    doorRegion: '[data-slot="insight-rail-cards"]',
    terminusAnchorId: 'games',
    fixture: () => {
      const matches =
        target === 'ratingMove'
          ? ratingMoveFixture()
          : target === 'tiltCost'
            ? tiltCostFixture()
            : sessionFatigueFixture();
      return {
        matches,
        primaryFighterId: MARIO_ID,
        dismissIds: siblingDismissals(TRENDS_RAIL_TEMPLATE_IDS, target, ACCOUNT_SCOPE_KEY),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Matchups card (matchupOrPlayer) — mirrors MatchupsPage.test.tsx's
// `richMatchupOrPlayerFixture`.
// ---------------------------------------------------------------------------

function matchupOrPlayerFixture(seedFighterId: number): InsightDoorHostFixture {
  const now = Date.now();
  const opponents = ['alice', 'bob', 'carol', 'dave'];
  const matches = Array.from({ length: 40 }, (_, i) =>
    mk({
      id: `mop-${i}`,
      fighter_id: seedFighterId,
      opponent_id: LUIGI_ID,
      time: now - (40 - i) * HOUR,
      opponent: opponents[i % opponents.length],
      win: i % 3 !== 0,
    }),
  );
  return { matches, primaryFighterId: MARIO_ID };
}

// ---------------------------------------------------------------------------
// Trends Setting comparison / Match-type mix — mirror
// TrendsPage.test.tsx's `settingGapDoorFixtureWithFiller` /
// `mixShiftAndVolumeFormFixture`.
// ---------------------------------------------------------------------------

function settingGapFixture(): Match[] {
  const now = Date.now();
  const online = Array.from({ length: 10 }, (_, i) =>
    mk({ id: `sg-on${i}`, time: now - (10 - i) * MINUTE, win: true, matchType: 'quickplay' }),
  );
  const offline = Array.from({ length: 10 }, (_, i) =>
    mk({
      id: `sg-off${i}`,
      time: now - (10 - i) * MINUTE,
      win: false,
      matchType: 'offline-tourney',
    }),
  );
  const filler = Array.from({ length: 5 }, (_, i) =>
    mk({ id: `sg-unspec${i}`, time: now - (5 - i) * MINUTE, win: true, matchType: 'none' }),
  );
  return [...online, ...offline, ...filler];
}

function mixShiftVolumeFormFixture(): Match[] {
  const now = Date.now();
  const old = Array.from({ length: 70 }, (_, i) =>
    mk({
      id: `mix-old-${i}`,
      time: now - (1000 - i) * MINUTE,
      win: true,
      matchType: 'offline-tourney',
    }),
  );
  const recent = Array.from({ length: 30 }, (_, i) =>
    mk({
      id: `mix-recent-${i}`,
      time: now - (30 - i) * MINUTE,
      win: true,
      matchType: 'online-tourney',
    }),
  );
  return [...old, ...recent];
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

const FIGHTER_HERO_HOST: InsightDoorHost = {
  surface: 'fighter-hero',
  personalPath: '/fighter-analysis',
  coachMountable: true,
  doorRegion: '[data-slot="fighter-hero-doors"]',
  terminusAnchorId: 'games',
  fixture: formNowFighterHeroFixture,
};

const MATCHUPS_CHART_HOST: InsightDoorHost = {
  surface: 'matchups-chart',
  personalPath: `/matchups?fighter=${MARIO_ID}&vs=${LUIGI_ID}`,
  coachMountable: true,
  doorRegion: '[data-slot="matchup-form-now"]',
  terminusAnchorId: 'matchup-table',
  fixture: () => formNowMatchupsChartFixture(MARIO_ID),
};

const OPPONENT_HUB_HOST: InsightDoorHost = {
  surface: 'opponent-hub-trend',
  personalPath: '/opponents/rival',
  coachMountable: true,
  doorRegion: '[data-slot="opponent-form-now"]',
  terminusAnchorId: 'opponent-hub-list',
  fixture: () => formNowOpponentHubFixture('rival'),
};

const MATCHUPS_CARD_HOST: InsightDoorHost = {
  surface: 'matchups-card',
  personalPath: `/matchups?fighter=${MARIO_ID}&vs=${LUIGI_ID}`,
  coachMountable: true,
  doorRegion: '[data-slot="insight-card"]',
  terminusAnchorId: 'matchup-table',
  fixture: () => matchupOrPlayerFixture(MARIO_ID),
};

const TRENDS_SETTING_HOST: InsightDoorHost = {
  surface: 'trends-setting',
  personalPath: '/trends',
  coachMountable: false,
  doorRegion: 'text:Setting Comparison',
  terminusAnchorId: 'games',
  fixture: () => ({ matches: settingGapFixture(), primaryFighterId: MARIO_ID }),
};

const TRENDS_MIX_HOST: InsightDoorHost = {
  surface: 'trends-mix',
  personalPath: '/trends',
  coachMountable: false,
  doorRegion: 'text:Match-Type Mix',
  terminusAnchorId: 'games',
  fixture: () => ({ matches: mixShiftVolumeFormFixture(), primaryFighterId: MARIO_ID }),
};

/**
 * Reachability finding (plan 39.1-29, recorded verbatim in the SUMMARY):
 * `bestMatchup`/`worstMatchup` ARE wired into `MatchDataRail.tsx`'s and
 * `TrendsReadsRail.tsx`'s own `RAIL_TEMPLATES` arrays, but both templates
 * guard `if (scope.kind !== 'character') return null` internally
 * (`bestWorstMatchup.ts`), and both rails call `template.build({ ..., scope:
 * ACCOUNT_SCOPE })` — `ACCOUNT_SCOPE.kind === 'account'`. Each rail's OWN
 * source doc comment says this explicitly: "they never actually contribute
 * a card here today — they're wired for consistency with the other two
 * rails". This is confirmed, documented, INTENTIONAL production behavior
 * (not a bug this test-only plan may fix, per its own prohibition) — so
 * Match Data rail and Trends reads rail are NOT live hosts for these two
 * templates, contradicting this plan's own must_haves hypothesis ("bestMatchup,
 * worstMatchup -> Fighter Analysis rail, Match Data rail, Trends reads
 * rail"). Their only live host is the Fighter Analysis rail, where
 * `FighterInsightRail.tsx` calls them with a real character scope.
 */
export const INSIGHT_DOOR_HOSTS: Record<InsightTemplateId, readonly InsightDoorHost[]> = {
  formNow: [FIGHTER_HERO_HOST, MATCHUPS_CHART_HOST, OPPONENT_HUB_HOST],
  characterMovers: [fighterRailHostFor('characterMovers')],
  rivalMovers: [fighterRailHostFor('rivalMovers')],
  lastEventRecap: [fighterRailHostFor('lastEventRecap')],
  bestMatchup: [fighterRailHostFor('bestMatchup')],
  worstMatchup: [fighterRailHostFor('worstMatchup')],
  rosterCore: [matchDataRailHostFor('rosterCore')],
  rosterShift: [matchDataRailHostFor('rosterShift')],
  secondaryPayoff: [matchDataRailHostFor('secondaryPayoff')],
  pocketCost: [matchDataRailHostFor('pocketCost')],
  ratingMove: [trendsRailHostFor('ratingMove')],
  tiltCost: [trendsRailHostFor('tiltCost')],
  sessionFatigue: [trendsRailHostFor('sessionFatigue')],
  matchupOrPlayer: [MATCHUPS_CARD_HOST],
  settingGap: [TRENDS_SETTING_HOST],
  mixShift: [TRENDS_MIX_HOST],
  volumeForm: [TRENDS_MIX_HOST],
};

/** Context-carrying variants (plan 39.1-29 must_haves): a URL-seeded pairing differing from the persisted one for both Matchups hosts, and a `vs`+`context`-narrowed hub. Not part of the registry's per-template mapping — these are additional cases the reachability suite runs against the SAME templates above, with different `search`. */
export const BOWSER_ID = 16;

export function matchupsChartUrlSeededFixture(): InsightDoorHostFixture {
  const fx = formNowMatchupsChartFixture(BOWSER_ID);
  return { ...fx, search: `?fighter=${BOWSER_ID}&vs=${LUIGI_ID}` };
}

export function matchupsCardUrlSeededFixture(): InsightDoorHostFixture {
  const fx = matchupOrPlayerFixture(BOWSER_ID);
  return { ...fx, search: `?fighter=${BOWSER_ID}&vs=${LUIGI_ID}` };
}

export function opponentHubContextFixture(): InsightDoorHostFixture {
  const fx = formNowOpponentHubFixture('rival', { matchType: 'quickplay', opponentId: LUIGI_ID });
  return { ...fx, search: `?vs=${LUIGI_ID}&context=online` };
}
