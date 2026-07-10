/**
 * VOD timestamp helpers (V7-E): building a deep-link URL that opens a VOD at
 * a specific second, and formatting seconds as a clock-style label for
 * display. Supports YouTube and Twitch's timestamp query-param conventions;
 * any other host falls back to the base URL unchanged (still a valid link,
 * just without a seek).
 */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

/**
 * Discriminated union identifying which embeddable provider (if any) a VOD
 * URL belongs to, plus the provider-specific video id needed to construct
 * an embedded player (`YT.Player` / `Twitch.Player`).
 */
export type VodProvider =
  | { provider: 'youtube'; videoId: string }
  | { provider: 'twitch'; videoId: string }
  | { provider: null };

/** Formats a whole-seconds offset as a Twitch-style `1h2m3s` duration string. */
export function toTwitchDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = '';
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  out += `${seconds}s`;
  return out;
}

/**
 * Parses a bare-seconds value (`"123"`, `"123s"`) or an `1h2m3s`-style
 * duration string (any subset of the h/m/s segments, in order) into whole
 * seconds. Returns `null` for anything that doesn't match either form —
 * empty input, non-numeric junk, or a segment out of order.
 */
function parseDurationOrSeconds(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (match && (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined)) {
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

/**
 * Builds a URL that opens `url` at `seconds` in, when the host is a
 * recognized VOD provider (YouTube long/short form, Twitch VODs). Any other
 * URL (including a malformed one) is returned unchanged — still usable as a
 * plain link, just without a seek.
 */
export function vodDeepLink(url: string, seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host) && parsed.pathname === '/watch') {
    parsed.searchParams.set('t', `${wholeSeconds}s`);
    return parsed.toString();
  }

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    parsed.searchParams.set('t', String(wholeSeconds));
    return parsed.toString();
  }

  if (TWITCH_HOSTS.has(host) && parsed.pathname.startsWith('/videos/')) {
    parsed.searchParams.set('t', toTwitchDuration(wholeSeconds));
    return parsed.toString();
  }

  return url;
}

/**
 * Extracts the start-offset (whole seconds) encoded in a stored `vodUrl`'s
 * `t`/`start` query param, e.g. an entire event recorded as ONE video where
 * each match's stored URL carries its own offset into that video. YouTube
 * accepts either `t` or `start`, in bare-seconds (`123`/`123s`) or duration
 * (`1h2m3s`) form; Twitch accepts `t` in either form. Any other host,
 * missing param, or malformed value yields `0` — never throws, matching
 * `detectVodProvider`/`vodDeepLink`'s fallback behavior.
 */
export function parseVodStartSeconds(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 0;
  }

  const host = parsed.hostname.toLowerCase();
  const isYoutube =
    (YOUTUBE_HOSTS.has(host) && parsed.pathname === '/watch') || YOUTUBE_SHORT_HOSTS.has(host);
  const isTwitch = TWITCH_HOSTS.has(host) && parsed.pathname.startsWith('/videos/');

  if (!isYoutube && !isTwitch) {
    return 0;
  }

  const raw = isYoutube
    ? (parsed.searchParams.get('t') ?? parsed.searchParams.get('start'))
    : parsed.searchParams.get('t');
  if (!raw) {
    return 0;
  }

  return parseDurationOrSeconds(raw) ?? 0;
}

/**
 * Extracts the embeddable provider + video id from a stored `vodUrl`, e.g.
 * `{ provider: 'youtube', videoId: 'abc123' }`. This feeds the player
 * constructors (`YT.Player` / `Twitch.Player`), which need a raw video id —
 * not a seek URL — so it's a separate concern from `vodDeepLink` above.
 * Reuses the same host allowlists as `vodDeepLink` (never a looser check);
 * any non-allowlisted host, malformed URL, or missing id yields
 * `{ provider: null }`.
 */
export function detectVodProvider(url: string): VodProvider {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { provider: null };
  }

  const host = parsed.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host) && parsed.pathname === '/watch') {
    const videoId = parsed.searchParams.get('v');
    return videoId ? { provider: 'youtube', videoId } : { provider: null };
  }

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    const videoId = parsed.pathname.slice(1);
    return videoId ? { provider: 'youtube', videoId } : { provider: null };
  }

  if (TWITCH_HOSTS.has(host) && parsed.pathname.startsWith('/videos/')) {
    const videoId = parsed.pathname.slice('/videos/'.length);
    return videoId ? { provider: 'twitch', videoId } : { provider: null };
  }

  return { provider: null };
}

/**
 * Formats a whole-seconds offset as `m:ss` (under an hour) or `h:mm:ss` (an
 * hour or more), e.g. `161` -> `2:41`, `3661` -> `1:01:01`.
 */
export function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parses a `m:ss` or `h:mm:ss` clock-style string (the inverse of
 * `formatTimestamp`) into whole seconds. Returns `null` for anything that
 * doesn't match — empty input, non-numeric parts, or out-of-range
 * minutes/seconds (>= 60).
 */
export function parseTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  if (!parts.every((p) => /^\d+$/.test(p))) {
    return null;
  }

  const numbers = parts.map(Number);
  const [hours, minutes, seconds]: [number, number, number] =
    numbers.length === 3 ? [numbers[0]!, numbers[1]!, numbers[2]!] : [0, numbers[0]!, numbers[1]!];

  if (minutes >= 60 || seconds >= 60) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parses a user-typed VOD start-time offset into whole seconds, accepting
 * whichever of the shapes a player is most likely to type: `h:mm:ss`/`m:ss`
 * clock style (delegates to `parseTimestamp`), bare seconds (`5025`), or an
 * `1h23m45s`-style duration string (delegates to the same duration parser
 * `vodDeepLink`'s `t=` param uses, so a value typed here and a value read
 * back from a URL always agree). Returns `null` for anything that matches
 * neither form.
 */
export function parseFlexibleTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(':')) {
    return parseTimestamp(trimmed);
  }
  return parseDurationOrSeconds(trimmed);
}
