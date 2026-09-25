import { ABSTENTION_FLOOR_GAMES } from '../evidence/policy.js';
import { RAIL_CARD_CAP, UNLOCKS_NEXT_METER_CAP } from './policy.js';
import type { Insight, UnlocksNextResult } from './types.js';

export interface AssembleRailResult {
  cards: Insight[];
  lines: Insight[];
  unlocksNext: UnlocksNextResult | null;
  promotionQueue: Insight[];
}

/** Descending by `Insight.salience` (already populated by `engine.ts`'s `computeInsights` — this function never recomputes it), ties broken by `templateId` then `scopeKey` ascending, so the same input always sorts to the same output (determinism). */
function bySalienceThenId(a: Insight, b: Insight): number {
  if (b.salience !== a.salience) {
    return b.salience - a.salience;
  }
  if (a.templateId !== b.templateId) {
    return a.templateId < b.templateId ? -1 : 1;
  }
  if (a.scopeKey !== b.scopeKey) {
    return a.scopeKey < b.scopeKey ? -1 : 1;
  }
  return 0;
}

/**
 * The degenerate synthetic fallback for a rail with genuinely ZERO
 * candidates of any kind (D-14: "a rail is never empty"). This branch is
 * reachable more often than its old doc comment claimed (WR-A03,
 * 39.1-REVIEW.md): a host whose wired `RAIL_TEMPLATES` set doesn't include
 * enough always-a-fact back-fill templates for a given scope/horizon can
 * still land here even for a large, steady account (e.g. an
 * account-scoped rail on a horizon where every wired template is
 * `hidden`/`collapsed`). Because this card carries NO real backing sample
 * (`refreshedAt: 0`, null date range), its copy must never assert a
 * specific "N more games" requirement — that claim was true for the OLD
 * `insights.formNow.locked` reuse (which correctly describes formNow's own
 * degenerate case) but is an outright false claim once other templates are
 * the reason this branch fires. `insights.rail.unavailable` makes no game-count
 * claim at all — a distinct, honest copy key, not a borrowed one.
 */
const FALLBACK_LOCKED_INSIGHT: Insight = {
  id: 'formNow:account:last30',
  templateId: 'formNow',
  scopeKey: 'account',
  horizon: 'last30',
  kind: 'fact',
  state: 'locked',
  recent: {
    kind: 'abstained',
    claimType: 'fact',
    reason: 'insufficient-sample',
    sample: {
      rawSampleSize: 0,
      eligibleDenominator: 0,
      knownFieldCoverage: 0,
      dateRange: null,
      refreshedAt: 0,
      evidencePolicyVersion: 1,
      recencyTreatment: 'unweighted',
      confidenceTier: null,
    },
    gamesNeeded: ABSTENTION_FLOOR_GAMES,
  },
  baseline: {
    kind: 'abstained',
    claimType: 'fact',
    reason: 'insufficient-sample',
    sample: {
      rawSampleSize: 0,
      eligibleDenominator: 0,
      knownFieldCoverage: 0,
      dateRange: null,
      refreshedAt: 0,
      evidencePolicyVersion: 1,
      recencyTreatment: 'unweighted',
      confidenceTier: null,
    },
    gamesNeeded: ABSTENTION_FLOOR_GAMES,
  },
  deltaPoints: null,
  window: { horizon: 'last30', fromMs: null, toMs: null, games: 0, scoped: false },
  salience: 0,
  copy: { key: 'insights.rail.unavailable', values: {} },
  doors: [],
  countedMatchIds: [],
  gamesNeeded: ABSTENTION_FLOOR_GAMES,
};

/**
 * UI-SPEC §7.8's `InsightRail` rules (D-07, D-14): at most `cap` cards
 * ranked by (already-populated) salience, never empty, back-filling to the
 * cap with direction-free FACT results before ever inventing a claim, and
 * merging two or more `locked` candidates into one `UnlocksNext` result
 * carrying at most `UNLOCKS_NEXT_METER_CAP` meters. `steady`/`thinRecent`
 * results are lines, never cards; `hidden` results are dropped entirely.
 */
export function assembleRail(input: { insights: Insight[]; cap?: number }): AssembleRailResult {
  const { insights, cap = RAIL_CARD_CAP } = input;

  const assertive: Insight[] = [];
  const factsOnly: Insight[] = [];
  const lines: Insight[] = [];
  const locked: Insight[] = [];

  for (const insight of insights) {
    switch (insight.state) {
      case 'hidden':
        break;
      case 'locked':
        locked.push(insight);
        break;
      case 'steady':
      case 'thinRecent':
        lines.push(insight);
        break;
      case 'trend':
      case 'suggestion':
        assertive.push(insight);
        break;
      case 'fact':
      case 'collapsed':
      case 'thin':
        // `thin` is a direction-free Fact too (record only, D-07) — same
        // back-fill treatment as `fact`/`collapsed` (D-14).
        factsOnly.push(insight);
        break;
      default:
        break;
    }
  }

  assertive.sort(bySalienceThenId);
  factsOnly.sort(bySalienceThenId);
  locked.sort(bySalienceThenId);

  const cards: Insight[] = [];
  const promotionQueue: Insight[] = [];

  for (const insight of assertive) {
    if (cards.length < cap) {
      cards.push(insight);
    } else {
      promotionQueue.push(insight);
    }
  }
  for (const insight of factsOnly) {
    if (cards.length < cap) {
      cards.push(insight);
    } else {
      promotionQueue.push(insight);
    }
  }

  let unlocksNext: UnlocksNextResult | null = null;

  if (locked.length >= 2) {
    const chosen = locked.slice(0, UNLOCKS_NEXT_METER_CAP);
    const overflow = locked.slice(UNLOCKS_NEXT_METER_CAP);
    unlocksNext = {
      // Review finding CR-A01: `need` used to be hardcoded to
      // `ABSTENTION_FLOOR_GAMES` (3) regardless of which threshold actually
      // produced a `locked` insight's `locked` state — but `locked` is
      // reached via several different floors across templates
      // (`ABSTENTION_FLOOR_GAMES` for formNow/characterMovers/rivalMovers/
      // ratingMove, `COHORT_MIN_SIDE_GAMES` for tiltCost/settingGap/
      // secondaryPayoff, `VOLUME_MIN_MONTHS` for volumeForm). Every template
      // already computes its own requirement and attaches it as the
      // top-level `Insight.gamesNeeded` field (the single source of truth
      // both the template's own locked copy and this merged meter now read)
      // — `need` is simply "what's already banked" plus "what's still
      // needed", in the SAME unit the template itself used to compute
      // `gamesNeeded` (games for most templates; volumeForm's own
      // `gamesNeeded` is a MONTHS count, a known pre-existing unit mismatch
      // this fix does not newly introduce — see 39.1-REVIEW-FIX-part-A.md).
      meters: chosen.map((insight) => ({
        key: insight.id,
        have: insight.recent.sample.eligibleDenominator,
        need:
          insight.gamesNeeded !== undefined
            ? insight.recent.sample.eligibleDenominator + insight.gamesNeeded
            : ABSTENTION_FLOOR_GAMES,
        unit: 'games',
      })),
      scopeKeys: chosen.map((insight) => insight.scopeKey),
    };
    if (cards.length < cap) {
      cards.push(chosen[0]!);
    } else {
      promotionQueue.push(chosen[0]!);
    }
    promotionQueue.push(...chosen.slice(1), ...overflow);
  } else if (locked.length === 1) {
    if (cards.length < cap) {
      cards.push(locked[0]!);
    } else {
      promotionQueue.push(locked[0]!);
    }
  }

  if (cards.length === 0) {
    cards.push(FALLBACK_LOCKED_INSIGHT);
  }

  return { cards, lines, unlocksNext, promotionQueue };
}
