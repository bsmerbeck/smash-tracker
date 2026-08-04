import { z } from 'zod';
import type { TournamentEntry } from './startgg.js';

/**
 * Phase 26 (PREP-01..04, D-18..D-21): the free deterministic tournament prep
 * brief, bound to a single `tournamentEntries/{uid}/{entryKey}` row. Storage
 * lives at `prepBriefs/{uid}/{entryKey}`. This module owns:
 *
 * - The fixed curated checklist ID tuple (`PREP_CHECKLIST_ITEM_IDS`) — a
 *   compile-time-closed set of 7 machine IDs. No translated label is ever a
 *   storage key; i18n copy is looked up client-side from the ID.
 * - The stored read shape (`prepBriefRecordSchema`) and its normalized,
 *   caller-facing counterpart (`prepBriefSchema`), bridged by
 *   `normalizePrepBriefRecord`.
 * - The API request/response contract schemas consumed by both
 *   `apps/api` and `apps/web`.
 */

/**
 * D-21: the fixed curated checklist (7 items, no custom items in v2.5), in
 * the exact order the "Prep Checklist card" (26-UI-SPEC.md) renders them.
 */
export const PREP_CHECKLIST_ITEM_IDS = [
  'confirmRegistration',
  'reviewRuleset',
  'chargeGear',
  'reviewOpponents',
  'warmUpSets',
  'packBag',
  'planTravel',
] as const;
export type PrepChecklistItemId = (typeof PREP_CHECKLIST_ITEM_IDS)[number];

/**
 * Phase 28 (REV-01/REV-02): the fixed curated post-event review checklist (5
 * items, no custom items) — same machine-id-doubles-as-i18n-leaf-key-doubles-
 * as-RTDB-presence-map-key convention as `PREP_CHECKLIST_ITEM_IDS` above. i18n
 * leaf keys live under `postEvent.checklist.items.*`. Fixed and curated
 * (owner-locked, 28-CONTEXT.md decision 2) — no free-form items.
 */
export const REVIEW_CHECKLIST_ITEM_IDS = [
  'attachVods',
  'addTimestamps',
  'tagTurningPoints',
  'reviewLosses',
  'updateOpponentNotes',
] as const;
export type ReviewChecklistItemId = (typeof REVIEW_CHECKLIST_ITEM_IDS)[number];

/** Server-enforced cap on the number of curated likely-opponent selections a brief may hold. */
export const PREP_LIKELY_OPPONENTS_MAX = 12;

/**
 * D-19: `checklist` and `likelyOpponents` are both presence maps keyed by
 * stable machine IDs (checklist item id, or canonical opponent name) — never
 * translated labels. Absent key = unset/unchecked. Mirrors
 * `opponentMapSchema` (opponent.ts) exactly.
 */
export const prepPresenceMapSchema = z.record(z.string(), z.literal(true));
export type PrepPresenceMap = z.infer<typeof prepPresenceMapSchema>;

const ENTRY_KEY_ILLEGAL_CHARS = /[.#$[\]/]/;

function containsRtdbIllegalEntryKeyChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i);
    if (codePoint !== undefined && codePoint <= 0x1f) {
      return true;
    }
  }
  return ENTRY_KEY_ILLEGAL_CHARS.test(value);
}

/**
 * The ONE shared `entryKey` validator (RESEARCH Pitfall 7) — reused by
 * `apps/api/src/routes/prep.ts`, `prepBindings.ts`, `billing.ts`, and
 * `reports.ts` wherever an entryKey crosses an API boundary. `entryKey` is
 * interpolated directly into `database.ref(...)` paths, so it must reject
 * the same RTDB-reserved path characters (`. # $ [ ] /`) and any code point
 * <= 0x1f (ASCII control characters), matching the real firebase-admin
 * `INVALID_PATH_REGEX` — otherwise an illegal-character value passes Zod
 * validation and the real SDK throws synchronously on `Reference.child`,
 * surfacing as an uncaught 500 instead of a clean 400. Deliberately does
 * NOT trim or lowercase, unlike `opponentNameInputSchema`: an entryKey is a
 * case-sensitive, already-generated key that must match the stored child
 * key byte-for-byte.
 */
export const entryKeyInputSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !containsRtdbIllegalEntryKeyChar(value), {
    message: 'entryKey cannot contain . # $ [ ] / or control characters',
  });
export type EntryKeyInput = z.infer<typeof entryKeyInputSchema>;

/** The three provider identities a curated opponent's scout binding can resolve to (RPT-grounding, 27-CONTEXT.md). */
export const SCOUT_BINDING_PROVIDERS = ['startgg', 'parrygg', 'combined'] as const;
export const scoutBindingProviderSchema = z.enum(SCOUT_BINDING_PROVIDERS);
export type ScoutBindingProvider = z.infer<typeof scoutBindingProviderSchema>;

/** How a binding was resolved: from the player's own match history, or a pasted/selected provider profile. */
export const SCOUT_BINDING_METHODS = ['matchHistory', 'profileInput'] as const;
export const scoutBindingMethodSchema = z.enum(SCOUT_BINDING_METHODS);
export type ScoutBindingMethod = z.infer<typeof scoutBindingMethodSchema>;

/**
 * `prepBriefs/{uid}/{entryKey}/scoutBindings/{opponentName}` — the STORED
 * shape of one curated opponent's confirmed scout binding. Every optional
 * identity field is `.nullish()` (never `.optional()`/`.nullable()` alone)
 * for the same RTDB null-strip reason `prepBriefRecordSchema` documents
 * above: a binding written with e.g. `parryUserId: null` (a start.gg-only
 * binding) comes back with the key absent, and a merely-`.nullable()`
 * schema would reject that shape on read.
 */
export const scoutBindingRecordSchema = z.object({
  provider: scoutBindingProviderSchema,
  /** start.gg numeric player id, when resolved. */
  startggPlayerId: z.number().int().positive().nullish(),
  /** start.gg profile slug, e.g. "user/07dc2239", when resolved. */
  startggUserSlug: z.string().min(1).nullish(),
  /** parry.gg user id (UUID), when resolved. */
  parryUserId: z.string().min(1).nullish(),
  /** The gamer tag shown for this binding at confirmation time. */
  displayTag: z.string().min(1),
  method: scoutBindingMethodSchema,
  /** Epoch ms this binding was confirmed. */
  confirmedAt: z.number().int().nonnegative(),
});
export type ScoutBindingRecord = z.infer<typeof scoutBindingRecordSchema>;

/**
 * The NORMALIZED shape handed to every caller after
 * `normalizeScoutBindingRecord`. The `.refine()` is the single place that
 * enforces "the identity field(s) present agree with `provider`" — every
 * other consumer (including `isReportReadyBinding`) can trust an already-
 * normalized `ScoutBinding` without re-deriving this invariant.
 */
export const scoutBindingSchema = z
  .object({
    provider: scoutBindingProviderSchema,
    startggPlayerId: z.number().int().positive().optional(),
    startggUserSlug: z.string().min(1).optional(),
    parryUserId: z.string().min(1).optional(),
    displayTag: z.string().min(1),
    method: scoutBindingMethodSchema,
    confirmedAt: z.number().int().nonnegative(),
  })
  .refine(
    (binding) => {
      const hasStartgg = Boolean(binding.startggUserSlug) || Boolean(binding.startggPlayerId);
      const hasParry = Boolean(binding.parryUserId);
      if (binding.provider === 'startgg') return hasStartgg;
      if (binding.provider === 'parrygg') return hasParry;
      return hasStartgg && hasParry;
    },
    { message: 'provider and identity fields must agree' },
  );
export type ScoutBinding = z.infer<typeof scoutBindingSchema>;

/**
 * The single normalize-on-read choke point for one binding: conditional-
 * spreads each nullish identity field so a stored `null` never survives
 * into the normalized object (mirrors `normalizePrepBriefRecord` below).
 */
export function normalizeScoutBindingRecord(record: ScoutBindingRecord): ScoutBinding {
  return {
    provider: record.provider,
    ...(record.startggPlayerId != null ? { startggPlayerId: record.startggPlayerId } : {}),
    ...(record.startggUserSlug != null ? { startggUserSlug: record.startggUserSlug } : {}),
    ...(record.parryUserId != null ? { parryUserId: record.parryUserId } : {}),
    displayTag: record.displayTag,
    method: record.method,
    confirmedAt: record.confirmedAt,
  };
}

/**
 * "Report ready" (27-CONTEXT.md "Purchase behavior"): true only when the
 * binding's provider and its identity fields agree — the same predicate the
 * purchase CTA gate and the exactly-three-report-ready bundle rule both use.
 * `combined` requires a start.gg identity AND a parryUserId.
 */
export function isReportReadyBinding(binding: ScoutBinding): boolean {
  const hasStartgg = Boolean(binding.startggUserSlug) || Boolean(binding.startggPlayerId);
  const hasParry = Boolean(binding.parryUserId);
  if (binding.provider === 'startgg') return hasStartgg;
  if (binding.provider === 'parrygg') return hasParry;
  return hasStartgg && hasParry;
}

/** Keys are canonical opponent names — the same key space as `likelyOpponents`. */
export const scoutBindingMapRecordSchema = z.record(z.string(), scoutBindingRecordSchema);
export type ScoutBindingMapRecord = z.infer<typeof scoutBindingMapRecordSchema>;

export const scoutBindingMapSchema = z.record(z.string(), scoutBindingSchema);
export type ScoutBindingMap = z.infer<typeof scoutBindingMapSchema>;

/**
 * `prepBriefs/{uid}/{entryKey}` (D-18) — the STORED read shape. `checklist`
 * and `likelyOpponents` MUST be `.nullish()` (never `.optional()`/
 * `.nullable()`): RTDB deletes a map node entirely once its last key is
 * removed (a fully-unchecked checklist or a fully-cleared opponent
 * selection), and a subsequent read comes back with the key simply absent
 * from the parent object, or explicitly `null` depending on the read path.
 * `.optional()` alone would reject the explicit-`null` shape and
 * `.nullable()` alone would reject the absent-key shape; only `.nullish()`
 * tolerates both. This is the exact incident class from 260725-juj
 * (CONCERNS.md): a `.nullable()`-only stored-read schema threw on a
 * null-stripped subtree and took coaching reads down in production.
 *
 * `scoutBindings` (Phase 27) is a SIBLING null-strip-tolerant map, not a
 * replacement for the Phase 26 `likelyOpponents` presence map: a curated
 * opponent can exist in `likelyOpponents` with no `scoutBindings` entry
 * (unresolved) or with one once confirmed.
 */
export const prepBriefRecordSchema = z.object({
  /** Epoch ms of the event date, carried from the associated tournament entry. */
  eventDate: z.number().int().nonnegative(),
  /** Epoch ms this brief was first activated (created). */
  activatedAt: z.number().int().nonnegative(),
  /** Epoch ms of the most recent reopen (or activation, on first read). */
  lastOpenedAt: z.number().int().nonnegative(),
  /** Presence map of checked checklist item ids — absent/null tolerated (260725-juj class). */
  checklist: prepPresenceMapSchema.nullish(),
  /** Presence map of curated likely-opponent canonical names — absent/null tolerated. */
  likelyOpponents: prepPresenceMapSchema.nullish(),
  /** Confirmed scout bindings keyed by canonical opponent name — absent/null tolerated. */
  scoutBindings: scoutBindingMapRecordSchema.nullish(),
  /**
   * Phase 28 (REV-01, 28-CONTEXT.md "Conversion mechanics"): the IMMUTABLE
   * conversion snapshot, written EXACTLY ONCE by a field-level write-once
   * transaction (mirrors `activatePrepBrief`'s create-once shape, applied to
   * a single field — see `apps/api/src/prep/prep.ts`, 28-04). Absent means
   * "not yet frozen" — the caller must derive a PROVISIONAL candidate via
   * `deriveReviewAtCandidate` and never treat absence as "prep mode forever".
   * `.nullish()` (never a numeric default): a `0` default would read as
   * `0 < now` and instantly convert every legacy brief the moment this field
   * ships (RESEARCH Pitfall 2) — there is no safe default value for a field
   * whose entire meaning is "has this been decided yet". Once present, the
   * stored value is authoritative forever: the registry row (`lastSetAt`,
   * `firstSetAt`) is NEVER re-consulted for mode once `reviewAt` exists, so a
   * later sync that moves `lastSetAt` into the future cannot un-convert a
   * brief that has already flipped to review mode (the owner's
   * never-flip-back invariant).
   */
  reviewAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 28 (owner invariant 4, 28-CONTEXT.md): write-once completion
   * marker for the review checklist, set on the FIRST incomplete→complete
   * transition (28-04's `setPrepReviewChecklistItem` completeness check) and
   * never cleared again — persists forever even if every review checklist
   * item is later unchecked. `.nullish()` for the same null-strip-tolerance
   * reason as every other stored-optional field in this shape.
   */
  reviewCompletedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 28: the review checklist's presence map, a sibling of `checklist`
   * above under the same `prepBriefs/{uid}/{entryKey}` node — same
   * 260725-juj null-strip-tolerance rationale (a fully-unchecked review
   * checklist deletes the map node entirely; RTDB then returns the key
   * absent or explicitly `null`, and only `.nullish()` tolerates both).
   */
  reviewChecklist: prepPresenceMapSchema.nullish(),
});
export type PrepBriefRecord = z.infer<typeof prepBriefRecordSchema>;

/**
 * The NORMALIZED shape handed to every caller after `normalizePrepBriefRecord`
 * — `checklist`/`likelyOpponents`/`scoutBindings` are always present (never
 * absent/null), so downstream code (API responses, web rendering) never
 * re-derives the null-strip tolerance itself.
 */
export const prepBriefSchema = z.object({
  eventDate: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative(),
  lastOpenedAt: z.number().int().nonnegative(),
  checklist: prepPresenceMapSchema,
  likelyOpponents: prepPresenceMapSchema,
  scoutBindings: scoutBindingMapSchema,
  /** Phase 28: present only once the conversion snapshot has been frozen (see `prepBriefRecordSchema.reviewAt`). */
  reviewAt: z.number().int().nonnegative().optional(),
  /** Phase 28: present only once the review checklist has first reached completion. */
  reviewCompletedAt: z.number().int().nonnegative().optional(),
  /** Phase 28: always present (defaults to `{}`), mirrors `checklist`. */
  reviewChecklist: prepPresenceMapSchema,
});
export type PrepBrief = z.infer<typeof prepBriefSchema>;

/**
 * The single normalize-on-read choke point (D-20): coalesces all three
 * null-strip-tolerant maps to `{}`/`{}`/`{}` so every caller sees a stable,
 * always-present shape regardless of how much RTDB stripped from the stored
 * record, and maps every stored binding through `normalizeScoutBindingRecord`.
 */
export function normalizePrepBriefRecord(record: PrepBriefRecord): PrepBrief {
  const scoutBindingsRecord = record.scoutBindings ?? {};
  const scoutBindings: ScoutBindingMap = {};
  for (const [opponentName, binding] of Object.entries(scoutBindingsRecord)) {
    scoutBindings[opponentName] = normalizeScoutBindingRecord(binding);
  }
  return {
    eventDate: record.eventDate,
    activatedAt: record.activatedAt,
    lastOpenedAt: record.lastOpenedAt,
    checklist: record.checklist ?? {},
    likelyOpponents: record.likelyOpponents ?? {},
    scoutBindings,
    reviewChecklist: record.reviewChecklist ?? {},
    ...(record.reviewAt != null ? { reviewAt: record.reviewAt } : {}),
    ...(record.reviewCompletedAt != null ? { reviewCompletedAt: record.reviewCompletedAt } : {}),
  };
}

/**
 * GET /api/prep/:entryKey response (D-12) — a pure read, no writes.
 * `.optional()` is correct here (unlike the stored-read shape above)
 * because this is a RESPONSE schema: `brief` is genuinely absent when the
 * player has never activated a prep brief for this entry.
 *
 * `paidReportsAvailable` (Phase 27, RPT-04) is OPTIONAL for deploy-order
 * compatibility: new servers always return it, but a client deployed before
 * an API rollback must not break parsing this response when it's absent.
 * Clients must treat only a strict `true` as enabling the paid surface —
 * `undefined` and `false` are both "not available".
 */
export const prepBriefStatusSchema = z.object({
  activated: z.boolean(),
  brief: prepBriefSchema.optional(),
  paidReportsAvailable: z.boolean().optional(),
  /**
   * Phase 28 (REV-01): the EFFECTIVE conversion moment the client renders
   * mode from — the frozen `brief.reviewAt` when present, otherwise the
   * server-derived candidate (28-04's GET handler computes this from the
   * registry row when no frozen value exists yet). Optional for deploy-order
   * compatibility (mirrors `paidReportsAvailable`'s rationale above): an old
   * client deployed before this field ships must not break parsing this
   * response when it's absent. The client must never re-derive review mode
   * from raw entry dates itself (UI-SPEC mode-source rule) — this field (or
   * its absence) is the sole authoritative input.
   */
  reviewAt: z.number().int().nonnegative().optional(),
});
export type PrepBriefStatus = z.infer<typeof prepBriefStatusSchema>;

/**
 * POST /api/prep/:entryKey/activate response. `justActivated` means "this
 * call performed the one-and-only create" — deliberately a different field
 * name from `activated` (prepBriefStatusSchema) so the two can never be
 * conflated: a reopen of an already-activated brief returns
 * `justActivated: false` with the existing brief.
 */
export const prepActivateResponseSchema = z.object({
  justActivated: z.boolean(),
  brief: prepBriefSchema,
});
export type PrepActivateResponse = z.infer<typeof prepActivateResponseSchema>;

/** Response for open, checklist toggle, and opponent add/remove. */
export const prepBriefResponseSchema = z.object({
  brief: prepBriefSchema,
});
export type PrepBriefResponse = z.infer<typeof prepBriefResponseSchema>;

/**
 * POST /api/prep/:entryKey/open body (D-08) — a stable, client-generated
 * open ID per logical page mount, so transport-level retries of one open
 * collapse to a single `prep_brief_reopened` event.
 */
export const prepOpenRequestSchema = z.object({
  openId: z.string().min(1).max(64),
});
export type PrepOpenRequest = z.infer<typeof prepOpenRequestSchema>;

/** PATCH checklist-item body. */
export const prepChecklistItemUpdateSchema = z.object({
  checked: z.boolean(),
});
export type PrepChecklistItemUpdate = z.infer<typeof prepChecklistItemUpdateSchema>;

/** Phase 28: one day in epoch ms — the manual-entry `reviewAt` offset (see `deriveReviewAtCandidate`). */
export const DAY_MS = 86_400_000;

/**
 * Phase 28 (REV-01, the owner's corrected conversion trigger, 28-CONTEXT.md
 * "Conversion mechanics"):
 *
 * (a) The owner REJECTED `prepBrief.eventDate < now` as the conversion
 *     trigger — verbatim: "That field comes from `firstSetAt`, and manually
 *     entered events can resolve to the beginning of the selected day. The
 *     page could therefore become a 'post-event' review when the tournament
 *     is only starting." This function is the locked replacement.
 * (b) Synced entries (`source` is `'startgg'`/`'parrygg'`, or absent —
 *     legacy startgg rows) convert on `lastSetAt` EXACTLY — the owner's
 *     literal words, "convert immediately, no grace period". Manual entries
 *     (`source === 'manual'`, always explicit, never left absent — see
 *     `tournamentEntrySchema`'s doc comment in `startgg.ts`) convert on the
 *     next local-day boundary, approximated server-side (the server has no
 *     stored timezone) as `lastSetAt + DAY_MS`; RESEARCH A1 accepts up to
 *     ±1h of DST drift against the player's true local midnight as
 *     negligible against the start-of-day-vs-end-of-day bug this replaces.
 * (c) `source` absence means startgg (every entry stored before the field
 *     existed) — ONLY the literal string `'manual'` takes the `+DAY_MS`
 *     branch; every other value (including absence) takes the exact-
 *     `lastSetAt` branch.
 * (d) The degenerate `lastSetAt: 0` start.gg case (`startgg/sync.ts:260`
 *     initializes `lastSetAt: completedAt ?? 0` for a set with no
 *     `completedAt`) falls back to `firstSetAt` — accepted and tested; if
 *     `firstSetAt` is ALSO `0`, the entry converts immediately (accepted,
 *     documented, RESEARCH Pitfall 1).
 *
 * Pure function of stored registry fields only (T-28-01: no client-supplied
 * timestamp parameter exists, so a crafted request can never choose the
 * conversion moment). The caller (28-04's freeze mutation and GET candidate
 * derivation) is solely responsible for comparing the result against `now`
 * and for the write-once freeze that makes conversion one-way.
 */
export function deriveReviewAtCandidate(
  entry: Pick<TournamentEntry, 'source' | 'firstSetAt' | 'lastSetAt'>,
): number {
  const base = entry.lastSetAt > 0 ? entry.lastSetAt : entry.firstSetAt;
  return entry.source === 'manual' ? base + DAY_MS : base;
}

/**
 * One candidate identity offered for a curated opponent's scout binding
 * confirmation (27-CONTEXT.md "Resolution flow") — gathered server-side
 * from alias-resolved stored matches, never client-supplied. `matchCount`
 * is the evidence strength shown to the player; the player still makes an
 * explicit choice among multiple distinct candidates (never auto-picked by
 * frequency or recency).
 */
export const prepScoutBindingCandidateSchema = z.object({
  provider: scoutBindingProviderSchema,
  startggPlayerId: z.number().int().positive().optional(),
  startggUserSlug: z.string().min(1).optional(),
  parryUserId: z.string().min(1).optional(),
  displayTag: z.string().min(1),
  /** Number of stored matches this candidate identity was derived from. */
  matchCount: z.number().int().nonnegative(),
});
export type PrepScoutBindingCandidate = z.infer<typeof prepScoutBindingCandidateSchema>;

/** GET candidates response for one curated opponent's binding confirmation flow. */
export const prepScoutBindingCandidatesResponseSchema = z.object({
  candidates: z.array(prepScoutBindingCandidateSchema),
});
export type PrepScoutBindingCandidatesResponse = z.infer<
  typeof prepScoutBindingCandidatesResponseSchema
>;

/**
 * POST confirm-binding request body. Carries only opaque provider QUERIES
 * (a gamer tag, slug, or pasted profile reference) — the server resolves
 * each query into a stable ID itself (start.gg GraphQL / parry.gg gRPC) and
 * persists only the resolved identity; a client-supplied ID is never
 * trusted. At least one of `startgg`/`parrygg` must be present so a
 * `combined` binding can be confirmed from either or both branches in one
 * request.
 */
export const prepScoutBindingConfirmRequestSchema = z
  .object({
    startgg: z.object({ query: z.string().min(1).max(300) }).optional(),
    parrygg: z.object({ query: z.string().min(1).max(300) }).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.startgg && !value.parrygg) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one of startgg or parrygg must be provided',
      });
    }
  });
export type PrepScoutBindingConfirmRequest = z.infer<typeof prepScoutBindingConfirmRequestSchema>;
