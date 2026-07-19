import { z } from 'zod';

/**
 * Phase 12 (Coach Reviews & Delivery): the coach-authored review document
 * model — a draft (the sole autosave target) that seals into an immutable
 * published version, coach-private notes, and the inline citation token
 * grammar a review's safe-Markdown-subset body embeds.
 *
 * Naming collision (documented explicitly per RESEARCH.md Open Question 1):
 * `shares.ts`'s `kind` discriminant already uses the literal `'review'` for
 * a vod-review share (Phase 5/6 — a match's timestamped-note review). This
 * module's "review" is a DIFFERENT concept: a coach's authored synthesis
 * document for a client. The share pipeline's new literal for THIS concept
 * is `'coachReview'` (see `shares.ts`), never a bare `'review'`, to avoid a
 * silent collision with the pre-existing meaning.
 *
 * `clientVisibleVersionSchema` below is authored FROM SCRATCH — deliberately
 * NOT derived via `.omit()`/`.pick()` from `reviewDraftSchema`, because a
 * derived schema silently re-admits `coachPrivateNotes` the moment someone
 * innocently changes which fields are omitted. Structurally having no field
 * for it at all (REV-03) means a leak would be a type error at the call
 * site, not a logic bug — the same discipline `shareSnapshotSchema` ->
 * `publicShareSnapshotSchema` already proves out in `shares.ts`.
 *
 * Every nullable field uses `.nullish()` (never bare `.optional()`), per
 * CONCERNS.md's RTDB null-stripping rule.
 */

/** The four suggested blocks (D-03) plus General Notes and the optional SSBU-specific adds. */
export const REVIEW_SECTION_KINDS = [
  'summary',
  'strengths',
  'priorities',
  'practicePlan',
  'general',
  'matchupNotes',
  'stageNotes',
  'drills',
  'nextGoals',
] as const;
export type ReviewSectionKind = (typeof REVIEW_SECTION_KINDS)[number];

/** Max characters a single section body or the private-notes field may hold — a raw safe-Markdown-subset string, parsed on read (REV-04). */
export const SAFE_MARKDOWN_DOC_MAX_LENGTH = 4000;
const safeMarkdownDocSchema = z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH);

/** Max sections a single draft/version may carry (4 suggested blocks + General Notes + the optional SSBU-specific adds). */
export const MAX_REVIEW_SECTIONS = 12;

/** A single section of a review document. Hidden sections (D-03) stay in the array — content preserved, never deleted. */
export const reviewSectionSchema = z.object({
  /** A fixed literal for a suggested block (e.g. 'summary'); `general-{uuid}` for an added General Notes section. */
  id: z.string().min(1),
  kind: z.enum(REVIEW_SECTION_KINDS),
  hidden: z.boolean(),
  /** Only meaningful for kind 'general' — the coach's custom section title. */
  title: z.string().trim().max(60).nullish(),
  body: safeMarkdownDocSchema,
});
export type ReviewSection = z.infer<typeof reviewSectionSchema>;

/**
 * `reviewDrafts/{tenantId}/{reviewId}` — the ONLY node autosave ever
 * writes. `coachPrivateNotes` lives on this SAME node (a deliberate,
 * documented deviation from "maximally separate storage" — see
 * RESEARCH.md Pattern 2 — justified because the coach's own composer needs
 * both in one fetch; the actual REV-03 danger, response-shape leakage to a
 * client/anonymous role, is closed by `clientVisibleVersionSchema` below
 * having no field for it at all).
 */
export const reviewDraftSchema = z.object({
  revision: z.number().int().nonnegative(),
  sections: z.array(reviewSectionSchema).max(MAX_REVIEW_SECTIONS),
  coachPrivateNotes: safeMarkdownDocSchema.nullish(),
  lastAutosavedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

/**
 * `reviewVersions/{tenantId}/{reviewId}/{version}` — write-once, immutable
 * (REV-06/REV-07). Authored from scratch (see module doc) — structurally
 * has NO `coachPrivateNotes` field. Hidden sections are excluded entirely
 * (not just flagged) since `hidden` itself is omitted from the per-section
 * shape here.
 */
export const clientVisibleVersionSchema = z.object({
  sections: z.array(reviewSectionSchema.omit({ hidden: true })).max(MAX_REVIEW_SECTIONS),
  publishedAt: z.number().int().nonnegative(),
});
export type ClientVisibleVersion = z.infer<typeof clientVisibleVersionSchema>;

/**
 * The inline citation token grammar (RESEARCH.md Pattern 3): a
 * self-contained SNAPSHOT — never a live foreign-key reference to a
 * `vodTimestamps` note — so a published version survives its source
 * evidence note later being edited or deleted. `sourceVodRef` is the
 * source VOD's match id, travelling WITH the token so a multi-VOD
 * citation (D-04) is representable identically to a same-source one.
 */
export const CITATION_LABEL_MAX_LENGTH = 200;
export const citationTokenSchema = z.object({
  /** The source VOD's match id — the citation's `sourceVodRef`. */
  sourceVodRef: z.string().min(1),
  seconds: z.number().int().nonnegative(),
  /** Display label, decoded from the token's URL-encoded form — bounded to the same length `vodTimestampSchema.note` already enforces. */
  label: z.string().trim().max(CITATION_LABEL_MAX_LENGTH),
});
export type CitationToken = z.infer<typeof citationTokenSchema>;

/**
 * Fixed grammar: `{{cite:matchId=...;seconds=...;label=...}}`. `seconds`
 * must be all-digits at the regex level (a non-numeric value never even
 * reaches Zod) and `label` is URL-encoded inline text. No partial recovery
 * — anything outside this exact grammar is not a citation token (V5 input
 * validation, T-12-03).
 */
const CITATION_TOKEN_PATTERN = /\{\{cite:matchId=([^;}]+);seconds=(\d+);label=([^}]*)\}\}/;

/** Serializes a citation token into its inline `{{cite:...}}` grammar for insertion into a section/private-notes body. */
export function serializeCitationToken(token: CitationToken): string {
  const parsed = citationTokenSchema.parse(token);
  return `{{cite:matchId=${parsed.sourceVodRef};seconds=${parsed.seconds};label=${encodeURIComponent(parsed.label)}}}`;
}

/**
 * Parses a single inline `{{cite:...}}` token. Returns `null` (never
 * throws) for anything outside the fixed grammar or that fails the bounded
 * field checks — e.g. a non-numeric `seconds` (rejected by the regex
 * itself) or an over-length `label` (rejected by `citationTokenSchema`).
 */
export function parseCitationToken(raw: string): CitationToken | null {
  const match = CITATION_TOKEN_PATTERN.exec(raw);
  if (!match) return null;
  const [, sourceVodRef, secondsRaw, rawLabel] = match;
  if (sourceVodRef == null || secondsRaw == null || rawLabel == null) return null;
  let label: string;
  try {
    label = decodeURIComponent(rawLabel);
  } catch {
    return null;
  }
  const result = citationTokenSchema.safeParse({
    sourceVodRef,
    seconds: Number(secondsRaw),
    label,
  });
  return result.success ? result.data : null;
}

/**
 * PATCH .../draft body (REV-02) — carries the optimistic-concurrency
 * revision check plus a PARTIAL patch of sections/private notes.
 * `expectedRevision` is always required; the patch fields are omitted when
 * unchanged by this particular autosave.
 */
export const createDraftPatchInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  sections: z.array(reviewSectionSchema).max(MAX_REVIEW_SECTIONS).nullish(),
  coachPrivateNotes: safeMarkdownDocSchema.nullish(),
});
export type CreateDraftPatchInput = z.infer<typeof createDraftPatchInputSchema>;
