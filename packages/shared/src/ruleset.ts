import { z } from 'zod';
import { getStageById, TOURNAMENT_LEGAL_STAGE_IDS } from './stageData.js';

/**
 * EVID-04 (37-CONTEXT.md D-09/D-10, assumption-delta: promote). The ONE
 * versioned ruleset contract every stage-advice consumer resolves through —
 * mirrors `evidence/policy.ts`'s "one threshold source" shape: a module-scope
 * version constant, a doc comment naming the drift class it closes, then
 * types, then the preset, then pure functions.
 *
 * The drift class this module closes: before this contract existed, "which
 * stages are legal" and "which stages are we recommending" were two
 * independent lists with no shared source, so a UI could disclose one ruleset
 * while a recommendation was silently computed under another. `resolveRuleset`
 * is the promoted primary API every consumer calls (assumption-delta:
 * promote) — `DEFAULT_RULESET` is the fallback INSIDE it, never read directly
 * for behaviour by any other surface, so a second variant can never be
 * stored-but-never-honoured.
 *
 * `RULESET_CONTRACT_VERSION` governs the STORED OVERRIDE shape
 * (`rulesetOverrideStoredSchema`) — bump it only when that shape itself
 * changes. `Ruleset.version` is a SEPARATE number: the preset's own content
 * revision. A stored override whose `contractVersion` exceeds the running
 * `RULESET_CONTRACT_VERSION` is ignored WHOLE (never half-applied) and the
 * ignore is reported so a reader can disclose it — see `resolveRuleset`.
 */
export const RULESET_CONTRACT_VERSION = 1;

export const DSR_VARIANTS = ['none', 'standard', 'modified'] as const;
export const dsrVariantSchema = z.enum(DSR_VARIANTS);
export type DsrVariant = (typeof DSR_VARIANTS)[number];

export const SET_FORMATS = ['bo3', 'bo5'] as const;
export const setFormatSchema = z.enum(SET_FORMATS);
export type SetFormat = (typeof SET_FORMATS)[number];

/**
 * A fully resolved rule set a recommendation was computed under — the
 * assumption-delta's promoted primary noun, identified by `id` plus
 * `version`. Every field here is a clause ROADMAP SC3 requires a
 * recommendation to visibly disclose (stage lists, ban counts, DSR variant,
 * strike order, set format) plus the citable source that grounds the preset.
 */
export interface Ruleset {
  id: string;
  version: number;
  /** Stages legal at game one, ascending, disjoint from `counterpickStageIds`. */
  starterStageIds: number[];
  /** Additional stages legal from game two onward, ascending, disjoint from `starterStageIds`. */
  counterpickStageIds: number[];
  banCounts: { bo3: number; bo5: number };
  dsr: DsrVariant;
  /** Human-readable strike-order description, disclosed verbatim — never paraphrased into a second vocabulary. */
  strikeOrder: string;
  setFormat: { default: SetFormat; topCut: SetFormat };
  /** The closest citable public source this preset was informed by, and when it was retrieved. */
  source: { url: string; retrievedAt: string };
}

export const DEFAULT_RULESET_ID = 'ssbu-house-v1-2026';

/**
 * Resolves a stage id from its display name against this app's OWN
 * tournament-legal list (`TOURNAMENT_LEGAL_STAGE_IDS`, stageData.ts) — the
 * preset's ids are derived through this lookup rather than transcribed as
 * bare numeric literals, so a future edit to stageData.ts's id assignments
 * surfaces here as a loud failure instead of a silent mismatch.
 */
function stageIdForLegalStageName(name: string): number {
  const match = TOURNAMENT_LEGAL_STAGE_IDS.map((id) => getStageById(id)).find(
    (stage) => stage?.name === name,
  );
  if (!match) {
    throw new Error(
      `ruleset.ts: no tournament-legal stage named "${name}" — stageData.ts's TOURNAMENT_LEGAL_STAGE_IDS drifted`,
    );
  }
  return match.id;
}

const STARTER_STAGE_NAMES = [
  'Battlefield',
  'Small Battlefield',
  'Final Destination',
  'Pokémon Stadium 2',
  'Smashville',
  'Town and City',
  'Hollow Bastion',
];

const COUNTERPICK_STAGE_NAMES = [
  'Kalos Pokémon League',
  'Lylat Cruise',
  'Northern Cave',
  "Yoshi's Story",
];

const DEFAULT_STARTER_STAGE_IDS = STARTER_STAGE_NAMES.map(stageIdForLegalStageName).sort(
  (a, b) => a - b,
);
const DEFAULT_COUNTERPICK_STAGE_IDS = COUNTERPICK_STAGE_NAMES.map(stageIdForLegalStageName).sort(
  (a, b) => a - b,
);

/**
 * The ONE default ruleset preset (D-09). This is NOT a claim of a specific
 * organiser's official ruleset (D-17): three independently-checked public
 * SSBU ruleset sources disagree with each other and with this exact split
 * (37-RESEARCH.md Pitfall 7 / Open Question 1 — CEO Gaming's 2026 ruleset,
 * SmashWiki's "Unified North American Ruleset" page, and SmashWiki's general
 * Stage Legality page each classify the starter/counterpick split
 * differently, and none lists Northern Cave or Yoshi's Story as an
 * established counterpick). This preset is therefore a HOUSE CONVENTION
 * informed by, but not identical to, the closest public source cited below —
 * hence the `house` marker in its id. Do not add a doc comment or a shipped
 * string anywhere in this codebase that claims this preset IS a named
 * organiser's official ruleset.
 *
 * `starterStageIds`/`counterpickStageIds` are exactly a partition of this
 * app's own `TOURNAMENT_LEGAL_STAGE_IDS` (stageData.ts) — not a fresh stage
 * set invented for this module.
 */
export const DEFAULT_RULESET: Ruleset = {
  id: DEFAULT_RULESET_ID,
  version: 1,
  starterStageIds: DEFAULT_STARTER_STAGE_IDS,
  counterpickStageIds: DEFAULT_COUNTERPICK_STAGE_IDS,
  banCounts: { bo3: 1, bo5: 2 },
  dsr: 'modified',
  strikeOrder:
    'Game 1: 1-2-1 stage strike — the first striker bans one stage, the second bans two, the first bans one more, and the remaining stage is played.',
  setFormat: { default: 'bo3', topCut: 'bo5' },
  source: {
    url: 'https://www.ssbwiki.com/Tournament_rulesets_(SSBU)',
    retrievedAt: '2026-09-17',
  },
};

// ---------------------------------------------------------------------------
// The stored override — RTDB-safe by construction
// ---------------------------------------------------------------------------

const BAN_COUNT_MAX = 5;
const STRIKE_ORDER_MAX_LENGTH = 300;

const STAGE_ID_KEY_PATTERN = /^s(\d+)$/;

/**
 * Builds the prefixed RTDB key for a stage id. The prefix is the whole point
 * (doc comment, not decoration): Firebase coerces an object whose keys are
 * numeric and dense enough into an ARRAY on write, and this codebase has a
 * documented production incident from exactly that coercion stripping `null`
 * array members on read-back. A key that starts with a letter can never be
 * read back as an array element, so a stage-id presence map built with this
 * function is structurally immune to that incident class.
 */
export function stageIdKey(stageId: number): string {
  return `s${stageId}`;
}

function parseStageIdKey(key: string): number | null {
  const match = STAGE_ID_KEY_PATTERN.exec(key);
  if (!match || match[1] === undefined) {
    return null;
  }
  return Number(match[1]);
}

/** Parses a stage-id presence map back into an ascending, deduplicated id list. Tolerates a missing/empty map. */
export function stageIdsFromPresenceMap(map: Record<string, true> | null | undefined): number[] {
  if (!map) {
    return [];
  }
  const ids = new Set<number>();
  for (const key of Object.keys(map)) {
    const id = parseStageIdKey(key);
    if (id !== null) {
      ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * A stage-id presence map, keyed by `stageIdKey` (never a bare numeric key —
 * see that function's doc comment). Validated at the schema level (not just
 * documented) so a client-supplied unprefixed or non-numeric key is rejected
 * with a 400 at the API boundary rather than stored and silently misread.
 */
export const stageIdPresenceMapSchema = z
  .record(z.string(), z.literal(true))
  .refine((map) => Object.keys(map).every((key) => STAGE_ID_KEY_PATTERN.test(key)), {
    message: 'stage id presence map keys must be prefixed stage ids, e.g. "s113"',
  });

/**
 * `tournamentEntries/{uid}/{entryKey}.rulesetOverride` — the STORED shape.
 * `contractVersion` is required (every write stamps the running
 * `RULESET_CONTRACT_VERSION`); every other member is OPTIONAL and uses the
 * `.nullish()` modifier — never `.optional()`/`.nullable()` alone, the exact
 * shape that caused this project's documented `260725-juj` production
 * outage. Every writer conditional-spreads so an absent member is OMITTED
 * from the write, never stored as an empty/null value.
 */
export const rulesetOverrideStoredSchema = z.object({
  contractVersion: z.number().int(),
  starterStageIds: stageIdPresenceMapSchema.nullish(),
  counterpickStageIds: stageIdPresenceMapSchema.nullish(),
  banCounts: z
    .object({
      bo3: z.number().int().min(0).max(BAN_COUNT_MAX),
      bo5: z.number().int().min(0).max(BAN_COUNT_MAX),
    })
    .nullish(),
  dsr: dsrVariantSchema.nullish(),
  strikeOrder: z.string().min(1).max(STRIKE_ORDER_MAX_LENGTH).nullish(),
  setFormat: z
    .object({
      default: setFormatSchema,
      topCut: setFormatSchema,
    })
    .nullish(),
});
export type RulesetOverrideStored = z.infer<typeof rulesetOverrideStoredSchema>;

/**
 * `PATCH /api/tournaments/:entryKey/ruleset` request body. `rulesetOverride:
 * null` is a REQUEST INTENT meaning "clear the stored override and return to
 * the house default" — it is never itself a stored value (clearing removes
 * the RTDB child outright; see the route handler).
 */
export const rulesetOverrideUpdateBodySchema = z.object({
  rulesetOverride: rulesetOverrideStoredSchema.nullable(),
});
export type RulesetOverrideUpdateBody = z.infer<typeof rulesetOverrideUpdateBodySchema>;

/** `PATCH /api/tournaments/:entryKey/ruleset` response — the entry's current stored override, if any. */
export const rulesetOverrideResponseSchema = z.object({
  entryKey: z.string().min(1),
  rulesetOverride: rulesetOverrideStoredSchema.nullish(),
});
export type RulesetOverrideResponse = z.infer<typeof rulesetOverrideResponseSchema>;

// ---------------------------------------------------------------------------
// The resolver — the promoted primary API
// ---------------------------------------------------------------------------

/** Appended to `DEFAULT_RULESET.id` when a stored override actually changes at least one member, so a reader can tell a custom ruleset apart from the untouched preset. */
const OVERRIDE_ID_SUFFIX = '+override';

export interface ResolvedRuleset {
  ruleset: Ruleset;
  source: 'default-preset' | 'event-override';
  ignoredOverrideReason: 'unsupported-contract-version' | null;
}

/**
 * The ONE entry point every consumer calls (assumption-delta: promote) — the
 * default preset is the fallback INSIDE this function, never read directly
 * for behaviour by any other surface. Clauses, in order:
 *
 * 1. A missing override resolves to the preset.
 * 2. An override whose `contractVersion` exceeds `RULESET_CONTRACT_VERSION`
 *    is ignored WHOLE — never half-applied — and the ignore reason is
 *    reported so a reader can disclose it; half-applying an unknown shape is
 *    how a recommendation ends up computed under rules nobody stated.
 * 3. An override that declares no members at all resolves to the preset and
 *    reports the preset as its source.
 * 4. Otherwise each declared member REPLACES the preset's WHOLE-MEMBER
 *    (never element-wise); stage lists are rebuilt wholesale from their
 *    presence maps, both lists sorted ascending, and any id declared in BOTH
 *    maps is kept as a starter and removed from the counterpicks.
 */
export function resolveRuleset(
  override: RulesetOverrideStored | null | undefined,
): ResolvedRuleset {
  if (!override) {
    return { ruleset: DEFAULT_RULESET, source: 'default-preset', ignoredOverrideReason: null };
  }

  if (override.contractVersion > RULESET_CONTRACT_VERSION) {
    return {
      ruleset: DEFAULT_RULESET,
      source: 'default-preset',
      ignoredOverrideReason: 'unsupported-contract-version',
    };
  }

  const hasAnyMember =
    override.starterStageIds != null ||
    override.counterpickStageIds != null ||
    override.banCounts != null ||
    override.dsr != null ||
    override.strikeOrder != null ||
    override.setFormat != null;

  if (!hasAnyMember) {
    return { ruleset: DEFAULT_RULESET, source: 'default-preset', ignoredOverrideReason: null };
  }

  let starterStageIds = DEFAULT_RULESET.starterStageIds;
  let counterpickStageIds = DEFAULT_RULESET.counterpickStageIds;
  if (override.starterStageIds != null || override.counterpickStageIds != null) {
    const starters = new Set(
      override.starterStageIds != null
        ? stageIdsFromPresenceMap(override.starterStageIds)
        : DEFAULT_RULESET.starterStageIds,
    );
    const counterpicks = new Set(
      override.counterpickStageIds != null
        ? stageIdsFromPresenceMap(override.counterpickStageIds)
        : DEFAULT_RULESET.counterpickStageIds,
    );
    // A stage id declared as both a starter and a counterpick resolves as a
    // starter (assumption-delta: composition) — never double-counted.
    for (const id of starters) {
      counterpicks.delete(id);
    }
    starterStageIds = [...starters].sort((a, b) => a - b);
    counterpickStageIds = [...counterpicks].sort((a, b) => a - b);
  }

  const ruleset: Ruleset = {
    ...DEFAULT_RULESET,
    id: `${DEFAULT_RULESET.id}${OVERRIDE_ID_SUFFIX}`,
    starterStageIds,
    counterpickStageIds,
    banCounts: override.banCounts ?? DEFAULT_RULESET.banCounts,
    dsr: override.dsr ?? DEFAULT_RULESET.dsr,
    strikeOrder: override.strikeOrder ?? DEFAULT_RULESET.strikeOrder,
    setFormat: override.setFormat ?? DEFAULT_RULESET.setFormat,
  };

  return { ruleset, source: 'event-override', ignoredOverrideReason: null };
}

// ---------------------------------------------------------------------------
// Set state + legalStagesFor (EVID-04, EVID-05)
// ---------------------------------------------------------------------------

/**
 * The set-state inputs the advisor's UI collects explicitly (D-11) — entered
 * by the player, never persisted and never inferred from match data this
 * phase (inferring a set format from a maximum observed game index is lossy
 * and is deliberately not done). Because nothing here is stored, the
 * keyed-map/RTDB-safety rules above do not apply to this type: plain ordered
 * arrays are correct for `priorStages`, since array ORDER is play order and
 * is exactly what `legalStagesFor`'s modified-DSR clause reads.
 */
export interface SetState {
  phase: 'game1' | 'game2plus';
  role: 'striking' | 'picking';
  /** In play order (oldest first) — `legalStagesFor`'s modified-DSR clause reads array order as play order. */
  priorStages: { stageId: number; won: boolean }[];
  bannedStageIds: number[];
  setFormat: SetFormat;
}

/** The D-11 default the advisor opens on: "Game 1 · striking · no bans". */
export const DEFAULT_SET_STATE: SetState = {
  phase: 'game1',
  role: 'striking',
  priorStages: [],
  bannedStageIds: [],
  setFormat: 'bo3',
};

/**
 * A pure function of the ruleset and the set state — no I/O. Clauses, in the
 * order they're applied:
 *
 * 1. Base set: starters only at game one; starters plus counterpicks from
 *    game two onward.
 * 2. Every banned id is removed.
 * 3. The DSR restriction applies ONLY when the phase is game two or later
 *    AND the role is picking — DSR restricts the counterpicking player, and
 *    there is no counterpick before game two. Under the modified variant,
 *    the LAST prior stage whose result was a win (latest by array order,
 *    which is play order) is removed; under the standard variant, EVERY
 *    prior stage whose result was a win is removed; under the no-DSR
 *    variant, nothing is removed for prior wins.
 *
 * The result is deduplicated and sorted ascending. An empty result is a
 * legal, meaningful answer ("no stage is legal here") — this function never
 * falls back to an unfiltered list when everything is excluded.
 */
export function legalStagesFor(ruleset: Ruleset, setState: SetState): number[] {
  const base =
    setState.phase === 'game1'
      ? ruleset.starterStageIds
      : [...ruleset.starterStageIds, ...ruleset.counterpickStageIds];

  const banned = new Set(setState.bannedStageIds);
  let survivors = base.filter((id) => !banned.has(id));

  const dsrApplies = setState.phase !== 'game1' && setState.role === 'picking';
  if (dsrApplies && ruleset.dsr !== 'none') {
    let removeIds: Set<number>;
    if (ruleset.dsr === 'modified') {
      let lastWinStageId: number | null = null;
      for (const prior of setState.priorStages) {
        if (prior.won) {
          lastWinStageId = prior.stageId;
        }
      }
      removeIds = lastWinStageId !== null ? new Set([lastWinStageId]) : new Set();
    } else {
      removeIds = new Set(
        setState.priorStages.filter((prior) => prior.won).map((prior) => prior.stageId),
      );
    }
    survivors = survivors.filter((id) => !removeIds.has(id));
  }

  return [...new Set(survivors)].sort((a, b) => a - b);
}
