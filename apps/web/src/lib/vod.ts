/**
 * VOD timestamp helpers (V7-E): building a deep-link URL that opens a VOD at
 * a specific second, and formatting seconds as a clock-style label for
 * display. Supports YouTube and Twitch's timestamp query-param conventions;
 * any other host falls back to the base URL unchanged (still a valid link,
 * just without a seek).
 */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv']);

/** Formats a whole-seconds offset as a Twitch-style `1h2m3s` duration string. */
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
