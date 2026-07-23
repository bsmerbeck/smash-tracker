import {
  createGspReadingInputSchema,
  createMatchInputSchema,
  createPlaylistInputSchema,
  eliteThresholdGsp,
  estimateMaxGsp,
  estimateT,
  upsertGspSettingsInputSchema,
  upsertOpponentNoteInputSchema,
  vodTimestampSchema,
} from '@smash-tracker/shared';
import type {
  CreateGspReadingInput,
  CreateMatchInput,
  MatchStage,
  MatchType,
  UpsertGspSettingsInput,
  UpsertOpponentNoteInput,
} from '@smash-tracker/shared';

/**
 * Phase 14 (SEED-05/SHOW-01..07): pure, in-memory content generators for the
 * personal showcase dataset — NO firebase-admin import, no RtdbService, no
 * network fetch. Every builder here returns already-validated input objects
 * (`.parse()`d through the SAME shared Zod schemas the live API enforces)
 * plus an explicit back-date epoch-ms for the orchestrator (14-03) to write
 * and then correct the server-stamped `time`/`updatedAt` field with
 * (see `apps/api/scripts/seed/manifest.ts`'s `backdateTime`).
 *
 * Every distribution here is generated via a deterministic seeded PRNG
 * (mulberry32) — never `Math.random()` — so the shape is reproducible and
 * directly assertable in `content.test.ts` (T-14-05).
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32: a small, fast, deterministic PRNG. Given the same `seed`, it
 * always produces the same sequence of [0, 1) floats — the reproducibility
 * property this module's distributions/tests rely on (T-14-05 mitigation).
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive on both ends. */
function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Picks one element from `items` (never empty at call sites in this module). */
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Returns a NEW array with `items` shuffled (Fisher-Yates), never mutating the input. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fighters + stages
// ---------------------------------------------------------------------------

/** SpriteList ids (packages/shared/src/fighterData.ts) — MUST remain stable. */
export const FIGHTER_ROY = 28;
export const FIGHTER_SORA = 86;
export const FIGHTER_PALUTENA = 57;

const OWNER_FIGHTERS = [FIGHTER_ROY, FIGHTER_SORA, FIGHTER_PALUTENA] as const;

/** Legal stages for the match record's `map` field (id/name pairs, no url). */
const STAGES: MatchStage[] = [
  { id: 1, name: 'Battlefield' },
  { id: 3, name: 'Final Destination' },
  { id: 59, name: 'Pokémon Stadium 2' },
  { id: 63, name: 'Kalos Pokémon League' },
  { id: 83, name: 'Smashville' },
  { id: 85, name: 'Town and City' },
  { id: 113, name: 'Small Battlefield' },
];

// ---------------------------------------------------------------------------
// Fictional opponent tags (SHOW-02/SHOW-03) — never a real player's tag
// ---------------------------------------------------------------------------

export interface OpponentTag {
  /** Lowercased, RTDB-key-safe fictional handle. */
  name: string;
  /** The fighter (character) this opponent tag consistently plays. */
  fighterId: number;
}

/**
 * 12 fictional opponent tags. The first 9 are pinned to the curated VOD
 * table's opponent fighters (Kazuya/Sonic/Palutena/R.O.B./Joker/Robin/Luigi/
 * Snake/Terry) — VOD coherence rule: opponent FIGHTER matches the curated
 * VOD's other character, opponent TAG stays fictional. The last 3 cover
 * additional fighters purely for matchup-matrix variety (SHOW-02).
 */
export const OPPONENT_TAGS: OpponentTag[] = [
  { name: 'pk_dread', fighterId: 85 }, // Kazuya
  { name: 'saltforge', fighterId: 41 }, // Sonic
  { name: 'nimbus9', fighterId: 57 }, // Palutena
  { name: 'tiltedtwig', fighterId: 45 }, // R.O.B.
  { name: 'glasslimit', fighterId: 76 }, // Joker
  { name: 'orbitwalk', fighterId: 59 }, // Robin
  { name: 'crestfall', fighterId: 10 }, // Luigi
  { name: 'driftking', fighterId: 36 }, // Snake
  { name: 'hollowstar', fighterId: 79 }, // Terry
  { name: 'latchkey', fighterId: 8 }, // Fox (matrix variety)
  { name: 'backroomboss', fighterId: 23 }, // Marth (matrix variety)
  { name: 'verdantv', fighterId: 14 }, // Peach (matrix variety)
];

/** Returns the 12 fictional opponent tags, each mapped to a consistent fighter. */
export function buildOpponents(): OpponentTag[] {
  return OPPONENT_TAGS.map((tag) => ({ ...tag }));
}

/** Names of the 8 opponent tags that get a scouting note (see buildOpponentNotes). */
const NOTED_OPPONENT_NAMES = [
  'pk_dread',
  'saltforge',
  'nimbus9',
  'tiltedtwig',
  'glasslimit',
  'orbitwalk',
  'crestfall',
  'driftking',
];

export interface OpponentNoteEntry {
  /** Lowercased opponent name — the canonical key `opponentNotes/{uid}/{name}` uses. */
  name: string;
  input: UpsertOpponentNoteInput;
}

/**
 * Believable, en-locale 1-3 sentence scouting notes for 8 of the 12
 * fictional opponents (SHOW-03). No "lorem ipsum" placeholder text.
 */
export function buildOpponentNotes(): OpponentNoteEntry[] {
  const raw: Record<string, UpsertOpponentNoteInput> = {
    pk_dread: {
      habits:
        'Opens neutral with mid-range electric pokes and looks to convert any grounded hit into a full rage-fueled tilt string.',
      watchFor:
        'Watch for the down-2 combo starter once they hit kill percent — it converts into a stock.',
      banThese: [1],
    },
    saltforge: {
      habits:
        'Plays extremely patient at mid-range, spin-dashing in and out to bait a whiff before committing to the punish.',
      watchFor: 'The homing attack mixup off ledge catches airdodge reads — respect the timing.',
      banThese: [83],
    },
    nimbus9: {
      habits:
        'Leans on reflector and up smash to punish approaches, chipping away with auto-reticle from a safe range.',
      watchFor: 'Counter on getup is a very good punish bait — do not challenge it blindly.',
    },
    tiltedtwig: {
      habits:
        'Camps with side-b gyro and neutral-b laser, forcing every approach through a wall of projectiles.',
      watchFor:
        'The up-b combo starter off a grounded hit near the ledge leads straight into a stock.',
      banThese: [3],
    },
    glasslimit: {
      habits:
        'Rushes down with dash attack and gun pokes, saving Arsene for a burst-damage kill confirm around 60%.',
      watchFor:
        'The up-air juggle once Arsene is active true-combos into kill height — respect the timer.',
    },
    orbitwalk: {
      habits:
        'Zones patiently with Arcfire and Nosferatu, resetting neutral whenever tomes run low rather than overextending.',
      watchFor: 'Levin sword keeps a scary disjoint after a reset — respect the spacing on reads.',
    },
    crestfall: {
      habits:
        'Looks for the down-throw up-air true combo and leans on fireball pressure to force a panicked option.',
      watchFor: 'The cyclone recovery mixup can sneak past a committed edgeguard attempt.',
    },
    driftking: {
      habits:
        'Sets up grenades and mines to control neutral, then converts any grab into a heavy percent lead.',
      watchFor:
        'Walking into a planted mine after a knockdown near the ledge is the recurring mistake to avoid.',
      banThese: [63, 85],
    },
  };

  return NOTED_OPPONENT_NAMES.map((name) => ({
    name,
    input: upsertOpponentNoteInputSchema.parse(raw[name]!),
  }));
}

// ---------------------------------------------------------------------------
// Curated VOD table (locked, verbatim URLs — see 14-CONTEXT.md)
// ---------------------------------------------------------------------------

export interface VodEntry {
  vodUrl: string;
  /** The owner's own fighter for this set (Roy/Sora/Palutena). */
  ownerFighterId: number;
  /** The curated opponent's fighter — VOD coherence rule pins this. */
  opponentFighterId: number;
  /** Which fictional opponent tag stands in for the (real) human opponent. */
  opponentTagName: string;
  /** Human-readable set label, for note-authoring context only (not written anywhere). */
  setLabel: string;
}

export const VOD_TABLE: VodEntry[] = [
  {
    vodUrl: 'https://www.youtube.com/watch?v=1b-EWeMfEpo',
    ownerFighterId: FIGHTER_ROY,
    opponentFighterId: 85,
    opponentTagName: 'pk_dread',
    setLabel: 'CEO 2024 GF (Roy vs Kazuya)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=vupTY12YN80',
    ownerFighterId: FIGHTER_ROY,
    opponentFighterId: 41,
    opponentTagName: 'saltforge',
    setLabel: 'GOML 2025 GF (Roy vs Sonic)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=zuH4QAZh9x0',
    ownerFighterId: FIGHTER_ROY,
    opponentFighterId: 57,
    opponentTagName: 'nimbus9',
    setLabel: 'Edgeguard GF (Roy vs Palutena)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=IUTxFeX7ARY',
    ownerFighterId: FIGHTER_ROY,
    opponentFighterId: 45,
    opponentTagName: 'tiltedtwig',
    setLabel: '4o4 SN46 GF (Roy vs R.O.B.)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=LdLFNWhZACE',
    ownerFighterId: FIGHTER_ROY,
    opponentFighterId: 76,
    opponentTagName: 'glasslimit',
    setLabel: '4o4 Weekly 12 GF (Roy vs Joker)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=1mz7Psp8njg',
    ownerFighterId: FIGHTER_SORA,
    opponentFighterId: 59,
    opponentTagName: 'orbitwalk',
    setLabel: 'Smash It Up 30 GF (Sora vs Robin)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=w1Lhxmbmg8k',
    ownerFighterId: FIGHTER_SORA,
    opponentFighterId: 10,
    opponentTagName: 'crestfall',
    setLabel: 'SSC 2023 (Sora vs Luigi)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=MOBQLrBVGsI',
    ownerFighterId: FIGHTER_SORA,
    opponentFighterId: 41,
    opponentTagName: 'saltforge',
    setLabel: 'Glitch Regen (Sora vs Sonic)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=YYQRi7toI3Q',
    ownerFighterId: FIGHTER_PALUTENA,
    opponentFighterId: 36,
    opponentTagName: 'driftking',
    setLabel: 'SmashMania 2025 GF (Palutena vs Snake)',
  },
  {
    vodUrl: 'https://www.youtube.com/watch?v=oI9_T_gnwSk',
    ownerFighterId: FIGHTER_PALUTENA,
    opponentFighterId: 79,
    opponentTagName: 'hollowstar',
    setLabel: 'DAT MM 291 GF (Palutena vs Terry)',
  },
];

/** Win/loss result per VOD-match index (0-9) — a believable 6-4 mix. */
const VOD_WINS: boolean[] = [true, true, false, true, false, true, false, true, true, false];

// ---------------------------------------------------------------------------
// Match-level tags (SHOW-07)
// ---------------------------------------------------------------------------

/** Reproduced locally (not imported across the apps/web boundary) — must match apps/web/src/lib/tags.ts. */
export const MATCH_PRESET_TAGS = [
  'tournament-set',
  'practice-friendlies',
  'bad-matchup',
  'good-read-highlight',
  'to-review',
] as const;

const CUSTOM_MATCH_TAGS = ['lab this', 'bracket run', 'money match'] as const;

const MATCH_TYPE_POOL: MatchType[] = [
  'quickplay',
  'quickplay',
  'online-friendly',
  'online-tourney',
  'offline-friendly',
];

// ---------------------------------------------------------------------------
// buildPersonalMatches
// ---------------------------------------------------------------------------

export interface MatchEntry {
  input: CreateMatchInput;
  /** Explicit back-date epoch-ms — the orchestrator corrects the server-stamped `time` with this. */
  timeMs: number;
}

const SEED_MATCH_OPPONENTS = 0x5eed1975;
const SEED_MATCH_SHAPE = 0x1b873593;
const SEED_MATCH_OFFSETS = 0x9e3779b9;

const TOTAL_MATCHES = 72;
const ROY_TOTAL = 43;
const SORA_TOTAL = 18;
const PALUTENA_TOTAL = 11;

// A "rough week" (loss-heavy, texture per CONTEXT.md) and a "bracket run"
// (win-heavy, tagged 'bracket run') cluster, both carved out of Roy's
// non-VOD match count so the fighter-count totals above stay exact.
const ROUGH_WEEK_DAY_OFFSETS = [61, 60, 59, 58, 57, 56];
const ROUGH_WEEK_WINS = [false, false, true, false, false, false];
const BRACKET_RUN_DAY_OFFSETS = [21, 20, 20, 19, 19];
const BRACKET_RUN_WINS = [true, true, true, true, true];

interface InternalSlot {
  fighterId: number;
  opponentId: number;
  opponentTagName: string;
  vodUrl?: string;
  win: boolean;
  dayOffset: number;
  matchType: MatchType;
  tags: string[];
}

function opponentForRng(rng: () => number): OpponentTag {
  return pick(rng, OPPONENT_TAGS);
}

/**
 * Builds ~72 personal matches (SHOW-01) spanning the 92-day window ending
 * the day before `now`, with a ~58% overall win rate, a Roy/Sora/Palutena
 * ~60/25/15 split, exactly 10 VOD-coherent matches pinned to the curated
 * table (VOD coherence rule), a varied opponent-fighter matrix (SHOW-02),
 * and preset+custom match-level tags (SHOW-07).
 */
export function buildPersonalMatches(now: number): MatchEntry[] {
  const opponentRng = mulberry32(SEED_MATCH_OPPONENTS);
  const shapeRng = mulberry32(SEED_MATCH_SHAPE);
  const offsetRng = mulberry32(SEED_MATCH_OFFSETS);

  const slots: InternalSlot[] = [];

  // 1. VOD slots (indices 0-9), fixed fighter/opponent per the curated table.
  VOD_TABLE.forEach((vod, index) => {
    slots.push({
      fighterId: vod.ownerFighterId,
      opponentId: vod.opponentFighterId,
      opponentTagName: vod.opponentTagName,
      vodUrl: vod.vodUrl,
      win: VOD_WINS[index]!,
      dayOffset: 88 - index * 9, // spread across the window, descending
      matchType: 'offline-tourney',
      tags: index === 2 ? ['tournament-set', 'good-read-highlight'] : ['tournament-set'],
    });
  });

  // 2. Rough-week cluster (Roy, loss-heavy texture).
  ROUGH_WEEK_DAY_OFFSETS.forEach((dayOffset, i) => {
    const opponent = opponentForRng(opponentRng);
    slots.push({
      fighterId: FIGHTER_ROY,
      opponentId: opponent.fighterId,
      opponentTagName: opponent.name,
      win: ROUGH_WEEK_WINS[i]!,
      dayOffset,
      matchType: 'online-tourney',
      tags: ['to-review', 'bad-matchup'],
    });
  });

  // 3. Bracket-run cluster (Roy, win-heavy, tagged 'bracket run').
  BRACKET_RUN_DAY_OFFSETS.forEach((dayOffset, i) => {
    const opponent = opponentForRng(opponentRng);
    slots.push({
      fighterId: FIGHTER_ROY,
      opponentId: opponent.fighterId,
      opponentTagName: opponent.name,
      win: BRACKET_RUN_WINS[i]!,
      dayOffset,
      matchType: 'offline-tourney',
      tags: ['tournament-set', 'bracket run'],
    });
  });

  // 4. Remaining random non-VOD, non-cluster slots per fighter, stratified
  //    across the window so the min/max day-offset span comfortably covers
  //    80+ days (never left to chance).
  const remainingCounts: { fighterId: number; count: number }[] = [
    {
      fighterId: FIGHTER_ROY,
      count: ROY_TOTAL - 5 - ROUGH_WEEK_DAY_OFFSETS.length - BRACKET_RUN_DAY_OFFSETS.length,
    },
    { fighterId: FIGHTER_SORA, count: SORA_TOTAL - 3 },
    { fighterId: FIGHTER_PALUTENA, count: PALUTENA_TOTAL - 2 },
  ];
  const totalRandom = remainingCounts.reduce((sum, r) => sum + r.count, 0);

  // Exactly 30 wins out of 51 random slots (58.8%), combined with the fixed
  // cluster/VOD wins above, lands the overall rate inside [0.52, 0.64].
  const randomWinTarget = 30;
  const winPattern = shuffle(
    [...Array(randomWinTarget).fill(true), ...Array(totalRandom - randomWinTarget).fill(false)],
    shapeRng,
  );

  // Stratified day-offset sampling: divide [1, 91] into `totalRandom` bins so
  // coverage is guaranteed rather than merely likely, then shuffle the
  // resulting offsets so they aren't correlated with fighter assignment order.
  const binSize = 90 / totalRandom;
  const stratifiedOffsets = Array.from({ length: totalRandom }, (_, i) => {
    const lo = 1 + i * binSize;
    const hi = 1 + (i + 1) * binSize;
    return Math.round(lo + offsetRng() * (hi - lo));
  });
  const shuffledOffsets = shuffle(stratifiedOffsets, offsetRng);

  let randomIndex = 0;
  for (const { fighterId, count } of remainingCounts) {
    for (let i = 0; i < count; i += 1) {
      const opponent = opponentForRng(opponentRng);
      const tags: string[] = [];
      if (shapeRng() < 0.35) {
        tags.push(pick(shapeRng, MATCH_PRESET_TAGS));
      }
      if (shapeRng() < 0.15) {
        tags.push(pick(shapeRng, CUSTOM_MATCH_TAGS));
      }
      slots.push({
        fighterId,
        opponentId: opponent.fighterId,
        opponentTagName: opponent.name,
        win: winPattern[randomIndex]!,
        dayOffset: shuffledOffsets[randomIndex]!,
        matchType: pick(shapeRng, MATCH_TYPE_POOL),
        tags,
      });
      randomIndex += 1;
    }
  }

  // Guarantee the tag-coverage invariant (SHOW-07): at least one preset AND
  // one custom tag appear at match level, deterministically (not left to the
  // 35%/15% rolls above landing favorably).
  slots[slots.length - 1]!.tags = ['practice-friendlies', 'lab this'];

  if (slots.length !== TOTAL_MATCHES) {
    // Sanity guard: the cluster/random slot math above must always add up to
    // exactly TOTAL_MATCHES — a silent drift here would break the locked
    // ~60/25/15 fighter split and ~58% win rate this builder promises.
    throw new Error(`buildPersonalMatches: expected ${TOTAL_MATCHES} slots, built ${slots.length}`);
  }

  // 5. Materialize each slot into a validated CreateMatchInput + timeMs.
  return slots.map((slot) => {
    const jitter = Math.floor(offsetRng() * DAY_MS);
    const timeMs = now - (slot.dayOffset * DAY_MS + jitter);
    const map = pick(offsetRng, STAGES);
    const raw = {
      fighter_id: slot.fighterId,
      opponent_id: slot.opponentId,
      map,
      opponent: slot.opponentTagName,
      matchType: slot.matchType,
      win: slot.win,
      ...(slot.vodUrl !== undefined ? { vodUrl: slot.vodUrl } : {}),
      ...(slot.tags.length > 0 ? { tags: slot.tags.slice(0, 10) } : {}),
    };
    return { input: createMatchInputSchema.parse(raw), timeMs };
  });
}

// ---------------------------------------------------------------------------
// buildGspSettings / buildGspSeries (SHOW-06) — pure gspMmr math, no network
// ---------------------------------------------------------------------------

/**
 * Computes a plausible "as of `now`" Elite Smash threshold via the pure,
 * exported `gspMmr.ts` math — NEVER `gspLive.ts`'s network-fetch path
 * (forbidden by 14-CONTEXT.md).
 */
export function buildGspSettings(now: number): UpsertGspSettingsInput {
  const t = estimateT(now);
  const eliteThreshold = Math.round(eliteThresholdGsp(t));
  return upsertGspSettingsInputSchema.parse({ eliteThreshold });
}

export interface GspSeriesEntry {
  input: CreateGspReadingInput;
  timeMs: number;
}

const SEED_GSP = 0x2545f491;

/**
 * Per-fighter (28/86/57) GSP reading series (SHOW-06): 12-16 points each,
 * trending upward with jitter, spread across the 92-day window, every value
 * comfortably below `estimateMaxGsp(estimateT(now))`.
 */
export function buildGspSeries(now: number): Record<number, GspSeriesEntry[]> {
  const t = estimateT(now);
  const elite = eliteThresholdGsp(t);
  const max = estimateMaxGsp(t);
  const rng = mulberry32(SEED_GSP);

  const startGsp = elite * 0.8;
  const endGsp = Math.min(elite * 1.05, max * 0.97);

  const result: Record<number, GspSeriesEntry[]> = {};
  for (const fighterId of OWNER_FIGHTERS) {
    const count = randInt(rng, 12, 16);
    const entries: GspSeriesEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const progress = count === 1 ? 1 : i / (count - 1);
      const base = startGsp + (endGsp - startGsp) * progress;
      const jitter = (rng() - 0.5) * elite * 0.015;
      const gsp = Math.max(1, Math.round(base + jitter));
      const dayOffset = Math.max(1, Math.round(91 - progress * 89));
      const timeJitter = Math.floor(rng() * DAY_MS);
      const timeMs = now - (dayOffset * DAY_MS + timeJitter);
      entries.push({
        input: createGspReadingInputSchema.parse({ fighter_id: fighterId, gsp }),
        timeMs,
      });
    }
    result[fighterId] = entries;
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildVodNotes (SHOW-04/SHOW-07) — VOD annotations
// ---------------------------------------------------------------------------

/** Shape of `vodTimestampSchema`'s input — reproduced locally since match.ts exports the schema, not a named `VodTimestampInput` type. */
interface VodTimestampInput {
  seconds: number;
  note: string;
  tags?: string[];
}

/** Reproduced locally (not imported across the apps/web boundary) — must match apps/web/src/lib/tags.ts. */
export const NOTE_PRESET_TAGS = [
  'neutral',
  'punish',
  'edgeguard',
  'recovery',
  'kill-confirm',
  'defense',
  'mixup',
  'matchup-note',
  'mental-game',
  'mistake',
  'highlight',
] as const;

const CUSTOM_NOTE_TAG = 'lab this';

/**
 * One believable SSBU commentary line per NOTE_PRESET_TAGS entry, in the
 * same order — every VOD's notes are built by sampling from this pool, so
 * every generated set of notes stays thematically tied to its preset tag.
 */
const NOTE_TEMPLATES: { text: string; tag: (typeof NOTE_PRESET_TAGS)[number] }[] = [
  {
    text: 'Clean neutral win starts the exchange, good spacing off a jab poke.',
    tag: 'neutral',
  },
  {
    text: 'Nice ledge trap forces the airdodge and converts into a percent lead.',
    tag: 'edgeguard',
  },
  {
    text: 'Rough disadvantage stretch here, a bad DI read cost extra damage escaping the combo.',
    tag: 'defense',
  },
  {
    text: 'Solid recovery mixup gets back to the stage safely against the edgeguard attempt.',
    tag: 'recovery',
  },
  {
    text: 'Reads the roll and lands the punish for a big damage swing.',
    tag: 'punish',
  },
  {
    text: 'Converts the read into the kill confirm right at kill percent.',
    tag: 'kill-confirm',
  },
  {
    text: 'Mixes up the approach here to open the stubborn shield.',
    tag: 'mixup',
  },
  {
    text: 'Good matchup-specific read on the recovery mixup covered in scouting notes.',
    tag: 'matchup-note',
  },
  {
    text: 'Mental game slip here, panics into a bad option under pressure.',
    tag: 'mental-game',
  },
  {
    text: 'Missed the conversion at kill percent, needs cleanup next set.',
    tag: 'mistake',
  },
  {
    text: 'Highlight-reel edgeguard closes out the stock early.',
    tag: 'highlight',
  },
];

const SEED_VOD_NOTES = 0x41c64e6d;

/**
 * Returns, per VOD-match index (0-9), an ordered list of 3-6 timestamped
 * notes (SHOW-04): seconds in [30, 420], en-locale SSBU commentary tied to
 * NOTE_PRESET_TAGS, with at least one custom tag ("lab this") appearing
 * somewhere across the full set (SHOW-07).
 */
export function buildVodNotes(): VodTimestampInput[][] {
  const rng = mulberry32(SEED_VOD_NOTES);

  return VOD_TABLE.map((_vod, vodIndex) => {
    const noteCount = randInt(rng, 3, 6);
    const templates = shuffle(NOTE_TEMPLATES, rng).slice(0, noteCount);
    const seconds = shuffle(
      Array.from({ length: 391 }, (_, i) => i + 30), // [30, 420]
      rng,
    )
      .slice(0, noteCount)
      .sort((a, b) => a - b);

    return templates.map((template, i) => {
      const tags: string[] = [template.tag];
      // Force the very first VOD's very first note to also carry the custom
      // tag — guarantees the note-level custom-tag coverage invariant
      // deterministically rather than leaving it to chance.
      if (vodIndex === 0 && i === 0) {
        tags.push(CUSTOM_NOTE_TAG);
      }
      return vodTimestampSchema.parse({
        seconds: seconds[i]!,
        note: template.text,
        tags,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// buildPlaylists (SHOW-05)
// ---------------------------------------------------------------------------

export interface PlaylistSpec {
  name: string;
  /**
   * VOD-match INDEX (0-9) into VOD_TABLE — NOT a push key. Playlist
   * `matchIds` are RTDB push keys only known once the orchestrator (14-03)
   * has actually written the matches; it resolves these indices to real
   * match ids before calling `updatePlaylist`.
   */
  vodMatchIndices: number[];
}

/**
 * Two playlist specs (SHOW-05), each grouping >= 3 seeded VOD-match indices
 * for sequential playback: "Roy bracket runs" (Roy's VODs, indices 0-4) and
 * "Edgeguard studies" (a cross-roster grouping themed around edgeguards/
 * recoveries).
 */
export function buildPlaylists(): PlaylistSpec[] {
  const roy: PlaylistSpec = {
    name: createPlaylistInputSchema.parse({ name: 'Roy bracket runs' }).name,
    vodMatchIndices: [0, 1, 3, 4],
  };
  const edgeguard: PlaylistSpec = {
    name: createPlaylistInputSchema.parse({ name: 'Edgeguard studies' }).name,
    vodMatchIndices: [2, 5, 8, 9],
  };
  return [roy, edgeguard];
}
