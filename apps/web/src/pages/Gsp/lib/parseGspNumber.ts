/**
 * Parses a user-entered GSP value, tolerating the thousands separators that
 * come along when copying numbers from elitegsp.com or the game's own UI
 * (e.g. "10,300,000", "10 300 000"). Returns a non-negative integer
 * (matchRecordSchema allows gsp = 0), or null when the input isn't one —
 * callers with stricter needs (the Elite threshold must be positive) layer
 * their own check on top.
 *
 * The inputs using this must be `type="text"` — browsers refuse to accept
 * a comma paste into `type="number"` fields at all, which is how this bug
 * originally presented.
 */
export function parseGspNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}
