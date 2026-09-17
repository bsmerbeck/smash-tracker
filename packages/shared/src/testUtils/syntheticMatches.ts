import type { Match, MatchType } from '../match.js';
import { SpriteList } from '../fighterData.js';
import { StageList } from '../stageData.js';
import { mulberry32, pick, weightedPick, intBetween } from './prng.js';

/**
 * Deterministic seeded synthetic match generator (FIXT-02, SCL-01, D-18).
 * Both the shared-package bench and any downstream measurement (the API
 * payload budget test, a later Puppeteer-driven paint/heap protocol) import
 * this SAME function via the `./testUtils` package subpath, so every
 * measurement in this phase runs over byte-identical data for a given seed —
 * that is the entire point of building one generator instead of several
 * ad-hoc fixtures.
 *
 * Fixed, never wall-clock: `startMs` defaults to a literal constant, never
 * `Date.now()`. Two calls with the same options always produce the same
 * `Match[]` (asserted by `syntheticMatches.test.ts`'s byte-identity test).
 */

/** Never `Date.now()` — a fixed reference point so output never depends on when the test runs. */
const FIXED_START_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

/** Comfortably above `splitIntoSessions`' 3-hour default gap (`glicko.ts`), so sessions are always separable. */
const DEFAULT_SESSION_GAP_MS = 4 * 60 * 60 * 1000;

const ALL_FIGHTER_IDS: number[] = SpriteList.map((fighter) => fighter.id);
const ALL_KNOWN_STAGES: { id: number; name: string }[] = StageList.map((stage) => ({
  id: stage.id,
  name: stage.name,
}));

/** Three real roster mains (Fox, Falco, Marth — `fighterData.ts`), the MkLeo/Sparg0-shaped default. */
const DEFAULT_MAIN_FIGHTER_IDS = [8, 22, 23];

/**
 * Realistic mix across online/offline/quickplay/legacy-empty (`''`), drawn
 * from the real closed `matchType` enum (`match.ts`'s `matchTypeValues`) plus
 * the legacy empty-string case the read schema also accepts.
 */
const MATCH_TYPE_POOL: readonly (readonly [MatchType | '', number])[] = [
  ['online-tourney', 3],
  ['online-friendly', 2],
  ['quickplay', 2],
  ['offline-tourney', 2],
  ['offline-friendly', 1],
  ['none', 1],
  ['', 1],
];

/** `undefined` = manual (absent `source`), matching real cohort composition (`cohort.ts`). */
const SOURCE_POOL: readonly (readonly ['startgg' | 'parrygg' | undefined, number])[] = [
  [undefined, 5],
  ['startgg', 3],
  ['parrygg', 2],
];

export interface SyntheticMatchOptions {
  /** Seeds the generator; identical seed + options always produce identical output. */
  seed: number;
  /** Number of rows to generate. */
  count: number;
  /** Fixed reference timestamp the first game is anchored to. Never `Date.now()`. */
  startMs?: number;
  /** Inclusive [min, max] games per play session, before a `sessionGapMs` jump. */
  sessionSizeRange?: [number, number];
  /** Gap between sessions, comfortably above `splitIntoSessions`' 3h default so sessions stay separable. */
  sessionGapMs?: number;
  /** The player's "main" fighter ids — 2-3 dominant characters, MkLeo/Sparg0-shaped (D-15, EVID-01). */
  mainFighterIds?: number[];
  /** Fraction of games drawn from `mainFighterIds` rather than the long-tail roster. */
  mainFighterShare?: number;
  /** Size of the pool of distinct human opponent tags drawn from for non-alias rows. */
  opponentCount?: number;
  /** Fraction of rows with no known stage (an absent `map`, never `map: null`). */
  unknownStageRate?: number;
  /** Fraction of rows that are wins. */
  winRate?: number;
  /**
   * Two raw opponent tags that MUST normalize (via the engine's
   * `normalizeOpponentTag`) to two DIFFERENT strings — a sponsor-prefix pair
   * would collapse to one string and make the alias map irrelevant (R1
   * review finding). Defaults to two genuinely different names.
   */
  aliasSplitOpponentTags?: [string, string];
  /**
   * A start.gg-shaped slug bound to the SAME person as `aliasSplitOpponentTags`
   * — written on some of that person's rows (including at least one row with
   * no `opponent` tag at all, and at least one row carrying both the slug
   * and a tag), exercising `opponentEvidence.ts`'s slug-binding pass.
   */
  aliasSplitOpponentSlug?: string;
  /**
   * Restricts which fighter id an OPPONENT's character (`opponent_id`) is
   * drawn from — Claude's discretion (36-CONTEXT.md: "the generator's
   * distribution parameters"), needed so a caller can build a fully
   * homogeneous small fixture (e.g. a 3-game single-matchup workspace) for a
   * boundary test, without which `opponent_id` would be uncontrollably
   * uniform across the 86-fighter roster. Defaults to the full roster.
   */
  opponentFighterIds?: number[];
  /**
   * Restricts which stage a known-stage row draws from — same rationale as
   * `opponentFighterIds`, for the stage axis. Defaults to the full stage
   * list (`stageData.ts`).
   */
  stageIds?: number[];
}

/** 8000-row preset every SCL-01 measurement in this phase shares (a fixed literal seed, per D-18/D-26). */
export const EIGHT_K_FIXTURE_OPTIONS: SyntheticMatchOptions = { seed: 8_000_424, count: 8000 };
/** 50000-row preset — same rationale as `EIGHT_K_FIXTURE_OPTIONS`, at the SCL-01 upper budget size. */
export const FIFTY_K_FIXTURE_OPTIONS: SyntheticMatchOptions = { seed: 50_000_424, count: 50000 };

interface AliasRole {
  opponentTag?: string;
  opponentUserSlug?: string;
}

/**
 * The alias-split identity's eight rows: three under each raw tag, one
 * slug-only (no tag at all — exercises the unbound slug-lookup path), and
 * one binding row carrying BOTH the slug and a tag (the row that teaches
 * `resolveOpponentIdentities` which canonical identity the slug belongs to).
 */
function buildAliasRoles(tags: [string, string], slug: string): AliasRole[] {
  const [tag1, tag2] = tags;
  return [
    { opponentTag: tag1 },
    { opponentTag: tag1 },
    { opponentTag: tag1 },
    { opponentTag: tag2 },
    { opponentTag: tag2 },
    { opponentTag: tag2 },
    { opponentUserSlug: slug },
    { opponentUserSlug: slug, opponentTag: tag1 },
  ];
}

/** Spreads the alias roles evenly across `[0, count)` so they aren't all clustered in one session. */
function placeAliasRoles(count: number, roles: AliasRole[]): Map<number, AliasRole> {
  const usable = Math.min(roles.length, count);
  const placements = new Map<number, AliasRole>();
  if (usable <= 0) {
    return placements;
  }
  const stride = Math.max(1, Math.floor(count / usable));
  for (let roleIndex = 0; roleIndex < usable; roleIndex += 1) {
    const at = Math.min(count - 1, roleIndex * stride);
    placements.set(at, roles[roleIndex]!);
  }
  return placements;
}

function buildRow(params: {
  id: string;
  time: number;
  fighterId: number;
  opponentFighterId: number;
  win: boolean;
  matchType: MatchType | '';
  source?: 'startgg' | 'parrygg';
  map?: { id: number; name: string };
  opponentTag?: string;
  opponentUserSlug?: string;
}): Match {
  const {
    id,
    time,
    fighterId,
    opponentFighterId,
    win,
    matchType,
    source,
    map,
    opponentTag,
    opponentUserSlug,
  } = params;
  return {
    id,
    fighter_id: fighterId,
    opponent_id: opponentFighterId,
    time,
    win,
    matchType,
    ...(map !== undefined ? { map } : {}),
    ...(opponentTag !== undefined ? { opponent: opponentTag } : {}),
    ...(opponentUserSlug !== undefined ? { opponentUserSlug } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * Generates a deterministic `Match[]` shaped like a real multi-character
 * player's history: 2-3 dominant "mains" plus a long tail (D-15, EVID-01),
 * session-clustered timestamps (not uniform-random), a realistic
 * online/offline/source mix, an unknown-stage rate, and one deliberately
 * alias-split opponent identity (EVID-12 fixture requirement). Every row
 * uses the conditional-spread shape the real writer uses — an unknown-stage
 * row OMITS `map` entirely, never sets it to `null`.
 */
export function generateSyntheticMatches(options: SyntheticMatchOptions): Match[] {
  const {
    seed,
    count,
    startMs = FIXED_START_MS,
    sessionSizeRange = [4, 24],
    sessionGapMs = DEFAULT_SESSION_GAP_MS,
    mainFighterIds = DEFAULT_MAIN_FIGHTER_IDS,
    mainFighterShare = 0.8,
    opponentCount = 60,
    unknownStageRate = 0.05,
    winRate = 0.55,
    aliasSplitOpponentTags = ['shadowfox', 'nightowl'],
    aliasSplitOpponentSlug = 'user/abc123',
    opponentFighterIds = ALL_FIGHTER_IDS,
    stageIds,
  } = options;

  const rng = mulberry32(seed);
  const longTailFighterIds = ALL_FIGHTER_IDS.filter((id) => !mainFighterIds.includes(id));
  const fallbackLongTail = longTailFighterIds.length > 0 ? longTailFighterIds : ALL_FIGHTER_IDS;
  const opponentTags = Array.from({ length: opponentCount }, (_, i) => `synthopp${i + 1}`);
  const stagePool = stageIds
    ? ALL_KNOWN_STAGES.filter((s) => stageIds.includes(s.id))
    : ALL_KNOWN_STAGES;

  const aliasPlacements = placeAliasRoles(
    count,
    buildAliasRoles(aliasSplitOpponentTags, aliasSplitOpponentSlug),
  );

  const rows: Match[] = [];
  let currentTime = startMs;
  let sessionRemaining = 0;

  for (let i = 0; i < count; i += 1) {
    if (sessionRemaining <= 0) {
      if (i > 0) {
        currentTime += sessionGapMs;
      }
      sessionRemaining = intBetween(rng, sessionSizeRange[0], sessionSizeRange[1]);
    } else {
      currentTime += intBetween(rng, 1, 8) * 60 * 1000; // minutes within a session
    }
    sessionRemaining -= 1;

    const fighterId =
      rng() < mainFighterShare ? pick(rng, mainFighterIds) : pick(rng, fallbackLongTail);
    const opponentFighterId = pick(rng, opponentFighterIds);
    const matchType = weightedPick(rng, MATCH_TYPE_POOL);
    const source = weightedPick(rng, SOURCE_POOL);
    const win = rng() < winRate;
    const hasKnownStage = rng() >= unknownStageRate && stagePool.length > 0;
    const stage = hasKnownStage ? pick(rng, stagePool) : undefined;

    const aliasRole = aliasPlacements.get(i);
    const opponentTag = aliasRole ? aliasRole.opponentTag : pick(rng, opponentTags);
    const opponentUserSlug = aliasRole?.opponentUserSlug;

    rows.push(
      buildRow({
        id: `synth-${seed}-${i}`,
        time: currentTime,
        fighterId,
        opponentFighterId,
        win,
        matchType,
        source,
        map: stage,
        opponentTag,
        opponentUserSlug,
      }),
    );
  }

  return rows;
}
