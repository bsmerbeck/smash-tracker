import { parseGspNumber } from '@/pages/Gsp/lib/parseGspNumber';

/**
 * V12 SEO: the GSP Calculator is a cold-traffic landing surface, so input
 * needs to tolerate shorthand a visitor might type without thinking (e.g.
 * "6.3m" for 6,300,000) on top of everything `parseGspNumber` already
 * tolerates (comma/space thousands separators). This wraps
 * `parseGspNumber` — the authed GSP page's parser, kept as the single
 * source of truth for "what's a valid GSP integer" — by expanding a
 * trailing `k`/`m` suffix into its multiplied-out digit form first, then
 * delegating. Returns `null` for anything neither parser accepts.
 */
export function parseGspInput(raw: string): number | null {
  const trimmed = raw.trim();
  const shorthandMatch = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(trimmed);
  if (shorthandMatch) {
    const value = Number(shorthandMatch[1]);
    const multiplier = shorthandMatch[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000;
    const expanded = Math.round(value * multiplier);
    return parseGspNumber(String(expanded));
  }
  return parseGspNumber(raw);
}
