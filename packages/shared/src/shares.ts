import { z } from 'zod';
import { matchStageSchema } from './stage.js';
import { recapSetSchema } from './recap.js';
import { coachAttributionSchema } from './match.js';
import { MAX_REVIEW_SECTIONS, reviewSectionSchema } from './coachingReview.js';

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
 * Phase 8 (Coaching Edit Sessions): the public, edit-session variant of
 * `shareTimestampSchema` — additive `id`/`coach`/`own` fields so the coach
 * UI can tell which notes are "mine" (edit/delete affordance) and everyone
 * can see per-note attribution. All are `.nullish()`, never required: a
 * frozen VIEW-tier snapshot never populates them (this schema is only used
 * by the live-redacted EDIT-tier recompute), so `publicShareSnapshotSchema`
 * stays backward-compatible with every existing view-tier response.
 *
 * `coach` here deliberately carries the display name ONLY — never the
 * `sessionId` (review WR-02): the sessionId is the secret the per-session
 * write-ownership guard checks, so serving every coach's sessionId to every
 * edit-token holder would make that guard spoofable with data the API
 * itself hands out. Own-note detection is instead the server-computed `own`
 * flag, derived from the sessionId the REQUESTING client sends on the
 * session read — the secret never travels back out.
 */
const publicShareTimestampSchema = shareTimestampSchema.extend({
  id: z.string().nullish(),
  /** Attribution for a coach-authored note — display name only, no sessionId (WR-02). */
  coach: z.object({ displayName: coachAttributionSchema.shape.displayName }).nullish(),
  /** True when the requesting session authored this note (server-computed). */
  own: z.boolean().nullish(),
});

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
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): the
 * anonymous-facing response contract for `GET /api/vod-shares/:token` (and
 * the OG meta/image pipeline that derives from the same lookup). This is
 * the SAME author-from-scratch discipline as `shareSnapshotSchema` above
 * (a NEW `z.object` literal, NOT `.omit()`/`.pick()`'d from it or from
 * `matchRecordSchema`) — every field is `uid`/`matchId`-free BY SHAPE, so a
 * future accidental leak of either becomes a Fastify response-serialization
 * error (via `fastify-type-provider-zod`'s `response[200]` schema), not a
 * silent logic bug. Must never be derived from `matchRecordSchema` either.
 *
 * Phase 7 (Recap Cards & Share-Loop Analytics): extended to a FLAT dual
 * shape carrying both a vod-review AND a recap public snapshot, gated by
 * `kind` — modeled on `startgg.ts`'s `scoutPlayerIdentitySchema` precedent
 * (one flat `z.object` + `.refine()`s), deliberately avoiding a Zod
 * discriminated-union helper (see RESEARCH.md Pitfall 4: an untested
 * combination with Fastify's response serializer). `kind` absent/undefined
 * means a vod-review snapshot — every pre-Phase-7 record, and every review
 * share created going forward, since `RtdbService`'s review branch never
 * sets it.
 *
 * Phase 8 (Coaching Edit Sessions): extended additively for the edit-session
 * live-recompute response — `permissions` (top-level tier) and per-review-
 * timestamp `id`/`coach` (via `publicShareTimestampSchema`). All new fields
 * are nullish so the frozen VIEW-tier response (which never populates them)
 * still validates unchanged; only the live EDIT-tier recompute (a later
 * 08-0x plan) ever sets them.
 *
 * Phase 12 (Coach Reviews & Delivery, DLV-02): extended additively a third
 * way for `kind: 'coachReview'` — the anonymous no-account delivery page's
 * response. New fields are nullish (absent on every pre-Phase-12 vod-review
 * or recap snapshot) and gated by the third `.refine()` below, exactly like
 * the recap branch's `tournamentName`/`placement` fields were added.
 */
export const publicShareSnapshotSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    /** Absent means a vod-review snapshot (the default, backward-compatible shape). */
    kind: z.enum(['recap', 'coachReview']).nullish(),
    /** Phase 8: the share's permission tier. Absent on pre-Phase-8 responses (treated as 'view'). */
    permissions: z.enum(['view', 'edit']).nullish(),
    // --- vod-review fields: nullish here (absent on a recap snapshot); the
    // first `.refine()` below enforces they're all present for a review one ---
    result: z.enum(['win', 'loss']).nullish(),
    fighterId: z.number().int().positive().nullish(),
    opponentFighterId: z.number().int().positive().nullish(),
    stage: matchStageSchema.nullish(),
    matchDate: z.number().int().nonnegative().nullish(),
    vodUrl: z.string().url().nullish(),
    vodStartSeconds: z.number().int().nonnegative().nullish(),
    timestamps: z.array(publicShareTimestampSchema).max(20).nullish(),
    tags: z.array(z.string().trim().min(1).max(24)).max(10).nullish(),
    redaction: z
      .object({
        includedNotes: z.boolean(),
        includedTags: z.boolean(),
        showDisplayName: z.boolean(),
      })
      .nullish(),
    // --- recap-only fields: nullish here (absent on a vod-review snapshot);
    // the second `.refine()` below enforces the required subset for a recap ---
    recapSource: z.enum(['startgg', 'parrygg']).nullish(),
    tournamentName: z.string().min(1).nullish(),
    tournamentDate: z.number().int().nonnegative().nullish(),
    placement: z.number().int().positive().nullish(),
    seed: z.number().int().positive().nullish(),
    numEntrants: z.number().int().positive().nullish(),
    setRecordWins: z.number().int().nonnegative().nullish(),
    setRecordLosses: z.number().int().nonnegative().nullish(),
    notableWinOpponentName: z.string().min(1).nullish(),
    notableWinOpponentSeed: z.number().int().positive().nullish(),
    characterFighterIds: z.array(z.number().int().positive()).nullish(),
    /**
     * Walkthrough amendment (07-09): which generation mode produced this
     * recap. Absent means `'summary'` (every pre-07-09 recap, and every
     * summary-mode generation going forward) — mirrors `kind`'s own
     * absent-means-review convention. Meaningless (and absent) on a
     * vod-review snapshot.
     */
    detail: z.enum(['summary', 'full']).nullish(),
    /** External event page on the source site — see `recapSnapshotSchema.tournamentUrl`'s doc for the derivation rule. Absent when not trustworthily derivable. */
    tournamentUrl: z.string().url().nullish(),
    /** The full set timeline — present only when `detail === 'full'`. See `recapSnapshotSchema.sets`. */
    sets: z.array(recapSetSchema).max(20).nullish(),
    // --- coachReview-only fields (Phase 12, DLV-02): nullish here (absent on
    // a vod-review or recap snapshot); the third `.refine()` below enforces
    // the required subset for a coachReview delivery ---
    /** The delivering coach's display name — shown on the no-account delivery page. */
    coachDisplayName: z.string().trim().max(60).nullish(),
    /** Epoch ms the pinned version was published — "publication date" on the delivery page. */
    reviewPublishedAt: z.number().int().nonnegative().nullish(),
    /**
     * Plan 04 addition (Rule 2 — missing critical functionality): the
     * pinned version's own document body — the SAME shape
     * `clientVisibleVersionSchema.sections` already carries (hidden
     * sections structurally excluded, no `coachPrivateNotes` field to leak
     * — REV-03). Without this the delivery snapshot would have coach
     * identity/pub-date/sources but literally nothing for the recipient
     * page (12-08) to render below the player — the phase's own D-08/DLV-02
     * "sections below" requirement would be unimplementable. Nullish here
     * (absent on a vod-review/recap snapshot) and REQUIRED for `'coachReview'`
     * by the third `.refine()` below, mirroring every other coachReview-only
     * field's gating.
     */
    sections: z
      .array(reviewSectionSchema.omit({ hidden: true }))
      .max(MAX_REVIEW_SECTIONS)
      .nullish(),
    /**
     * Every distinct source VOD a citation in the delivered version's body
     * refers to (D-04 multi-VOD first-class) — lets the delivery page
     * re-key `useVodPlayer` and seek when a citation from a different
     * source is clicked, without a second fetch.
     */
    citationSources: z
      .array(
        z.object({
          sourceVodRef: z.string().min(1),
          vodUrl: z.string().url(),
          label: z.string().trim().max(120).nullish(),
        }),
      )
      .max(20)
      .nullish(),
    // --- shared across both kinds ---
    reviewedMomentsCount: z.number().int().nonnegative(),
    ownerDisplayName: z.string().trim().max(60).nullish(),
  })
  .refine(
    (snapshot) =>
      snapshot.kind !== 'recap' && snapshot.kind !== 'coachReview'
        ? Boolean(snapshot.vodUrl) && Boolean(snapshot.redaction)
        : true,
    {
      message: 'a vod-review snapshot must carry vodUrl and redaction',
      path: ['vodUrl'],
    },
  )
  .refine(
    (snapshot) =>
      snapshot.kind === 'recap'
        ? Boolean(snapshot.tournamentName) &&
          snapshot.tournamentDate != null &&
          snapshot.setRecordWins != null &&
          snapshot.setRecordLosses != null &&
          snapshot.characterFighterIds != null
        : true,
    {
      message:
        'a recap snapshot must carry tournamentName, tournamentDate, set record, and characterFighterIds',
      path: ['tournamentName'],
    },
  )
  .refine(
    (snapshot) =>
      snapshot.kind === 'coachReview'
        ? Boolean(snapshot.coachDisplayName) &&
          snapshot.reviewPublishedAt != null &&
          snapshot.sections != null
        : true,
    {
      message:
        'a coachReview snapshot must carry coachDisplayName, reviewPublishedAt, and sections',
      path: ['coachDisplayName'],
    },
  );
export type PublicShareSnapshot = z.infer<typeof publicShareSnapshotSchema>;

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
  /**
   * Phase 8 (Coaching Edit Sessions): epoch ms after which this token stops
   * working — set ONLY for edit-tier tokens (coaching links default-expire
   * after 30 days; view-tier tokens stay indefinite-until-revoked and never
   * get this field). An elapsed `expiresAt` is treated identically to
   * `revokedAt`: same identical-404/unavailable semantics, re-checked on
   * every read AND write, never cached.
   */
  expiresAt: z.number().int().nonnegative().nullish(),
});
export type ShareToken = z.infer<typeof shareTokenSchema>;

/**
 * POST /api/vod-shares body. Kind-discriminated (Phase 7): `kind` defaults
 * to `'review'` for backward compatibility with every pre-Phase-7 client,
 * which never sends this field at all. `matchId`/`redaction` are required
 * for a review share; `entryKey` is required for a recap share — enforced
 * by the `.refine()`s below (a single Zod object can't make a field
 * required only for one branch via its own optionality alone).
 *
 * Phase 12 (Coach Reviews & Delivery, DLV-01): a THIRD kind, `'coachReview'`,
 * reuses this same bearer-token/revocation pipeline for delivering a coach's
 * PUBLISHED review document to a client. Naming collision, documented
 * explicitly (RESEARCH.md Open Question 1): `kind: 'review'` here ALREADY
 * means "a vod-review share" (a match's timestamped-note review, Phase 5/6)
 * — a completely different concept from a coach-authored review document.
 * `'coachReview'` is a deliberately NON-colliding new literal; the existing
 * `'review'` literal's meaning is never renamed or repurposed (mirrors
 * `apps/api/src/coaching/subject.ts`'s own documented naming-collision
 * precedent for an unrelated "coach" term).
 */
export const createShareInputSchema = z
  .object({
    /** Discriminates which snapshot builder handles this create. Absent means 'review' (every pre-Phase-7 client). */
    kind: z.enum(['review', 'recap', 'coachReview']).default('review'),
    /** Required for kind 'review'. */
    matchId: z.string().min(1).optional(),
    /** Required for kind 'review'. */
    redaction: z
      .object({
        includeNotes: z.boolean(),
        includeTags: z.boolean(),
        showDisplayName: z.boolean(),
      })
      .optional(),
    /** Meaningful when `redaction.showDisplayName` is true (review) or always for a recap (identity default ON — see 07-CONTEXT.md). */
    ownerDisplayName: z.string().trim().max(60).optional(),
    /** Required for kind 'recap' — the caller's own `tournamentEntries/{uid}/{entryKey}` routing key. Bounded: real keys are `String(eventId)` or `pgg-{slug}`; the RTDB-safety charset itself is enforced server-side (rtdb.ts's ENTRY_KEY_SHAPE, review WR-01). */
    entryKey: z.string().min(1).max(200).optional(),
    /**
     * Walkthrough amendment (07-09): meaningful only for kind 'recap' —
     * whether the recap is generated with the full set-by-set timeline
     * (`'full'`) or just the top-line stats (`'summary'`). Deliberately
     * OPTIONAL rather than `.default()` (matching `matchId`/`redaction`/
     * `entryKey`'s own per-kind-conditional-optional convention above,
     * rather than `kind`'s own always-required-with-default convention) so
     * every existing 'review' caller (which never sends this field) keeps
     * compiling with no changes. `RtdbService.createShare` treats an absent
     * value as `'full'` (the new default recommended by 07-CONTEXT.md's
     * Walkthrough Amendment) before calling `buildRecapSnapshot`.
     */
    detail: z.enum(['summary', 'full']).optional(),
    /**
     * Phase 8 (Coaching Edit Sessions): the share's permission tier the
     * owner chooses at create time. Defaults to `'view'` so every
     * pre-Phase-8 caller (which never sends this field) keeps compiling
     * with unchanged behavior. `'edit'` is blocked for `kind: 'recap'` by
     * the `.refine()` below — a recap has no single match for a coach to
     * attach notes to.
     */
    permissions: z.enum(['view', 'edit']).default('view'),
    /** Required for kind 'coachReview' — the review document this delivery pins (DLV-01: exactly ONE published version). */
    reviewId: z.string().min(1).optional(),
    /** Required for kind 'coachReview' — the immutable published version number this delivery pins to. */
    version: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      input.kind === 'review' ? Boolean(input.matchId) && Boolean(input.redaction) : true,
    {
      message: 'review shares require matchId and redaction',
      path: ['matchId'],
    },
  )
  .refine((input) => (input.kind === 'recap' ? Boolean(input.entryKey) : true), {
    message: 'recap shares require entryKey',
    path: ['entryKey'],
  })
  .refine(
    (input) =>
      input.kind === 'coachReview' ? Boolean(input.reviewId) && Boolean(input.version) : true,
    {
      message: 'coachReview shares require reviewId and version',
      path: ['reviewId'],
    },
  )
  .refine((input) => !(input.kind === 'recap' && input.permissions === 'edit'), {
    message: 'coaching (edit-permission) shares apply to VOD reviews only, not recaps',
    path: ['permissions'],
  });
export type CreateShareInput = z.infer<typeof createShareInputSchema>;

/**
 * GET /api/vod-shares list-row response shape — everything the owner's "My
 * shares" manage list needs to render a row (chips, badges, copy/revoke
 * actions) without re-deriving them from the snapshot (SHARE-05).
 *
 * Phase 7: extended to a flat dual shape (same `kind`-gated + `.refine()`
 * discipline as `publicShareSnapshotSchema` above) so a recap row can be
 * represented alongside a vod-review row in the same list response.
 *
 * Phase 12 (Coach Reviews & Delivery): `kind` gains the same third
 * `'coachReview'` literal as the other two schemas above; no new display
 * fields are added here (the delivery page's coach-identity/pub-date/
 * citation-sources fields live on `publicShareSnapshotSchema`, not this
 * owner-facing list row).
 */
export const shareSummarySchema = z
  .object({
    shareId: z.string(),
    /** Absent for a recap row (no source match). */
    matchId: z.string().nullish(),
    permissions: z.enum(['view', 'edit']),
    /** The snapshot date — when this share was created. */
    createdAt: z.number().int().nonnegative(),
    /** Absent means a vod-review row (the default, backward-compatible shape). */
    kind: z.enum(['recap', 'coachReview']).nullish(),
    redaction: z
      .object({
        includedNotes: z.boolean(),
        includedTags: z.boolean(),
        showDisplayName: z.boolean(),
      })
      .nullish(),
    /**
     * Phase 8 walkthrough fix (review WR-05): `'expired'` — an edit-tier
     * share whose `expiresAt` has elapsed. Dead for every coach/anonymous
     * path (identical to revoked there), surfaced distinctly here so the
     * manage list can label it instead of rendering a working Copy button
     * for a dead link. Expired shares do NOT count toward the active cap.
     */
    status: z.enum(['active', 'revoked', 'expired']),
    revokedAt: z.number().int().nonnegative().nullish(),
    url: z.string().url(),
    // Small display facts the row renders without a second fetch.
    result: z.enum(['win', 'loss']).nullish(),
    fighterId: z.number().int().positive().nullish(),
    opponentFighterId: z.number().int().positive().nullish(),
    stage: matchStageSchema.nullish(),
    // --- recap display fields ---
    tournamentName: z.string().min(1).nullish(),
    placement: z.number().int().positive().nullish(),
  })
  .refine(
    (row) =>
      row.kind !== 'recap' && row.kind !== 'coachReview'
        ? Boolean(row.matchId) && Boolean(row.redaction)
        : true,
    {
      message: 'a vod-review row must carry matchId and redaction',
      path: ['matchId'],
    },
  )
  .refine((row) => (row.kind === 'recap' ? Boolean(row.tournamentName) : true), {
    message: 'a recap row must carry tournamentName',
    path: ['tournamentName'],
  });
export type ShareSummary = z.infer<typeof shareSummarySchema>;

/** POST /api/vod-shares 201 response — the create result the web copy-step reads. */
export const shareCreatedResponseSchema = z.object({
  shareId: z.string(),
  token: z.string(),
  url: z.string().url(),
});
export type ShareCreatedResponse = z.infer<typeof shareCreatedResponseSchema>;

/**
 * Walkthrough amendment (FB-03, My Shares management overhaul): request/
 * response shapes for `POST /api/vod-shares/bulk` — batch revoke or delete
 * up to `MAX_SHARES_PER_USER` shares in one round-trip. These are wire
 * contracts only (never persisted to RTDB), so the module doc's
 * conditional-spread + `.nullish()` null-stripping rule does not apply
 * here — do not reflexively add `.nullish()` to these fields.
 */
export const bulkShareActionSchema = z.enum(['revoke', 'delete']);
export type BulkShareAction = z.infer<typeof bulkShareActionSchema>;

export const bulkShareRequestSchema = z.object({
  action: bulkShareActionSchema,
  shareIds: z.array(z.string().min(1)).min(1).max(MAX_SHARES_PER_USER),
});
export type BulkShareRequest = z.infer<typeof bulkShareRequestSchema>;

export const bulkShareResponseSchema = z.object({
  processed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type BulkShareResponse = z.infer<typeof bulkShareResponseSchema>;
