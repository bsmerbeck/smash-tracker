import { z } from 'zod';
import type { Match } from './match.js';
import type { EvidenceClaim } from './evidence/types.js';
import { classify, type ClassifyResult } from './insight/ladder.js';
import { scoreInsight } from './insight/salience.js';
import { formNowTemplate } from './insight/templates/formNow.js';
import type { HorizonKey, RateValue } from './insight/types.js';
import {
  WATCHLIST_MAX_ITEMS,
  trackedItemScope,
  watchlistItemKeySchema,
  type WatchlistItem,
} from './watchlist.js';

/**
 * Phase 39.2 (D-05, D-06, T-03): the since-last-visit digest's pure core — the
 * "moved" classification of a tracked item. No clock is read and there is no
 * module-level mutable binding (mirror of `insight/purity.test.ts`): every
 * time-dependent input arrives as an argument.
 *
 * A tracked item has MOVED when its two-horizon state CLASS changed between
 * the device's last snapshot and now. The class is the engine's own ladder
 * read at the fixed `DIGEST_HORIZON`, never a direction the item computes for
 * itself, and never the page's horizon switch (so flipping the switch cannot
 * reshuffle the digest).
 */

/** T-03/D-05: the digest reads every item at this horizon, regardless of the page's `HorizonSwitch`. */
export const DIGEST_HORIZON: HorizonKey = 'last30';

/**
 * The Wilson z the "moved" test uses in place of the engine's 1.96.
 *
 * Two-sided Bonferroni for 25 items at alpha 0.05 (z about 3.09). The digest
 * runs a max-of-25 selection on every visit, and at 1.96 a roster with no real
 * change shows a false mover in 14-88% of digests (RESEARCH Pattern 8).
 * `digest.nullRoster.test.ts` is the acceptance value: it must hold the
 * probability of a false DIRECTION move at or under
 * `MOVED_FALSE_DIRECTION_BUDGET` in every cell, and must FAIL at 1.96. The
 * honest outcome at these sample sizes is usually "No tracked item moved" —
 * do not tune this down to show more movers.
 */
export const MOVED_NOTABLE_Z = 3.09;

/** The most a 25-item digest may falsely show a direction move (up, down or asserting), per digest, on a null roster. */
export const MOVED_FALSE_DIRECTION_BUDGET = 0.05;

/** D-06: the digest shows at most this many moved rows; the rest collapse into a count. */
export const DIGEST_MOVED_ROW_CAP = 5;

/** The whitelisted per-item state classes a device snapshot may hold. `none` = no games in the item's scope. */
export const DIGEST_STATE_CLASSES = [
  'up',
  'down',
  'steady',
  'locked',
  'thin',
  'thinRecent',
  'collapsed',
  'none',
] as const;
export type DigestStateClass = (typeof DIGEST_STATE_CLASSES)[number];

/** What a moved item renders as. */
export type DigestMovedToken = 'up' | 'down' | 'steady' | 'unlocked' | 'asserting';

/**
 * Maps the engine's ladder result to a snapshot class. `trend`/`suggestion`
 * carry a direction by the sign of their whole-point delta; a zero delta
 * cannot assert one and reads `steady`. `fact` (never returned by `classify`)
 * and `hidden` carry no read, so they map to `none`.
 */
export function stateClassFromClassify(result: ClassifyResult): DigestStateClass {
  switch (result.state) {
    case 'trend':
    case 'suggestion':
      if (result.deltaPoints === null || result.deltaPoints === 0) return 'steady';
      return result.deltaPoints > 0 ? 'up' : 'down';
    case 'steady':
    case 'locked':
    case 'thin':
    case 'thinRecent':
    case 'collapsed':
      return result.state;
    case 'fact':
    case 'hidden':
      return 'none';
  }
}

/** The `RateValue` an insight claim carries. An abstained claim only exposes its game count, which is all `classify` reads before it returns `locked`. */
function rateOfClaim(claim: EvidenceClaim<RateValue>): RateValue {
  if (claim.kind === 'evidenced') {
    return claim.value;
  }
  const total = claim.sample.rawSampleSize;
  return { wins: 0, losses: total, total, rate: 0 };
}

export interface DigestItemRead {
  stateClass: DigestStateClass;
  /** The engine's own salience for this read (never rendered), used only to order moved rows. */
  salience: number;
}

/**
 * Reads one tracked item: builds its `InsightScope`, runs the `formNow`
 * template at `DIGEST_HORIZON` (so the recent/baseline rates are exactly the
 * ones the engine computes for that scope — D-15 recency bound included), then
 * re-classifies those two rates with the engine's own `classify` at
 * `MOVED_NOTABLE_Z`. No direction math lives here (D-05).
 */
export function readTrackedItem(input: {
  matches: Match[];
  item: WatchlistItem;
  nowMs: number;
  opponentAliases?: readonly string[];
}): DigestItemRead {
  const { matches, item, nowMs, opponentAliases } = input;
  const scope = trackedItemScope(item, { opponentAliases });
  const insight = formNowTemplate.build({ matches, scope, horizon: DIGEST_HORIZON, nowMs })[0];
  if (insight === undefined) {
    return { stateClass: 'none', salience: 0 };
  }
  const result = classify({
    recent: rateOfClaim(insight.recent),
    baseline: rateOfClaim(insight.baseline),
    scoped: true,
    hasAction: false,
    z: MOVED_NOTABLE_Z,
  });
  const salience = scoreInsight(
    { ...insight, state: result.state, kind: result.kind, deltaPoints: result.deltaPoints },
    nowMs,
  );
  return { stateClass: stateClassFromClassify(result), salience };
}

/** The state class of one tracked item at the digest's fixed horizon and stricter z. */
export function stateClassFor(input: {
  matches: Match[];
  item: WatchlistItem;
  nowMs: number;
  opponentAliases?: readonly string[];
}): DigestStateClass {
  return readTrackedItem(input).stateClass;
}

/**
 * The D-05 transition table. A move is ONLY:
 * - `steady`/`up`/`down` to a different one of those three -> the new class;
 * - `locked` to any state that is neither `locked` nor `none` -> `unlocked`;
 * - `thin`/`thinRecent`/`collapsed` to `up`/`down` -> `asserting`.
 * Everything else — thin to steady, collapsed to steady, thin to collapsed
 * (sample-size artefacts), an item with no snapshot entry (`prev` undefined,
 * DD-16), or an item whose scope has emptied (`none`) — is not a move.
 */
export function movedTransition(
  prev: DigestStateClass | undefined,
  next: DigestStateClass,
): DigestMovedToken | null {
  if (prev === undefined || prev === next || next === 'none') {
    return null;
  }
  const prevIsDirectional = prev === 'steady' || prev === 'up' || prev === 'down';
  const nextIsDirectional = next === 'steady' || next === 'up' || next === 'down';
  if (prevIsDirectional && nextIsDirectional) {
    return next;
  }
  if (prev === 'locked') {
    return 'unlocked';
  }
  if (
    (prev === 'thin' || prev === 'thinRecent' || prev === 'collapsed') &&
    (next === 'up' || next === 'down')
  ) {
    return 'asserting';
  }
  return null;
}

/**
 * T-03: the device-local snapshot at `smash-tracker.analyticsDigest.<uid>.<subject>`.
 * `tracked` holds only whitelisted state classes under valid item keys and at
 * most `WATCHLIST_MAX_ITEMS` of them.
 */
export const digestSnapshotSchema = z.object({
  lastSeenAt: z.number().int().nonnegative(),
  lastSeenMatchCount: z.number().int().nonnegative(),
  tracked: z
    .record(watchlistItemKeySchema, z.enum(DIGEST_STATE_CLASSES))
    .refine((tracked) => Object.keys(tracked).length <= WATCHLIST_MAX_ITEMS, {
      message: 'tracked holds at most 25 items (WATCHLIST_MAX_ITEMS)',
    }),
});
export type DigestSnapshot = z.infer<typeof digestSnapshotSchema>;

/**
 * Tolerant parse of the stored snapshot text. Absent, invalid JSON, a wrong
 * shape, an unknown class or an oversized `tracked` map all read as `null` —
 * a first visit (DD-16) — never a throw: a corrupt or tampered device-local
 * value must not break the Dashboard. The catch is deliberate and total; the
 * only failure it can hide is malformed JSON text, which IS the "absent" case.
 */
export function parseDigestSnapshot(raw: string | null | undefined): DigestSnapshot | null {
  if (raw === null || raw === undefined || raw.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = digestSnapshotSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** One moved item with the engine salience that orders it. */
export interface DigestMovedEntry {
  itemKey: string;
  token: DigestMovedToken;
  salience: number;
}

/**
 * D-06: at most `DIGEST_MOVED_ROW_CAP` moved rows, highest engine salience
 * first (ties by `itemKey`, so the order never depends on input order), plus
 * the count of the rest. Does not mutate its input.
 */
export function selectMovedItems<T extends DigestMovedEntry>(
  entries: readonly T[],
): { shown: T[]; moreCount: number } {
  const ordered = [...entries].sort((a, b) => {
    if (b.salience !== a.salience) {
      return b.salience - a.salience;
    }
    return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
  });
  return {
    shown: ordered.slice(0, DIGEST_MOVED_ROW_CAP),
    moreCount: Math.max(0, ordered.length - DIGEST_MOVED_ROW_CAP),
  };
}
