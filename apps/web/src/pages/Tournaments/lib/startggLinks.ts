const STARTGG_BASE_URL = 'https://start.gg';

/**
 * Builds a start.gg deep link from a slug (tournament, event, or user
 * profile slug — all are relative paths off start.gg's root, e.g.
 * "tournament/the-box-juice-box-26" or "user/9fb774ae"). Returns `null` when
 * the slug is absent so callers can omit the link cleanly instead of
 * rendering a dead/malformed href.
 */
export function buildStartggUrl(slug: string | undefined): string | null {
  if (!slug) {
    return null;
  }
  return `${STARTGG_BASE_URL}/${slug}`;
}

/**
 * Prefers the more specific event slug (deep-links straight to the bracket
 * the entry belongs to), falling back to the tournament slug when the event
 * slug hasn't synced yet. Returns `null` when neither is present — callers
 * hide the "View on start.gg" affordance entirely in that case.
 */
export function buildEventStartggUrl(entry: { slug?: string; eventSlug?: string }): string | null {
  return buildStartggUrl(entry.eventSlug ?? entry.slug);
}
