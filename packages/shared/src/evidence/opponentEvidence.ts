import type { Match } from '../match.js';
import { makeCanonicalizer, normalizeOpponentTag } from './identity.js';
import { wilsonLowerBound } from './rank.js';
import {
  getStageRecords,
  getWinLossRecord,
  type StageRecord,
  type WinLossRecord,
} from './records.js';
import { rankMatchupsByEvidence, type RankedMatchup } from './matchupEvidence.js';
import {
  ABSTENTION_FLOOR_GAMES,
  confidenceTierFor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from './policy.js';
import { describeCohort, type CohortComposition } from './cohort.js';
import type { ClaimKind, SampleMeta } from './types.js';

/**
 * EVID-12, D-16, ROADMAP SC1 clause 3 — the surface where the alias map is
 * load-bearing. This module is the answer to "what does alias resolution
 * actually change": `buildStageEvidence`/`buildMatchupEvidence` group on a
 * numeric key an alias could never move (see their own doc comments); this
 * module groups on the RESOLVED OPPONENT IDENTITY, so the merge IS the
 * grouping key.
 *
 * D-16 split (R2-MEDIUM-3): this module makes D-16 ("callers can no longer
 * forget to pre-alias") SATISFIED for its two entry points below —
 * `aliasMap` is a required parameter on both, no default, no optional
 * marker. It is FROZEN-NOT-CLOSED for the legacy `getOpponentRecords`/
 * `getOpponentProfile` pair still exported from `apps/web/src/lib/stats.ts`
 * (raw-tag keyed, no identity resolution) — a caller importing those can
 * still forget. Phase 38's opponent hub retires the legacy pair.
 */

/**
 * A single normalizer + hop, an idempotent normalizer-then-alias resolver,
 * and a start.gg-slug / parry.gg-id binding pass — resolving each match to
 * a stable identity string.
 *
 * Two-pass resolution:
 * 1. Build the slug/parry-id binding: for every match carrying
 *    `opponentUserSlug` or `opponentParryUserId` whose canonicalized tag is
 *    not `'unknown'`, record `sgg:<slug>` / `pgg:<id>` -> that canonical
 *    tag. Matches are processed in ascending `time` (tiebreak: ascending
 *    `id`) so the FIRST binding wins, making the map deterministic for a
 *    given input array.
 * 2. Resolve each match: a slug/parry-id WITH a recorded binding resolves
 *    to that bound canonical tag; a slug/parry-id with NO binding resolves
 *    to the `sgg:`/`pgg:` key itself (a person known only by an id is still
 *    one person, not part of the unnamed bucket, and is never conflated
 *    with a different unidentified person); anything else resolves to
 *    `canonicalOpponentName(match.opponent, aliasMap)`, which is
 *    `'unknown'` for an absent/empty tag.
 */
export function resolveOpponentIdentities(
  matches: Match[],
  aliasMap: Record<string, string>,
): (match: Pick<Match, 'opponent' | 'opponentUserSlug' | 'opponentParryUserId'>) => string {
  const canonicalize = makeCanonicalizer(aliasMap);
  const bindings = new Map<string, string>();

  const candidates = matches
    .filter((m) => m.opponentUserSlug || m.opponentParryUserId)
    .slice()
    .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id.localeCompare(b.id)));

  for (const match of candidates) {
    const canonical = canonicalize(match.opponent);
    if (canonical === 'unknown') {
      continue;
    }
    if (match.opponentUserSlug) {
      const key = `sgg:${match.opponentUserSlug}`;
      if (!bindings.has(key)) {
        bindings.set(key, canonical);
      }
    }
    if (match.opponentParryUserId) {
      const key = `pgg:${match.opponentParryUserId}`;
      if (!bindings.has(key)) {
        bindings.set(key, canonical);
      }
    }
  }

  return (match: Pick<Match, 'opponent' | 'opponentUserSlug' | 'opponentParryUserId'>): string => {
    if (match.opponentUserSlug) {
      const key = `sgg:${match.opponentUserSlug}`;
      return bindings.get(key) ?? key;
    }
    if (match.opponentParryUserId) {
      const key = `pgg:${match.opponentParryUserId}`;
      return bindings.get(key) ?? key;
    }
    return canonicalize(match.opponent);
  };
}

/** Matches `useFilteredMatches.ts`'s `OpponentSource` member-for-member, plus `'mixed'` — see `computeProviderLabel` for the verbatim-ported branch order. */
export type OpponentProviderLabel = 'startgg' | 'parrygg' | 'manual' | 'mixed';

/**
 * Verbatim port of `useFilteredMatches.ts`'s `getOpponentSources` branch
 * order (R3-MEDIUM-1): the `'mixed'` case is checked FIRST because it's the
 * common multi-source case — checking a single source first would silently
 * downgrade a multi-source opponent to a single-source badge, and no
 * committed assertion would catch it.
 */
function computeProviderLabel(matches: Match[]): OpponentProviderLabel {
  let hasStartgg = false;
  let hasParrygg = false;
  let hasManual = false;
  for (const match of matches) {
    if (match.source === 'startgg') {
      hasStartgg = true;
    } else if (match.source === 'parrygg') {
      hasParrygg = true;
    } else {
      hasManual = true;
    }
  }
  const siteCount = (hasStartgg ? 1 : 0) + (hasParrygg ? 1 : 0);
  if (siteCount === 2 || (siteCount === 1 && hasManual)) {
    return 'mixed';
  }
  if (hasStartgg) {
    return 'startgg';
  }
  if (hasParrygg) {
    return 'parrygg';
  }
  return 'manual';
}

/**
 * A human, deterministic display tag for an identity group: the alias-map
 * target when the group's identity IS one (an alias value the user chose),
 * otherwise the most-frequent normalized raw tag among the group's
 * matches, tie-broken by earliest `time` then by string. Falls back to the
 * identity itself for a group with no readable tag at all (every match
 * reached it purely via slug/parry-id binding with a blank `opponent`).
 */
function pickDisplayTag(
  identity: string,
  matches: Match[],
  aliasValues: ReadonlySet<string>,
): string {
  if (aliasValues.has(identity)) {
    return identity;
  }
  const counts = new Map<string, { count: number; firstMs: number }>();
  for (const match of matches) {
    const normalized = normalizeOpponentTag(match.opponent);
    if (normalized === 'unknown') {
      continue;
    }
    const existing = counts.get(normalized);
    if (existing) {
      existing.count += 1;
      existing.firstMs = Math.min(existing.firstMs, match.time);
    } else {
      counts.set(normalized, { count: 1, firstMs: match.time });
    }
  }
  if (counts.size === 0) {
    return identity;
  }
  const [best] = [...counts.entries()].sort(([tagA, a], [tagB, b]) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (a.firstMs !== b.firstMs) {
      return a.firstMs - b.firstMs;
    }
    return tagA.localeCompare(tagB);
  });
  return best![0];
}

/**
 * A raw win-loss record's own provenance fields (D-11), for one identity's
 * fact row — NOT gated: the abstention floor is expressed as `abstained`
 * and a null `confidenceTier`, never by omitting the row (R2-BLOCKER-1).
 */
export interface OpponentEvidenceRow extends WinLossRecord {
  /** The resolved grouping key — always a human tag, never a `sgg:`/`pgg:` machine key (see "Which identities become rows" below). */
  identity: string;
  /** A human tag, deterministic for a given input array — see `pickDisplayTag`. */
  displayTag: string;
  /**
   * The row's ungated Wilson lower bound. Named `wilsonUngated`, not
   * `wilson`, so a later `rows.sort((a,b) => b.wilson - a.wilson)` cannot be
   * written by accident and ship a 1-0 "toughest opponent" (R3-LOW-2) — see
   * `rank.ts`'s `rankOpponentsByEvidence` for the one supported way to rank
   * opponents; it gates before it ranks.
   */
  wilsonUngated: number;
  firstPlayedAt: number;
  lastPlayedAt: number;
  source: OpponentProviderLabel;
  /** This row's own provenance fields — not the whole-query sample (see `OpponentEvidenceResult.sample` for that). */
  sample: SampleMeta;
  /** True when this identity's countable games are below `ABSTENTION_FLOOR_GAMES` — a per-row inference state, never a reason to omit the row. */
  abstained: boolean;
  claimType: ClaimKind;
}

export interface UnnamedBucket {
  games: number;
  wins: number;
  losses: number;
  /** How many distinct resolver-level identities contributed to this bucket — an unbound slug-only identity is counted here, never conflated with another unidentified person (see `resolveOpponentIdentities`). */
  distinctIdentities: number;
}

export interface OpponentEvidenceResult {
  rows: OpponentEvidenceRow[];
  /**
   * Games with no human-readable identity at all — either an unbound
   * slug/parry-id, or no tag and no slug/parry-id whatsoever. Computed and
   * returned this phase but rendered by NO Phase 36 surface (R3-LOW-1): the
   * E3 `UnknownRow` component is scoped to the stage/character axes, and an
   * identity-axis unknown row is new visual language outside D-13's cap.
   * Phase 38's opponent hub is where it surfaces.
   */
  unnamed: UnnamedBucket | null;
  /** The whole query's own provenance fields — see each row's own `sample` for its per-row equivalent. */
  sample: SampleMeta;
  cohort: CohortComposition;
}

/**
 * An INVENTORY of every recorded fact the caller has about a named
 * opponent — NOT a ranked directive. Takes NO `minGames` parameter and
 * calls `effectiveFloor` NOWHERE (R2-BLOCKER-1): a raw win-loss record
 * against one person is a `fact` (EVID-06) and D-05's floor governs
 * inferences/recommendations, not whether a fact exists. Emits a row for
 * every identity that resolves to at least one non-`'unknown'` human tag —
 * reproducing today's `getOpponentRecords` listing set exactly, modulo
 * alias merging — with the abstention floor expressed as the row's own
 * `abstained`/`confidenceTier: null` state, never by deleting the row.
 *
 * An identity that is slug-only with no binding stays DISTINCT in the
 * resolver (two unidentified people are never conflated) but produces NO
 * row — a row needs a human `displayTag` — and lands in `unnamed` instead,
 * alongside games with no tag and no slug/parry-id at all.
 */
export function buildOpponentEvidence(input: {
  matches: Match[];
  aliasMap: Record<string, string>;
  refreshedAt: number;
}): OpponentEvidenceResult {
  const { matches, aliasMap, refreshedAt } = input;
  const resolve = resolveOpponentIdentities(matches, aliasMap);
  const aliasValues = new Set(Object.values(aliasMap));

  const byIdentity = new Map<string, Match[]>();
  for (const match of matches) {
    const identity = resolve(match);
    const group = byIdentity.get(identity);
    if (group) {
      group.push(match);
    } else {
      byIdentity.set(identity, [match]);
    }
  }

  const rows: OpponentEvidenceRow[] = [];
  let unnamedGames = 0;
  let unnamedWins = 0;
  let unnamedLosses = 0;
  const unnamedIdentities = new Set<string>();

  for (const [identity, identityMatches] of byIdentity) {
    const isMachineKey = identity.startsWith('sgg:') || identity.startsWith('pgg:');
    if (isMachineKey || identity === 'unknown') {
      unnamedIdentities.add(identity);
      unnamedGames += identityMatches.length;
      unnamedWins += identityMatches.filter((m) => m.win).length;
      unnamedLosses += identityMatches.filter((m) => !m.win).length;
      continue;
    }

    const record = getWinLossRecord(identityMatches);
    const times = identityMatches.map((m) => m.time);
    const firstPlayedAt = Math.min(...times);
    const lastPlayedAt = Math.max(...times);
    const abstained = record.total < ABSTENTION_FLOOR_GAMES;
    const rowSample: SampleMeta = {
      rawSampleSize: record.total,
      eligibleDenominator: record.total,
      knownFieldCoverage: record.total > 0 ? 1 : 0,
      dateRange: { firstMs: firstPlayedAt, lastMs: lastPlayedAt },
      refreshedAt,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      recencyTreatment: RECENCY_TREATMENT,
      confidenceTier: abstained ? null : confidenceTierFor(record.total),
    };

    rows.push({
      identity,
      displayTag: pickDisplayTag(identity, identityMatches, aliasValues),
      ...record,
      wilsonUngated: wilsonLowerBound(record.wins, record.total),
      firstPlayedAt,
      lastPlayedAt,
      source: computeProviderLabel(identityMatches),
      sample: rowSample,
      abstained,
      claimType: 'fact',
    });
  }

  const unnamed: UnnamedBucket | null =
    unnamedGames > 0
      ? {
          games: unnamedGames,
          wins: unnamedWins,
          losses: unnamedLosses,
          distinctIdentities: unnamedIdentities.size,
        }
      : null;

  const rawSampleSize = matches.length;
  const eligibleDenominator = rawSampleSize - unnamedGames;
  const times = matches.map((m) => m.time);
  const dateRange =
    times.length > 0 ? { firstMs: Math.min(...times), lastMs: Math.max(...times) } : null;

  const sample: SampleMeta = {
    rawSampleSize,
    eligibleDenominator,
    knownFieldCoverage: rawSampleSize > 0 ? eligibleDenominator / rawSampleSize : 0,
    dateRange,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(eligibleDenominator),
  };

  return { rows, unnamed, sample, cohort: describeCohort(matches) };
}

/**
 * Field-for-field the same shape `apps/web/src/lib/stats.ts`'s legacy
 * `OpponentProfile` declares — `opponent` (set to the identity's
 * `displayTag`), `record`, `firstPlayedAt`, `lastPlayedAt`, `byTheirFighter`,
 * `byStage`, `recent` — plus one ADDED `source` field, computed the same
 * way a row's is. `OpponentsPage.tsx` reads `profile.opponent` at five
 * separate places (React key, `TendenciesCard`'s prop + `noteMap` lookup,
 * `MergedNamesCard`'s `canonical` prop) so keeping the shape intact matters;
 * `source` exists because `OpponentsPage.tsx`'s current
 * `sources.get(profile.opponent) ?? 'manual'` read fails OPEN to a wrong
 * badge the moment `profile.opponent` is a normalized canonical tag that
 * the stored raw tag wasn't already lowercase/reserved-character-free for.
 *
 * Selects the person's matches by RESOLVED IDENTITY rather than raw
 * `match.opponent === opponentTag` string equality. Applies no floor of its
 * own — a profile is the fact record for one person — except through
 * `byTheirFighter`, which IS a ranked character-pair claim and correctly
 * inherits `rankMatchupsByEvidence`'s floor. `aliasMap` is REQUIRED — no
 * default, no optional marker — so a caller cannot reach this entry point
 * without identity resolution.
 */
export function buildOpponentProfile(input: {
  matches: Match[];
  aliasMap: Record<string, string>;
  opponentTag: string;
  refreshedAt: number;
  recentLimit?: number;
}): {
  opponent: string;
  record: WinLossRecord;
  firstPlayedAt: number;
  lastPlayedAt: number;
  byTheirFighter: RankedMatchup[];
  byStage: StageRecord[];
  recent: Match[];
  source: OpponentProviderLabel;
} | null {
  // `refreshedAt` is part of this entry point's input shape for symmetry
  // with the other builders, but a profile carries no `SampleMeta` of its
  // own (it mirrors the legacy `OpponentProfile` shape field-for-field) —
  // so it's deliberately not read here.
  const { matches, aliasMap, opponentTag, recentLimit = 10 } = input;
  const resolve = resolveOpponentIdentities(matches, aliasMap);
  const aliasValues = new Set(Object.values(aliasMap));
  const targetIdentity = resolve({ opponent: opponentTag });
  const versus = matches.filter((m) => resolve(m) === targetIdentity);
  if (versus.length === 0) {
    return null;
  }
  const sorted = [...versus].sort((a, b) => a.time - b.time);
  return {
    opponent: pickDisplayTag(targetIdentity, versus, aliasValues),
    record: getWinLossRecord(versus),
    firstPlayedAt: sorted[0]!.time,
    lastPlayedAt: sorted[sorted.length - 1]!.time,
    byTheirFighter: rankMatchupsByEvidence(versus),
    byStage: getStageRecords(versus).sort((a, b) => b.total - a.total),
    recent: sorted.slice(-recentLimit).reverse(),
    source: computeProviderLabel(versus),
  };
}
