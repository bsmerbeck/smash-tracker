import { z } from 'zod';

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
});
export type PrepBriefRecord = z.infer<typeof prepBriefRecordSchema>;

/**
 * The NORMALIZED shape handed to every caller after `normalizePrepBriefRecord`
 * — `checklist`/`likelyOpponents` are always present (never absent/null),
 * so downstream code (API responses, web rendering) never re-derives the
 * null-strip tolerance itself.
 */
export const prepBriefSchema = z.object({
  eventDate: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative(),
  lastOpenedAt: z.number().int().nonnegative(),
  checklist: prepPresenceMapSchema,
  likelyOpponents: prepPresenceMapSchema,
});
export type PrepBrief = z.infer<typeof prepBriefSchema>;

/**
 * The single normalize-on-read choke point (D-20): coalesces both
 * null-strip-tolerant maps to `{}` so every caller sees a stable, always-
 * present shape regardless of how much RTDB stripped from the stored record.
 */
export function normalizePrepBriefRecord(record: PrepBriefRecord): PrepBrief {
  return {
    eventDate: record.eventDate,
    activatedAt: record.activatedAt,
    lastOpenedAt: record.lastOpenedAt,
    checklist: record.checklist ?? {},
    likelyOpponents: record.likelyOpponents ?? {},
  };
}

/**
 * GET /api/prep/:entryKey response (D-12) — a pure read, no writes.
 * `.optional()` is correct here (unlike the stored-read shape above)
 * because this is a RESPONSE schema: `brief` is genuinely absent when the
 * player has never activated a prep brief for this entry.
 */
export const prepBriefStatusSchema = z.object({
  activated: z.boolean(),
  brief: prepBriefSchema.optional(),
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
