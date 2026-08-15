import {
  RESEARCH_ENRICHMENT_MAX_RAW_TEXT,
  RESEARCH_ENRICHMENT_MAX_REASON_TEXT,
  RESEARCH_ENRICHMENT_MAX_URL,
} from '@smash-tracker/shared';

/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): every bound
 * the persistence schema (`researchEnrichmentObservationRecordSchema`)
 * declares over an UNTRUSTED wiki-sourced string, restated here so the
 * adapters can clamp at extraction time. The production write-boundary
 * abort proved that a bound enforced only at persist time is a bound
 * enforced after the budget is spent — extraction and persistence must
 * agree by construction, so extraction clamps to the SAME caps the schema
 * validates.
 *
 * The re-exported caps come straight from `@smash-tracker/shared`; the
 * locally declared ones mirror schema literals that the shared module does
 * not export (each names the member it mirrors) — same duplicated-with-
 * a-comment convention `researchEnrichment.ts` itself documents for its
 * Phase 30 mirrors.
 */

export { RESEARCH_ENRICHMENT_MAX_RAW_TEXT, RESEARCH_ENRICHMENT_MAX_REASON_TEXT };

/** Mirrors `sourcePageTitle`/`tournamentPageTitle`/`tournamentDisplayName`/`sectionHeading` `.max(300)`. */
export const MAX_PAGE_TITLE_TEXT = 300;

/** Mirrors `bracketTemplate`/`bracketKey`/`derivedRoundLabel`/`tournamentStartggSlug`/`vodInheritedFromBracketKey` `.max(200)`. */
export const MAX_KEY_TEXT = 200;

/** Mirrors the observation record's `game` member `.max(64)`. */
export const MAX_GAME_SCOPE_TEXT = 64;

/** Mirrors the observation record's `rawDate` member `.max(100)`. */
export const MAX_RAW_DATE_TEXT = 100;

/** Mirrors the observation record's `rawVodUrl`/`vodUrl` `.max(2048)` (`RESEARCH_ENRICHMENT_MAX_URL`). */
export const MAX_VOD_URL_TEXT = RESEARCH_ENRICHMENT_MAX_URL;

/**
 * Bounds an untrusted wiki-sourced string to a schema cap by truncation.
 * Deliberately dumb (no ellipsis, no word boundary): the stored value is
 * EVIDENCE, and the only requirement is that it can never exceed the
 * persistence schema's declared bound — the same bound the dry-run parity
 * gate validates against, so extraction and persistence agree by
 * construction.
 */
export function clampUntrustedText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Trims and clamps an optional untrusted string, returning `undefined` for
 * a missing or effectively-empty value — the conditional-spread-friendly
 * shape every adapter uses for `.nullish()` members (house constraint 1).
 */
export function normalizeOptionalUntrustedText(
  value: string | undefined | null,
  maxLength: number,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return clampUntrustedText(trimmed, maxLength);
}

/** Clamps a string value while passing `null`/`undefined` through byte-unchanged — for members whose absent/null shape an adapter already established and must not disturb. */
export function clampNullableUntrustedText(
  value: string | null | undefined,
  maxLength: number,
): string | null | undefined {
  return typeof value === 'string' ? clampUntrustedText(value, maxLength) : value;
}

/** Clamps a stated `resolutionReasons` entry (reasons interpolate untrusted source text) to the schema's per-reason cap. */
export function clampReason(reason: string): string {
  return clampUntrustedText(reason, RESEARCH_ENRICHMENT_MAX_REASON_TEXT);
}
