import { z } from 'zod';
import { SAFE_MARKDOWN_DOC_MAX_LENGTH } from './coachingReview.js';

/**
 * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02): the training-session data model — a per-client dated log
 * with character tags, a free-text summary, and a flat homework checklist.
 *
 * A session is a MUTABLE LOG (V22-TRAINING-SESSION-RESEARCH Pattern 1), NOT
 * a review with a discriminator: exactly ONE live record per session,
 * edited in place via a partial patch. There is deliberately NO version/
 * publish/seal machinery here — that's `coachingReview.ts`'s concern for a
 * different kind of document. Delivery (Phase 20 Plan 03) freezes a
 * point-in-time SNAPSHOT of the client-visible shape at delivery-creation
 * time; the live session keeps mutating underneath that snapshot
 * unaffected.
 *
 * `homework` is capped at 20 items, mirroring the `vodTimestamps.max(20)`
 * precedent (`match.ts`) so a single session's checklist stays skimmable —
 * the same rationale, applied to a different list shape.
 *
 * `clientVisibleSessionSchema` is authored FROM SCRATCH below — deliberately
 * NOT derived via `.omit()`/`.pick()` from `trainingSessionSchema` — for the
 * exact same reason `clientVisibleVersionSchema` is in `coachingReview.ts`
 * (REV-03 discipline): a derived schema silently re-admits
 * `coachPrivateNotes` the moment someone innocently changes which fields are
 * omitted. Structurally having no field for it at all means a leak is a
 * TypeScript compile error at the call site, not a runtime logic bug.
 *
 * Every nullable field uses `.nullish()` (never bare `.optional()`), per
 * CONCERNS.md's RTDB null-stripping rule. `characterTags`/`homework` are
 * plain (non-nullish) arrays that may legitimately be empty — mirroring
 * `reviewDraftSchema.sections`'s convention, where RTDB drops the key
 * entirely on a write of `[]` and the read path is responsible for
 * normalizing a missing key back to `[]` before validating (see
 * `apps/api/src/coaching/sessions.ts`'s `parseSessionRecord`, the same
 * discipline `reviews.ts`'s `parseDraftRecord` already established).
 */

/** Max characters a session's summary or coach-private-notes field may hold — the same safe-Markdown-subset cap `coachingReview.ts` uses. */
const safeMarkdownDocSchema = z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH);

/** Max character (fighter) tags a single session may carry. */
export const MAX_SESSION_CHARACTER_TAGS = 10;

/** Max homework items a single session's checklist may carry — mirrors `vodTimestamps.max(20)` (`match.ts`). */
export const MAX_SESSION_HOMEWORK_ITEMS = 20;

/** Max characters a single homework item's text may hold. */
export const HOMEWORK_ITEM_TEXT_MAX_LENGTH = 200;

/** Max linked client VOD/match references a single session may carry. */
export const MAX_SESSION_LINKED_MATCH_IDS = 20;

/**
 * A single flat homework checklist item — coach-authored text plus a
 * toggleable done-state. `id` is stable across edits (assigned at creation,
 * see `sessions.ts`'s `createSession`) so `toggleHomeworkItem` can address
 * one item without reordering/renumbering the array.
 */
export const homeworkItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().max(HOMEWORK_ITEM_TEXT_MAX_LENGTH),
  done: z.boolean(),
});
export type HomeworkItem = z.infer<typeof homeworkItemSchema>;

/**
 * `trainingSessions/{tenantId}/{sessionId}` — the ONE stored node for a
 * session (mutable log, Pattern 1: no sibling draft/version/status trees).
 * `coachPrivateNotes` lives on this SAME node (mirrors `reviewDraftSchema`'s
 * documented deviation for the same reason: the coach's own composer needs
 * both in one fetch; the actual REV-03-equivalent danger — response-shape
 * leakage to a client role — is closed by `clientVisibleSessionSchema`
 * below having no field for it at all).
 */
export const trainingSessionSchema = z.object({
  /** Unix epoch milliseconds — the date this training session covers. */
  date: z.number().int().nonnegative(),
  /** 0..n SpriteList fighter ids this session's notes are tagged with. */
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS),
  /** Free-text synthesis of the session, same safe-Markdown-subset constraints as a review section body. */
  summary: safeMarkdownDocSchema,
  /** Flat, per-session homework checklist — items + toggleable done-states. */
  homework: z.array(homeworkItemSchema).max(MAX_SESSION_HOMEWORK_ITEMS),
  /** 0..n linked client VOD/match ids this session references. `.nullish()`: absent means "no linked VODs" — a valid, meaningful state. */
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullish(),
  /** Coach-only notes, structurally absent from `clientVisibleSessionSchema` below (REV-03-equivalent discipline). `.nullish()`: absent means "no private notes yet." */
  coachPrivateNotes: safeMarkdownDocSchema.nullish(),
  createdAt: z.number().int().nonnegative(),
  lastEditedAt: z.number().int().nonnegative(),
});
export type TrainingSession = z.infer<typeof trainingSessionSchema>;

/**
 * The client-visible shape of a session — authored FROM SCRATCH (see module
 * doc, REV-03-equivalent discipline). Structurally has NO `coachPrivateNotes`
 * field, and homework items are stripped down to `{ text, done }` only (no
 * internal `id`, which the client never needs to address). Used by the
 * delivery snapshot (Phase 20 Plan 03) — never derived from
 * `trainingSessionSchema` via `.omit()`/`.pick()`.
 */
export const clientVisibleSessionSchema = z.object({
  date: z.number().int().nonnegative(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS),
  summary: safeMarkdownDocSchema,
  homework: z
    .array(
      z.object({
        text: z.string().trim().max(HOMEWORK_ITEM_TEXT_MAX_LENGTH),
        done: z.boolean(),
      }),
    )
    .max(MAX_SESSION_HOMEWORK_ITEMS),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullish(),
});
export type ClientVisibleSession = z.infer<typeof clientVisibleSessionSchema>;

/**
 * PATCH body for an in-place session edit (mutable log — no
 * `expectedRevision`/optimistic-concurrency machinery, unlike
 * `createDraftPatchInputSchema`: a session has no sibling autosave/publish
 * lifecycle to protect against). Every field is optional/nullish — a
 * partial patch only touches the fields it includes; `updateSession`
 * (`sessions.ts`) merges over the existing record and always stamps
 * `lastEditedAt`.
 */
export const sessionPatchInputSchema = z.object({
  date: z.number().int().nonnegative().optional(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS).optional(),
  summary: safeMarkdownDocSchema.optional(),
  homework: z.array(homeworkItemSchema).max(MAX_SESSION_HOMEWORK_ITEMS).optional(),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullish(),
  coachPrivateNotes: safeMarkdownDocSchema.nullish(),
});
export type SessionPatchInput = z.infer<typeof sessionPatchInputSchema>;
