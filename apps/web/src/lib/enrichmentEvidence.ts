import { z } from 'zod';
import {
  researchEnrichmentAttributionEntrySchema,
  researchEnrichmentAttributionSourceSchema,
} from '@smash-tracker/shared';

/**
 * Phase 30.3 Gate 5 (web evidence-surfaces worker): the two OPTIONAL
 * character/stock evidence halves an attribution entry MAY now carry,
 * present only when the source's seat 1/2 orientation was proven against the
 * row's own provider-authored opponent tag (absence = the resolver
 * ABSTAINED — never render a guess).
 *
 * `packages/shared` is read-only to this worker; the API-side attribution
 * builder that populates these two members is landing in a PARALLEL
 * worktree. Rather than blocking on that merge (or forking
 * `researchEnrichment.ts`), this module EXTENDS the shared entry schema with
 * the two halves locally — `.extend()` on an imported zod object schema is
 * an ordinary use of the shared export, not a modification of the shared
 * package — so:
 *
 *   - today, before the API sends these fields, parsing is unaffected (both
 *     halves are `.nullish()`, mirroring the shared entry's existing
 *     `stage`/`vod` halves) — every page renders byte-identically to today;
 *   - the moment the API starts sending them, the schemas below (not the
 *     narrower shared ones) are what `api.users.enrichmentAttribution`
 *     actually parses responses with (see `apps/web/src/lib/api.ts`), so the
 *     new fields survive rather than being silently stripped by zod's
 *     default unknown-key behaviour on `.parse()`/`.safeParse()`.
 *
 * Each half extends `researchEnrichmentAttributionSourceSchema` — the SAME
 * base the shared `stage`/`vod` halves extend — so a future page-identity
 * addition on the API side (`sourcePageUrl`, `sourcePageTitle`,
 * `sourceRevisionId`) parses through unchanged, and the existing
 * `LiquipediaAttributionBadge` can render a source link for either new
 * variant exactly the way it already does for `stage`/`vod`.
 */
export const enrichmentCharacterAttributionSchema =
  researchEnrichmentAttributionSourceSchema.extend({
    /**
     * The source's raw seat text for the ROW'S SUBJECT, seat-orientation-
     * proven. Untrusted third-party text — never dropped, never rendered as
     * markup. `.nullish()` to MATCH THE SHARED CONTRACT (verifier finding B1):
     * the source may record only one seat's character, the API conditional-
     * spreads the absent side away, and a required member here made ONE such
     * row fail the whole-response parse — silently blanking every attribution
     * in its ≤200-key chunk.
     */
    subjectRaw: z.string().nullish(),
    /** The source's raw seat text for the row's opponent. Nullish for the same one-sided-evidence reason. */
    opponentRaw: z.string().nullish(),
    /** Present only when `subjectRaw` resolved against the app's fighter vocabulary (`SpriteList`) — absent means "flagged unmapped", never a guessed id. */
    subjectFighterId: z.number().int().nullish(),
    opponentFighterId: z.number().int().nullish(),
  });
export type EnrichmentCharacterAttribution = z.infer<typeof enrichmentCharacterAttributionSchema>;

export const enrichmentStockAttributionSchema = researchEnrichmentAttributionSourceSchema.extend({
  stocksLeft: z.number().int().min(0).max(3),
});
export type EnrichmentStockAttribution = z.infer<typeof enrichmentStockAttributionSchema>;

/** The shared entry schema, additively extended with the two Gate 5 halves above — see the module doc comment for why this extension lives here rather than in `packages/shared`. */
export const webEnrichmentAttributionEntrySchema = researchEnrichmentAttributionEntrySchema.extend({
  characters: enrichmentCharacterAttributionSchema.nullish(),
  stocks: enrichmentStockAttributionSchema.nullish(),
});
export type WebEnrichmentAttributionEntry = z.infer<typeof webEnrichmentAttributionEntrySchema>;

/** Mirrors `researchEnrichmentAttributionResponseSchema`'s own 200-entry cap, using the extended entry schema above — the actual response schema `api.users.enrichmentAttribution` parses with. */
export const webEnrichmentAttributionResponseSchema = z.object({
  attributions: z.array(webEnrichmentAttributionEntrySchema).max(200),
});
export type WebEnrichmentAttributionResponse = z.infer<
  typeof webEnrichmentAttributionResponseSchema
>;
