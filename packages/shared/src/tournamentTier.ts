import { z } from 'zod';
import { RESEARCH_MAX_PROVIDER_TEXT } from './researchIngestion.js';

/**
 * TIER-01 (39.2-CONTEXT.md D-01/D-04): the ONE tier contract every consumer
 * resolves through — the same "versioned constant, stored override, one
 * resolver with an ignore reason" shape as `ruleset.ts`.
 *
 * `TIER_ESTIMATE_POLICY_VERSION` versions the entrant-count ladder below
 * (D-04: a threshold change is a constant bump, never a data migration —
 * nothing resolved is ever written to RTDB, resolution runs at read time).
 * `TIER_OVERRIDE_CONTRACT_VERSION` versions the STORED override shape only:
 * an override whose `contractVersion` exceeds it is ignored WHOLE and the
 * ignore is reported, exactly like `RULESET_CONTRACT_VERSION`.
 */
export const TIER_ESTIMATE_POLICY_VERSION = 1;
export const TIER_OVERRIDE_CONTRACT_VERSION = 1;

/** T-05: the fixed six-word tier vocabulary, `unknown` last — an honest "we do not know" is a first-class value. */
export const TIER_WORDS = ['supermajor', 'major', 'minor', 'regional', 'local', 'unknown'] as const;
export type TierWord = (typeof TIER_WORDS)[number];
export type KnownTierWord = Exclude<TierWord, 'unknown'>;

/** UI-SPEC §7.1: ordered level per known tier (local 1 … supermajor 5); `unknown` has no level. */
export const TIER_LEVEL: Record<KnownTierWord, number> = {
  local: 1,
  regional: 2,
  minor: 3,
  major: 4,
  supermajor: 5,
};

/** Numeric level of a tier word; `unknown` is 0 so it never outranks a known tier. */
export function tierLevel(word: TierWord): number {
  return word === 'unknown' ? 0 : TIER_LEVEL[word];
}

/**
 * D-01: the entrant-count ladder, ascending. Exported (never copied) so the
 * calibration oracle mutates the SAME structure the resolver reads.
 */
export const TIER_ESTIMATE_LADDER: readonly { tier: KnownTierWord; minEntrants: number }[] = [
  { tier: 'local', minEntrants: 0 },
  { tier: 'regional', minEntrants: 64 },
  { tier: 'minor', minEntrants: 256 },
  { tier: 'major', minEntrants: 512 },
  { tier: 'supermajor', minEntrants: 1024 },
];

/** D-01: the highest ladder rung whose minimum the entrant count reaches. `ladder` is overridable for the calibration oracle only. */
export function estimateTierFromEntrants(
  numEntrants: number,
  ladder: readonly { tier: KnownTierWord; minEntrants: number }[] = TIER_ESTIMATE_LADDER,
): KnownTierWord {
  let result: KnownTierWord = ladder[0]?.tier ?? 'local';
  for (const rung of ladder) {
    if (numEntrants >= rung.minEntrants) {
      result = rung.tier;
    }
  }
  return result;
}

/** T-05 provenance: how the tier was established. A closed string union, never a boolean `isEstimate`. */
export type TierBasis = 'manual' | 'recorded' | 'estimated' | 'unknown';
/** T-05 provenance: which system asserted the tier. */
export type TierSource = 'manual' | 'liquipedia' | 'ultrank' | 'startgg' | 'heuristic' | 'none';
/** F2: whether the event is positively offline, positively online, or unproven either way. */
export type TierSetting = 'offline' | 'online' | 'unknown';
/** Whether the event is a main event or a side event (Squad Strike, doubles, …). */
export type TierEventKind = 'main' | 'side-event' | 'unknown';
/** Why a resolution is `unknown`, first applicable in this order (`manual` = the owner chose Unknown). */
export type TierUnknownReason = 'online' | 'sideEvent' | 'noEntrants' | 'settingUnknown' | 'manual';

/**
 * T-07 / LIQ-05: the RESERVED external-source rung of the resolution order.
 * Typed and accepted by the resolver but nothing in phase 39.2 populates it;
 * Phase 42 fills it from Liquipedia. The resolver input member is named
 * `externalTierRow`, the name 39.1-TIER-RESEARCH §5.2 and plan 42-13 use.
 */
export interface ExternalTierInput {
  tier: KnownTierWord;
  source: 'liquipedia' | 'ultrank' | 'startgg';
  sourceRef?: {
    pageTitle?: string;
    pageUrl?: string;
    revisionId?: number;
    rawTier?: string;
    rawTierType?: string;
  };
}

/**
 * The UltRank letter -> app tier map (39.1-TIER-RESEARCH §5.1). ONLY `D ->
 * regional` is owner-locked (D-03); the remaining letters follow the research
 * table. The map is typed but unread until the owner revisits T-07.
 */
export const ULTRANK_TO_APP_TIER: Record<string, KnownTierWord> = {
  SP: 'supermajor',
  'P+': 'supermajor',
  P: 'supermajor',
  'S+': 'supermajor',
  S: 'supermajor',
  'A+': 'major',
  A: 'major',
  'B+': 'minor',
  B: 'minor',
  C: 'regional',
  D: 'regional',
};

/** 39.1-TIER-RESEARCH §5.1: conservative event-name tokens marking a side event (matched as whole words/phrases). */
export const SIDE_EVENT_NAME_TOKENS = [
  'squad strike',
  'doubles',
  'teams',
  'crews',
  'ladder',
  'amateur',
  'redemption',
  'low tier',
  'random',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word/phrase test, built per call so this module has no top-level evaluation (sideEffects audit). */
function containsWholePhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}($|[^a-z0-9])`, 'i').test(text);
}

/**
 * Case-insensitive whole-word/phrase match against `SIDE_EVENT_NAME_TOKENS`
 * -> `side-event`; a non-blank name with no match -> `main`; a blank name ->
 * `unknown`. The stored provider `eventType` is persisted but deliberately
 * NOT interpreted in 39.2 (Assumption A3) — only the name decides.
 */
export function deriveEventKind(eventName: string): TierEventKind {
  const name = eventName.trim();
  if (name === '') {
    return 'unknown';
  }
  return SIDE_EVENT_NAME_TOKENS.some((token) => containsWholePhrase(name, token))
    ? 'side-event'
    : 'main';
}

/**
 * A stored boolean decides (`false` -> offline, `true` -> online); otherwise
 * caller-supplied evidence that the entry's own matches were online decides
 * `online`; otherwise `unknown`. An ABSENT `isOnline` is never evidence of
 * offline: the live sync maps absence to `offline-tourney` (F2, sync.ts), so
 * treating absence as offline would estimate online mega-events.
 */
export function deriveSetting(input: {
  isOnline?: boolean | null;
  observedOnline?: boolean | null;
}): TierSetting {
  if (input.isOnline === false) {
    return 'offline';
  }
  if (input.isOnline === true) {
    return 'online';
  }
  return input.observedOnline === true ? 'online' : 'unknown';
}

/**
 * Bound for the stored provider `eventType` string, equal to the research
 * ingestion bound so a value lifted from the research source (plan 39.2-04)
 * can never fail the row schema. Imported, never re-declared: the research
 * modules import neither `startgg.ts` nor `tournamentRegistry.ts`, so there
 * is no import cycle.
 */
export const TOURNAMENT_EVENT_TYPE_MAX_LENGTH = RESEARCH_MAX_PROVIDER_TEXT;

/**
 * `tournamentEntries/{uid}/{entryKey}.tierOverride` — the STORED shape. The
 * server stamps `contractVersion` and `setAtMs` (the client never sends
 * them). Every writer conditional-spreads; the member itself is `.nullish()`
 * on both row shapes (RTDB null-stripping house rule).
 */
export const tierOverrideStoredSchema = z.object({
  contractVersion: z.number().int(),
  tier: z.enum(TIER_WORDS),
  setAtMs: z.number().int().nonnegative(),
});
export type TierOverrideStored = z.infer<typeof tierOverrideStoredSchema>;

/**
 * Tier PATCH request body. `tierOverride: null` is a REQUEST INTENT meaning
 * "clear the override" — never a stored value. Only `tier` is client-settable.
 */
export const tierOverrideUpdateBodySchema = z.object({
  tierOverride: z.object({ tier: z.enum(TIER_WORDS) }).nullable(),
});
export type TierOverrideUpdateBody = z.infer<typeof tierOverrideUpdateBodySchema>;

/** Tier PATCH response — the entry's current stored override, if any. */
export const tierOverrideResponseSchema = z.object({
  entryKey: z.string().min(1),
  tierOverride: tierOverrideStoredSchema.nullish(),
});
export type TierOverrideResponse = z.infer<typeof tierOverrideResponseSchema>;

/**
 * STRUCTURAL input: both `TournamentEntry` and `TournamentRegistryRow`
 * satisfy it, so this module never imports `startgg.ts`/`tournamentRegistry.ts`
 * (which import THIS module for the override schema).
 */
export interface TierEntryFields {
  eventName: string;
  numEntrants?: number | null;
  isOnline?: boolean | null;
  eventType?: string | null;
  tierOverride?: TierOverrideStored | null;
}

/** The resolved tier and its full provenance. Computed at read time; never persisted (D-04). */
export interface TierResolution {
  tier: TierWord;
  level: number;
  basis: TierBasis;
  source: TierSource;
  setting: TierSetting;
  eventKind: TierEventKind;
  reason: TierUnknownReason | null;
  entrants: number | null;
  /** What the entrant-count estimate says whenever it COULD produce a tier, even when a higher rung won ("Estimate would have been", UI-SPEC §7.6). */
  estimate: { tier: TierWord; entrants: number } | null;
  ignoredOverrideReason: 'unsupported-contract-version' | null;
  sourceRef?: ExternalTierInput['sourceRef'];
  policyVersion: number;
}

/**
 * The ONE tier resolver. Pure: no clock, no randomness, no module state.
 * Clauses, in order:
 *
 * 1. A stored override wins (basis/source `manual`). One whose
 *    `contractVersion` exceeds `TIER_OVERRIDE_CONTRACT_VERSION` is ignored
 *    WHOLE and reported as `ignoredOverrideReason`. An override of `unknown`
 *    resolves `unknown` with reason `manual`.
 * 2. The reserved `externalTierRow` (basis `recorded`).
 * 3. The entrant-count estimate — ONLY when the setting is positively
 *    `offline`, the event is not a `side-event`, and the event's own
 *    `numEntrants` is present (F2/D-02).
 * 4. `unknown`, with the FIRST applicable reason in the order online,
 *    sideEvent, noEntrants, settingUnknown.
 *
 * `observedOnline` is caller-supplied evidence (any of the entry's own
 * matches were online) for entries with no stored `isOnline`.
 */
export function resolveTournamentTier(input: {
  entry: TierEntryFields;
  observedOnline?: boolean | null;
  externalTierRow?: ExternalTierInput | null;
  /** Calibration-oracle ONLY: a mutated ladder to prove the oracle's failing direction. Production callers omit it. */
  ladder?: readonly { tier: KnownTierWord; minEntrants: number }[];
}): TierResolution {
  const { entry, externalTierRow } = input;
  const eventKind = deriveEventKind(entry.eventName);
  const setting = deriveSetting({ isOnline: entry.isOnline, observedOnline: input.observedOnline });
  const entrants = entry.numEntrants ?? null;

  const estimate =
    setting === 'offline' && eventKind !== 'side-event' && entrants != null
      ? { tier: estimateTierFromEntrants(entrants, input.ladder) as TierWord, entrants }
      : null;

  const base = {
    setting,
    eventKind,
    entrants,
    estimate,
    policyVersion: TIER_ESTIMATE_POLICY_VERSION,
  };

  let ignoredOverrideReason: TierResolution['ignoredOverrideReason'] = null;
  const override = entry.tierOverride;
  if (override) {
    if (override.contractVersion > TIER_OVERRIDE_CONTRACT_VERSION) {
      ignoredOverrideReason = 'unsupported-contract-version';
    } else {
      return {
        ...base,
        tier: override.tier,
        level: tierLevel(override.tier),
        basis: 'manual',
        source: 'manual',
        reason: override.tier === 'unknown' ? 'manual' : null,
        ignoredOverrideReason: null,
      };
    }
  }

  if (externalTierRow) {
    return {
      ...base,
      tier: externalTierRow.tier,
      level: tierLevel(externalTierRow.tier),
      basis: 'recorded',
      source: externalTierRow.source,
      reason: null,
      ignoredOverrideReason,
      ...(externalTierRow.sourceRef ? { sourceRef: externalTierRow.sourceRef } : {}),
    };
  }

  if (estimate) {
    return {
      ...base,
      tier: estimate.tier,
      level: tierLevel(estimate.tier),
      basis: 'estimated',
      source: 'heuristic',
      reason: null,
      ignoredOverrideReason,
    };
  }

  const reason: TierUnknownReason =
    setting === 'online'
      ? 'online'
      : eventKind === 'side-event'
        ? 'sideEvent'
        : entrants == null
          ? 'noEntrants'
          : 'settingUnknown';

  return {
    ...base,
    tier: 'unknown',
    level: 0,
    basis: 'unknown',
    source: 'none',
    reason,
    ignoredOverrideReason,
  };
}
