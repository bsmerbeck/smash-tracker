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
 * Parses a validated start-offset value: bare seconds (`123`), suffixed
 * seconds (`123s`), or an `1h2m3s`-style duration (any subset of the h/m/s
 * segments, in order). Mirrors `apps/web/src/lib/vod.ts`'s
 * `parseDurationOrSeconds` member-for-member (duplicated, not imported —
 * this API package cannot import from the web package) so an offset this
 * module preserves is always one the shipped web reader
 * (`parseVodStartSeconds`) decodes to the same whole-seconds value. Returns
 * `null` for anything that matches neither form — an INVALID offset is
 * dropped from the canonical form (validated offsets only, 30.3 Gate 5),
 * never guessed at and never passed through raw.
 */
function parseVodOffsetSeconds(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (match && (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined)) {
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return null;
}

/**
 * Extracts the validated start offset a YouTube URL carries: the `t` query
 * param, the `start` query param, or the legacy `#t=` fragment — the three
 * forms the committed player-VOD-page fixtures actually contain
 * (`?t=4512`, `&t=4050s`, `#t=11m38s`, `?si=...&t=29731`). The first form
 * present that VALIDATES wins; an invalid value falls through to the next
 * source rather than poisoning it. Returns `null` when no validated,
 * positive offset exists (a zero offset is equivalent to none).
 */
function extractYoutubeOffsetSeconds(parsed: URL): number | null {
  const candidates: (string | null)[] = [
    parsed.searchParams.get('t'),
    parsed.searchParams.get('start'),
  ];
  if (parsed.hash.startsWith('#t=')) {
    candidates.push(parsed.hash.slice('#t='.length));
  }
  for (const candidate of candidates) {
    if (candidate == null || candidate.length === 0) {
      continue;
    }
    const seconds = parseVodOffsetSeconds(candidate);
    if (seconds !== null && seconds > 0) {
      return seconds;
    }
  }
  return null;
}

/** Formats a whole-seconds offset as a Twitch-style `1h2m3s` duration — mirrors `apps/web/src/lib/vod.ts`'s `toTwitchDuration` (duplicated, not imported; see `parseVodOffsetSeconds`). */
function toTwitchDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = '';
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  out += `${seconds}s`;
  return out;
}

/** Builds the canonical YouTube watch URL for a video id plus an optional validated offset. The offset is emitted as `t=<seconds>s` — the exact member `apps/web/src/lib/vod.ts`'s `vodDeepLink` writes on a watch URL, and one `parseVodStartSeconds` reads back. */
function canonicalYoutubeWatch(videoId: string, offsetSeconds: number | null): CanonicalUrl {
  const canonical = new URL(`https://${CANONICAL_YOUTUBE_WATCH_HOST}/watch`);
  canonical.searchParams.set('v', videoId);
  if (offsetSeconds !== null) {
    canonical.searchParams.set('t', `${offsetSeconds}s`);
  }
  return { vodUrl: canonical.toString(), host: CANONICAL_YOUTUBE_WATCH_HOST };
}

/**
 * Builds the canonical, storable form for a URL that has already passed the
 * scheme + host allowlist check. Converts a short link OR a `/live/<id>`
 * URL to the `watch` form so the same video written three ways
 * deduplicates, strips every query parameter that is not the video
 * identifier or a VALIDATED start offset (tracking parameters like `?si=`
 * and playlist context like `&list=`/`&index=` are dropped), upgrades to
 * https, and passes a Twitch URL through with its path intact and only a
 * validated `t` offset retained (Twitch's video identifier lives in the
 * path, not the query). A validated offset is PRESERVED — normalized to
 * `t=<seconds>s` for YouTube and a `XhYmZs` duration for Twitch — because a
 * set-level VOD reference into an all-day stream recording IS the offset
 * (30.3 Gate 5: two sets sharing one video with different offsets must stay
 * distinct after normalization). Returns `null` when the allowlisted host's
 * URL carries no recognisable video identifier — e.g. a YouTube long-form
 * URL whose path is neither `/watch` nor `/live/<id>`, or a `/watch` URL
 * with no `v=`.
 */
function buildCanonicalUrl(parsed: URL, host: string): CanonicalUrl | null {
  if (YOUTUBE_SHORT_LINK_HOSTS.has(host)) {
    const videoId = parsed.pathname.replace(/^\//, '');
    if (!videoId || videoId.includes('/')) {
      return null;
    }
    return canonicalYoutubeWatch(videoId, extractYoutubeOffsetSeconds(parsed));
  }

  if (YOUTUBE_LONG_FORM_HOSTS.has(host)) {
    if (parsed.pathname === '/watch') {
      const videoId = parsed.searchParams.get('v');
      if (!videoId) {
        return null;
      }
      return canonicalYoutubeWatch(videoId, extractYoutubeOffsetSeconds(parsed));
    }
    if (parsed.pathname.startsWith('/live/')) {
      // A live-stream permalink; once the stream ends the id doubles as the
      // ordinary video id, so `/live/<id>?t=4512` canonicalizes to the same
      // watch form as every other reference to that video.
      const videoId = parsed.pathname.slice('/live/'.length);
      if (!videoId || videoId.includes('/')) {
        return null;
      }
      return canonicalYoutubeWatch(videoId, extractYoutubeOffsetSeconds(parsed));
    }
    return null;
  }

  if (TWITCH_HOSTS.has(host)) {
    const canonical = new URL(`https://${CANONICAL_TWITCH_HOST}${parsed.pathname}`);
    const rawOffset = parsed.searchParams.get('t');
    if (rawOffset != null && rawOffset.length > 0) {
      const seconds = parseVodOffsetSeconds(rawOffset);
      if (seconds !== null && seconds > 0) {
        canonical.searchParams.set('t', toTwitchDuration(seconds));
      }
    }
    return { vodUrl: canonical.toString(), host: CANONICAL_TWITCH_HOST };
  }

  return null;
}

/**
 * Normalizes a raw Liquipedia-sourced VOD URL string, enforcing the
 * scheme + host allowlist at WRITE time (this module's header, T-30.2-18).
 *
 * - A watch-style YouTube URL, a short-link YouTube URL, and a
 *   `/live/<id>` YouTube URL for the same video normalize to the SAME
 *   canonical watch form (30.3 Gate 5 — `/live/` links were previously
 *   rejected as carrying no video identifier, a known loss).
 * - A VALIDATED start offset (`t`/`start` query param or legacy `#t=`
 *   fragment on YouTube; `t` query param on Twitch; bare seconds, `123s`,
 *   or `1h2m3s` forms) is PRESERVED, normalized to `t=<seconds>s` (YouTube)
 *   or a `XhYmZs` duration (Twitch). An invalid offset value is dropped,
 *   never guessed at. Two sets sharing one video with different offsets
 *   therefore keep DISTINCT canonical forms — and distinct dedupe keys.
 * - A tracking parameter (`si`, `feature`, playlist `list`/`index`, ...) is
 *   stripped from the canonical form; the raw string is returned unchanged
 *   in `rawVodUrl`.
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

// NOTE (30.3 verifier closure 6): a `buildVodDedupeKey(canonicalUrl,
// targetSetId)` helper used to live here but was DEAD production code —
// nothing in the pipeline ever called it. The property it described (the
// mandatory Supernova fixture has ONE VOD covering both the grand final and
// its reset, and deduping on the URL alone would collapse the two legitimate
// attachments — RESEARCH section 2.6) is carried by the REAL mechanisms
// instead: the vod-list observation-id discriminator
// (`vodList.ts`'s `toVodObservationRecords`, which rides the URL along with
// tournament/opponent/index) and the per-target-set attachment tree keys
// (`researchEnrichmentAttachments/{tenantId}/{targetSetId}/{observationId}`).
// Its property assertions moved to `vodList.test.ts` and the Supernova
// acceptance suite, which proves the GF/reset non-collapse end-to-end.
