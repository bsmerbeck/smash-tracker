import type { EvidenceClaim } from '../evidence/types.js';
import type { Match } from '../match.js';

/**
 * The Phase 39.1 insight engine's core vocabulary (INS-01, INS-02, INS-04,
 * D-06, D-07, D-15). `Insight.recent`/`Insight.baseline` compose
 * `EvidenceClaim<T>` from `evidence/types.ts` as a READ-ONLY import — never a
 * parallel claim shape. This barrel is deliberately NOT re-exported through
 * `packages/shared/src/evidence/index.ts` in Phase 39.1 (that file is owned
 * by Phase 38 plan 01), per `39.1-CONTEXT.md` Claude's Discretion and
 * `39.1-PARALLELISM.md` Rule B1/B2. The whole `insight/` directory is kept
 * self-contained: it imports individual, stable `evidence/*` modules
 * directly (types, policy, predicate) but never `evidence/eventSeries.ts` or
 * the `evidence/index.ts` barrel, so this module never depends on anything
 * Phase 38 is actively editing.
 */

/** The closed set of insight cards this phase and its planned follow-ons define (UI-SPEC §9.3). New ids require a UI-SPEC revision, never an inline string. */
export type InsightTemplateId =
  | 'formNow'
  | 'characterMovers'
  | 'rivalMovers'
  | 'lastEventRecap'
  | 'ratingMove'
  | 'tiltCost'
  | 'sessionFatigue'
  | 'settingGap'
  | 'volumeForm'
  | 'mixShift'
  | 'rosterCore'
  | 'rosterShift'
  | 'secondaryPayoff'
  | 'pocketCost'
  | 'matchupOrPlayer'
  | 'bestMatchup'
  | 'worstMatchup';

/** D-06: the three recent-window choices a page-level `HorizonSwitch` offers. There is no "last 10 games" option — at n = 10 almost no delta clears the noise test. */
export type HorizonKey = 'last30' | 'lastEvent' | 'last90';

/**
 * UI-SPEC §7.8's honesty ladder, restated as a closed union: `trend`/
 * `suggestion` assert a direction; `fact`/`steady`/`collapsed` are
 * evidence-backed but direction-free; `thin`/`thinRecent`/`locked` are the
 * three designed non-assertive states (D-07); `hidden` means the template
 * declined to render at all (e.g. `MixShift` below its share-shift floor).
 */
export type InsightState =
  | 'trend'
  | 'suggestion'
  | 'fact'
  | 'steady'
  | 'thin'
  | 'thinRecent'
  | 'locked'
  | 'collapsed'
  | 'hidden';

/**
 * D-11: the engine-set claim kind that maps to the UI's `Fact | Trend |
 * Suggestion` chip. The ENGINE sets this (via `ladder.ts`'s `classify`) — a
 * template never chooses it directly.
 */
export type InsightKind = 'fact' | 'inference' | 'recommendation';

/** A win/loss record as a 0..1 proportion — never a percent. Percent formatting is the UI's job (UI-SPEC §9.2 rule 6). */
export interface RateValue {
  wins: number;
  losses: number;
  total: number;
  rate: number;
}

/** The recency window one `Insight` was computed over. `fromMs`/`toMs` are the REAL first/last game timestamps in the window (or `null` for an empty window) — the date span the UI prints (D-15). */
export interface InsightWindow {
  horizon: HorizonKey;
  fromMs: number | null;
  toMs: number | null;
  games: number;
  /** True when this window was additionally bounded by D-15's 12-month scoped-recency rule. */
  scoped: boolean;
}

/** An i18n key path plus already-formatted interpolation values — the engine never localises (UI-SPEC §9.2 rule 6). */
export interface InsightCopy {
  key: string;
  values: Record<string, string | number>;
}

export type InsightDoorKind =
  'games' | 'matchup' | 'opponent' | 'stage' | 'event' | 'vods' | 'ratingModel';

/** One drill-down button on an `InsightCard` (UI-SPEC §7.8's DOORS row). `axes` feeds Phase 38's drill-down URL contract (DD-09) — never a page-level `onClick` mutation. */
export interface InsightDoor {
  kind: InsightDoorKind;
  axes: Record<string, string | number>;
  count: number;
}

/**
 * An optional inline visualization payload (a dumbbell-row set, a meter
 * list, a strip) a card's MARK row renders. Content shape is per-`kind`; no
 * consumer of this phase reads it except `rail.ts`'s merged `UnlocksNext`
 * result (`kind: 'meters'`). Intentionally loose — later plans (39.1-03/04/05)
 * add their own kinds without touching this declaration.
 */
export interface InsightMark {
  kind: string;
  data: unknown;
}

/**
 * The one typed object every insight template returns. `id` is the stable
 * `${templateId}:${scopeKey}:${horizonKey}` string a dismiss/restore action
 * keys on. `salience` is set by the engine (`computeInsights`, via
 * `salience.ts`'s `scoreInsight`) — a template never sets its own salience.
 * `deltaPoints` is non-null in EXACTLY the `trend` and `suggestion` states
 * (D-07, `ladder.ts`'s `classify`).
 */
export interface Insight {
  id: string;
  templateId: InsightTemplateId;
  scopeKey: string;
  horizon: HorizonKey;
  kind: InsightKind;
  state: InsightState;
  recent: EvidenceClaim<RateValue>;
  baseline: EvidenceClaim<RateValue>;
  deltaPoints: number | null;
  window: InsightWindow;
  salience: number;
  copy: InsightCopy;
  doors: InsightDoor[];
  mark?: InsightMark;
  gamesNeeded?: number;
}

/** The four scope kinds a template may be asked to assess. `account` is the whole-account view (no scoping, no D-15 recency bound); the other three are subject/cohort-scoped (D-15 applies). */
export type InsightScopeKind = 'account' | 'character' | 'player' | 'stage';

/**
 * Identifies which slice of the account's `Match[]` a template should
 * assess. `key` is the caller-supplied stable identifier a template composes
 * into `Insight.scopeKey` ("account" for the whole-account scope; e.g.
 * "character:23", "player:sparg0", "stage:1" for a scoped read) — the
 * ENGINE never derives axis identity itself (D-15/D-09 discipline: axis
 * identity is supplied at the boundary, not re-derived inside the pure
 * engine). `filter` narrows `Match[]` to this scope's own matches; `filter`
 * is pure data-narrowing, never claim logic — deriving a claim kind, a
 * direction or a threshold stays the engine's job (UI-SPEC §9.1).
 */
export interface InsightScope {
  kind: InsightScopeKind;
  key: string;
  /** Drill-down axes this scope contributes to a door's URL (DD-09) — empty for the whole-account scope. */
  axes?: Record<string, string | number>;
  filter: (matches: Match[]) => Match[];
}

/** The canonical whole-account scope — no filtering, no D-15 recency bound. Shared by every plan/test that needs the account-level view rather than re-declaring an identity filter. */
export const ACCOUNT_SCOPE: InsightScope = {
  kind: 'account',
  key: 'account',
  axes: {},
  filter: (matches: Match[]): Match[] => matches,
};

/** DD-08: one progress meter inside a merged `UnlocksNext` result. */
export interface UnlocksNextMeter {
  key: string;
  have: number;
  need: number;
  unit: string;
}

/** DD-08: the result of merging two or more `locked` candidates into one rail card — at most `UNLOCKS_NEXT_METER_CAP` meters (`rail.ts`'s `assembleRail`). */
export interface UnlocksNextResult {
  meters: UnlocksNextMeter[];
  scopeKeys: string[];
}
