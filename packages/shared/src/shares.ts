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
 */
export const publicShareSnapshotSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    /** Absent means a vod-review snapshot (the default, backward-compatible shape). */
    kind: z.enum(['recap']).nullish(),
    // --- vod-review fields: nullish here (absent on a recap snapshot); the
    // first `.refine()` below enforces they're all present for a review one ---
    result: z.enum(['win', 'loss']).nullish(),
    fighterId: z.number().int().positive().nullish(),
    opponentFighterId: z.number().int().positive().nullish(),
    stage: matchStageSchema.nullish(),
    matchDate: z.number().int().nonnegative().nullish(),
    vodUrl: z.string().url().nullish(),
    vodStartSeconds: z.number().int().nonnegative().nullish(),
    timestamps: z.array(shareTimestampSchema).max(20).nullish(),
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
    // --- shared across both kinds ---
    reviewedMomentsCount: z.number().int().nonnegative(),
    ownerDisplayName: z.string().trim().max(60).nullish(),
  })
  .refine(
    (snapshot) =>
      snapshot.kind !== 'recap' ? Boolean(snapshot.vodUrl) && Boolean(snapshot.redaction) : true,
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
});
export type ShareToken = z.infer<typeof shareTokenSchema>;

/**
 * POST /api/vod-shares body. Kind-discriminated (Phase 7): `kind` defaults
 * to `'review'` for backward compatibility with every pre-Phase-7 client,
 * which never sends this field at all. `matchId`/`redaction` are required
 * for a review share; `entryKey` is required for a recap share — enforced
 * by the `.refine()`s below (a single Zod object can't make a field
 * required only for one branch via its own optionality alone).
 */
export const createShareInputSchema = z
  .object({
    /** Discriminates which snapshot builder handles this create. Absent means 'review' (every pre-Phase-7 client). */
    kind: z.enum(['review', 'recap']).default('review'),
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
    kind: z.enum(['recap']).nullish(),
    redaction: z
      .object({
        includedNotes: z.boolean(),
        includedTags: z.boolean(),
        showDisplayName: z.boolean(),
      })
      .nullish(),
    status: z.enum(['active', 'revoked']),
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
  .refine((row) => (row.kind !== 'recap' ? Boolean(row.matchId) && Boolean(row.redaction) : true), {
    message: 'a vod-review row must carry matchId and redaction',
    path: ['matchId'],
  })
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
