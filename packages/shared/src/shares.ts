import { z } from 'zod';
import { matchStageSchema } from './stage.js';

/**
 * Phase 5 (Share Foundation & Owner Controls): privacy-controlled, revocable
 * VOD share links. Two RTDB subtrees, deliberately indirected:
 *
 * - `shareSnapshots/{shareId}` — an immutable, redacted COPY of the source
 *   match taken at share-creation time (see `buildShareSnapshot.ts`). Never
 *   re-read live: editing the source match afterward never changes an
 *   issued link (SHARE-01). Authored from scratch — NOT derived via
 *   `.pick()`/`.omit()` from `matchRecordSchema` — so redaction is enforced
 *   by response SHAPE: there is no field here for opponent notes, the human
 *   opponent name, or playlist membership. A leak of those would be a type
 *   error, not a logic bug (SHARE-02).
 * - `shareTokens/{token}` — the public bearer-credential lookup record
 *   (`token` is the RTDB key here, NOT the same value as `shareId`). This
 *   indirection lets a future token rotation (Phase 8) swap the bearer
 *   credential without re-copying the snapshot. Permission-aware from day
 *   one (`permissions: 'view' | 'edit'` + reserved `requiresAuth`) so Phase
 *   8 coaching sessions attach without a migration — this phase only ever
 *   writes `permissions: 'view'` and leaves `requiresAuth` absent.
 * - `sharesByUser/{uid}/{shareId}: token` — the owner index, storing the
 *   ISSUED TOKEN (not a bare `true` set-membership marker like most other
 *   per-user subtrees in this codebase, e.g. `opponents/{uid}/{opponentName}`)
 *   so it doubles as the shareId->token lookup `listSharesForUser`/
 *   `revokeShare` need without a second global-scope index.
 *
 * Every optional field on both stored schemas uses `.nullish()` (never bare
 * `.optional()`), and every write uses the conditional-spread idiom, per
 * CONCERNS.md's RTDB null-stripping rule: RTDB rejects `undefined` on write
 * but silently drops keys holding `null`/`[]`, so a well-intentioned
 * `timestamps: null` for "notes excluded" round-trips indistinguishably from
 * "key never existed" — picking "field absent" as the sole representation
 * for "excluded" avoids that trap entirely (see `buildShareSnapshot.ts`).
 */

/** Max shares a single user may have active (soft-revoked shares still count toward history, not this cap). */
export const MAX_SHARES_PER_USER = 100;

/** A single redacted VOD timestamp note as copied into a share snapshot. */
const shareTimestampSchema = z.object({
  /** Offset in whole seconds into the VOD this note refers to. */
  seconds: z.number().int().min(0),
  note: z.string().trim().max(200),
  /** Omitted (not `[]`) when the source note had no tags. */
  tags: z.array(z.string().trim().min(1).max(24)).max(5).nullish(),
});
export type ShareTimestamp = z.infer<typeof shareTimestampSchema>;

/**
 * `shareSnapshots/{shareId}` — a redacted COPY of a match, taken once at
 * share-creation time. Match facts (`result`, `fighterId`,
 * `opponentFighterId`, `stage`, `matchDate`, the VOD reference) are ALWAYS
 * present; `timestamps`/`tags`/`ownerDisplayName` are gated by the owner's
 * chosen redaction toggles at share time. `reviewedMomentsCount` is an
 * always-present AGGREGATE (the count of the source match's
 * `vodTimestamps` at share time) that survives even when individual notes
 * are redacted — a safe summary number the Phase 6 OG image pipeline can
 * render without ever needing this schema reshaped.
 *
 * Deliberately ABSENT from this schema: opponent notes, the human opponent
 * name, and playlist membership — these are never copied here, by
 * construction, not merely by a toggle defaulting off.
 */
export const shareSnapshotSchema = z.object({
  /** Owner uid — never surfaced in any future public-facing response type. */
  uid: z.string(),
  /** Source match id — private lifecycle reference only. */
  matchId: z.string(),
  /** Epoch ms the share was created — server-stamped. */
  createdAt: z.number().int().nonnegative(),
  // --- match facts: ALWAYS present, never toggled ---
  result: z.enum(['win', 'loss']),
  fighterId: z.number().int().positive(),
  opponentFighterId: z.number().int().positive(),
  stage: matchStageSchema.nullish(),
  /** The original match's `time` (epoch ms), for display. */
  matchDate: z.number().int().nonnegative(),
  // --- VOD reference: always present (a match with no VOD isn't shareable) ---
  vodUrl: z.string().url(),
  vodStartSeconds: z.number().int().nonnegative().nullish(),
  /**
   * Count of the source match's `vodTimestamps` at share time — an
   * aggregate that survives redaction (present even when `includedNotes`
   * is false). Lets Phase 6's OG pipeline render "N reviewed moments"
   * without depending on the individual `timestamps` toggle.
   */
  reviewedMomentsCount: z.number().int().nonnegative(),
  // --- toggle-gated content: key OMITTED (never null/[]) when excluded ---
  timestamps: z.array(shareTimestampSchema).max(20).nullish(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).nullish(),
  /** Opt-in only; absent unless `redaction.showDisplayName` was chosen AND a name was provided. */
  ownerDisplayName: z.string().trim().max(60).nullish(),
  /**
   * Which toggles were chosen at share-creation time — ALWAYS written in
   * full (never itself optional), so the manage-list UI reads
   * `redaction.includedNotes` directly rather than inferring exclusion
   * from `timestamps === undefined` (an inference that would break for a
   * match that legitimately has zero notes to begin with).
   */
  redaction: z.object({
    includedNotes: z.boolean(),
    includedTags: z.boolean(),
    showDisplayName: z.boolean(),
  }),
});
export type ShareSnapshot = z.infer<typeof shareSnapshotSchema>;

/**
 * `shareTokens/{token}` — the public lookup key. `token` is the RTDB key
 * this record lives at, distinct from `shareId` (see module doc).
 * Permission-aware from day one for Phase 8 coaching forward-compat; this
 * phase only ever writes `permissions: 'view'` and leaves `requiresAuth`
 * absent.
 */
export const shareTokenSchema = z.object({
  shareId: z.string(),
  ownerUid: z.string(),
  permissions: z.enum(['view', 'edit']),
  /** Reserved for Phase 8 (coaching sessions) — always absent/null this phase. */
  requiresAuth: z.boolean().nullish(),
  createdAt: z.number().int().nonnegative(),
  /** Soft-revoke timestamp (epoch ms); absent/null means the share is active. */
  revokedAt: z.number().int().nonnegative().nullish(),
});
export type ShareToken = z.infer<typeof shareTokenSchema>;

/** POST /api/vod-shares body. */
export const createShareInputSchema = z.object({
  matchId: z.string().min(1),
  redaction: z.object({
    includeNotes: z.boolean(),
    includeTags: z.boolean(),
    showDisplayName: z.boolean(),
  }),
  /** Only meaningful when `redaction.showDisplayName` is true. */
  ownerDisplayName: z.string().trim().max(60).optional(),
});
export type CreateShareInput = z.infer<typeof createShareInputSchema>;

/**
 * GET /api/vod-shares list-row response shape — everything the owner's "My
 * shares" manage list needs to render a row (chips, badges, copy/revoke
 * actions) without re-deriving them from the snapshot (SHARE-05).
 */
export const shareSummarySchema = z.object({
  shareId: z.string(),
  matchId: z.string(),
  permissions: z.enum(['view', 'edit']),
  /** The snapshot date — when this share was created. */
  createdAt: z.number().int().nonnegative(),
  redaction: z.object({
    includedNotes: z.boolean(),
    includedTags: z.boolean(),
    showDisplayName: z.boolean(),
  }),
  status: z.enum(['active', 'revoked']),
  revokedAt: z.number().int().nonnegative().nullish(),
  url: z.string().url(),
  // Small display facts the row renders without a second fetch.
  result: z.enum(['win', 'loss']),
  fighterId: z.number().int().positive(),
  opponentFighterId: z.number().int().positive(),
  stage: matchStageSchema.nullish(),
});
export type ShareSummary = z.infer<typeof shareSummarySchema>;

/** POST /api/vod-shares 201 response — the create result the web copy-step reads. */
export const shareCreatedResponseSchema = z.object({
  shareId: z.string(),
  token: z.string(),
  url: z.string().url(),
});
export type ShareCreatedResponse = z.infer<typeof shareCreatedResponseSchema>;
