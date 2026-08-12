/**
 * Phase 30.2 Plan 04 (ENR-02/ENR-08, T-30.2-18): VOD URL normalization with
 * a write-time scheme AND host allowlist.
 *
 * `normalizeLiquipediaVodUrl` enforces the allowlist at NORMALIZATION time,
 * which is WRITE time — the scheme must be https after upgrade and the
 * host must be an exact member of `LIQUIPEDIA_VOD_ALLOWED_HOSTS`. A
 * render-time-only check is bypassable by any other reader of the stored
 * value, and the stored value is what a future surface will trust
 * (RESEARCH section 15's malicious-URL row). Only a URL that passes both
 * checks ever produces a non-null canonical value; every rejection carries
 * a stated reason so no URL is ever silently dropped.
 *
 * `LIQUIPEDIA_VOD_ALLOWED_HOSTS`'s membership is deliberately DUPLICATED
 * from, rather than imported from, `apps/web/src/lib/vod.ts`'s
 * `YOUTUBE_HOSTS` / `YOUTUBE_SHORT_HOSTS` / `TWITCH_HOSTS` sets: that is a
 * web-package module and this API package cannot import from it. The two
 * lists are kept in agreement by review AND by `vodUrl.test.ts`'s explicit
 * assertion that every host string the shipped detector recognises is also
 * accepted here. Adding a host to one list without the other means a URL
 * this phase stores can never be embedded, or a URL the app already embeds
 * can never be stored — this is the deliberate asymmetry: `vod.ts`
 * recognises hosts for RENDER-time embedding on the web side, this module
 * allowlists scheme and host for WRITE-time storage on the API side; the
 * host membership must agree, but the two enforcement points are distinct
 * and both are required.
 *
 * No I/O, no async — a pure function library operating on the WHATWG `URL`
 * constructor only.
 */

/**
 * The complete write-time host allowlist — the YouTube long-form and
 * short-link hosts, plus the Twitch host, matching
 * `apps/web/src/lib/vod.ts`'s `YOUTUBE_HOSTS` / `YOUTUBE_SHORT_HOSTS` /
 * `TWITCH_HOSTS` sets member-for-member (see this module's header for why
 * that file is duplicated rather than imported).
 */
export const LIQUIPEDIA_VOD_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'twitch.tv',
  'www.twitch.tv',
  'm.twitch.tv',
]);

const CANONICAL_YOUTUBE_WATCH_HOST = 'www.youtube.com';
const CANONICAL_TWITCH_HOST = 'www.twitch.tv';

const YOUTUBE_LONG_FORM_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_LINK_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

export interface NormalizeLiquipediaVodUrlResult {
  /** Byte-identical to the input — always returned, even on rejection. */
  rawVodUrl: string;
  /** The normalized, storable form, or `null` when rejected. */
  vodUrl: string | null;
  /** The canonical host of the ACCEPTED value, or `null` when rejected. */
  host: string | null;
  rejected: boolean;
  /** A stated, human-readable reason for rejection, or `null` when accepted. */
  reason: string | null;
}

function rejected(
  raw: string,
  reason: string,
  host: string | null = null,
): NormalizeLiquipediaVodUrlResult {
  return { rawVodUrl: raw, vodUrl: null, host, rejected: true, reason };
}

function accepted(raw: string, vodUrl: string, host: string): NormalizeLiquipediaVodUrlResult {
  return { rawVodUrl: raw, vodUrl, host, rejected: false, reason: null };
}

interface CanonicalUrl {
  vodUrl: string;
  host: string;
}

/**
 * Builds the canonical, storable form for a URL that has already passed
 * the scheme + host allowlist check. Converts a short link to the `watch`
 * form so the same video written two ways deduplicates, strips every query
 * parameter that is not the video identifier (tracking parameters like
 * `?si=` are dropped), upgrades to https, and passes a Twitch URL through
 * with its path intact but its query stripped (Twitch's video identifier
 * lives in the path, not the query). Returns `null` when the allowlisted
 * host's URL carries no recognisable video identifier — e.g. a YouTube
 * long-form URL whose path isn't `/watch`, or a `/watch` URL with no `v=`.
 */
function buildCanonicalUrl(parsed: URL, host: string): CanonicalUrl | null {
  if (YOUTUBE_SHORT_LINK_HOSTS.has(host)) {
    const videoId = parsed.pathname.replace(/^\//, '');
    if (!videoId) {
      return null;
    }
    const canonical = new URL(`https://${CANONICAL_YOUTUBE_WATCH_HOST}/watch`);
    canonical.searchParams.set('v', videoId);
    return { vodUrl: canonical.toString(), host: CANONICAL_YOUTUBE_WATCH_HOST };
  }

  if (YOUTUBE_LONG_FORM_HOSTS.has(host)) {
    if (parsed.pathname !== '/watch') {
      return null;
    }
    const videoId = parsed.searchParams.get('v');
    if (!videoId) {
      return null;
    }
    const canonical = new URL(`https://${CANONICAL_YOUTUBE_WATCH_HOST}/watch`);
    canonical.searchParams.set('v', videoId);
    return { vodUrl: canonical.toString(), host: CANONICAL_YOUTUBE_WATCH_HOST };
  }

  if (TWITCH_HOSTS.has(host)) {
    const canonical = new URL(`https://${CANONICAL_TWITCH_HOST}${parsed.pathname}`);
    return { vodUrl: canonical.toString(), host: CANONICAL_TWITCH_HOST };
  }

  return null;
}

/**
 * Normalizes a raw Liquipedia-sourced VOD URL string, enforcing the
 * scheme + host allowlist at WRITE time (this module's header, T-30.2-18).
 *
 * - A watch-style YouTube URL and a short-link YouTube URL for the same
 *   video normalize to the SAME canonical form.
 * - A tracking parameter on a short link is stripped from the canonical
 *   form; the raw string is returned unchanged in `rawVodUrl`.
 * - A plain-http short link is upgraded to https in the canonical form —
 *   never returned as http.
 * - A Twitch video URL is accepted and passed through with its host
 *   preserved (canonicalized to `www.twitch.tv`).
 * - A URL on any other host is REJECTED with a stated reason.
 * - A `javascript:`/`data:` scheme, or any scheme other than http(s), is
 *   rejected with a stated reason.
 * - A protocol-relative URL (`//host/path`) is rejected.
 */
export function normalizeLiquipediaVodUrl(raw: string): NormalizeLiquipediaVodUrlResult {
  if (raw.startsWith('//')) {
    return rejected(raw, 'protocol-relative URLs are not accepted; an explicit scheme is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return rejected(raw, 'malformed URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return rejected(
      raw,
      `scheme "${parsed.protocol}" is not allowed; only http(s) is accepted (plain http is upgraded to https)`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!LIQUIPEDIA_VOD_ALLOWED_HOSTS.has(host)) {
    return rejected(raw, `host "${host}" is not a member of LIQUIPEDIA_VOD_ALLOWED_HOSTS`);
  }

  const canonical = buildCanonicalUrl(parsed, host);
  if (!canonical) {
    return rejected(
      raw,
      'URL matched an allowlisted host but carried no recognisable video identifier',
      host,
    );
  }

  return accepted(raw, canonical.vodUrl, canonical.host);
}

/**
 * Builds the dedupe key this module exposes: the PAIR of canonical URL and
 * target set id, never the URL alone. This exists because the mandatory
 * Supernova fixture has ONE VOD covering both the grand final and its
 * reset (RESEARCH section 2.6) — projecting that single URL onto two
 * different target sets is CORRECT behaviour, not a duplicate. A caller
 * that deduped on the URL alone would incorrectly collapse the reset's VOD
 * projection into the grand final's, losing one of the two legitimate
 * attachments. Two different videos, by construction, never normalize to
 * the same canonical form (their video identifiers differ), so the pair
 * key is also never accidentally satisfied by two distinct real videos.
 */
export function buildVodDedupeKey(canonicalUrl: string, targetSetId: string): string {
  return `${canonicalUrl}::${targetSetId}`;
}
