/**
 * English ordinal suffix for a positive integer (1st, 2nd, 3rd, 4th, ...11th,
 * 12th, 13th, 21st...). The 11-13 teens are a special case that always take
 * "th" regardless of their last digit. Exported standalone (rather than
 * baked into a single formatter) so callers can compose it with their own
 * label text.
 */
export function ordinalSuffix(n: number): string {
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return 'th';
  }
  switch (abs % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** Formats a positive integer with its ordinal suffix, e.g. `129` -> "129th". */
export function formatOrdinal(n: number): string {
  return `${n}${ordinalSuffix(n)}`;
}

/**
 * Compact "seed 56 · placed 129th" label for an opponent's per-event
 * context, when at least one of seed/placement is known. Returns `null`
 * when both are absent so callers can omit the fragment cleanly.
 */
export function formatOpponentEventContext(opponent: {
  seed?: number;
  placement?: number;
}): string | null {
  const parts: string[] = [];
  if (opponent.seed != null) {
    parts.push(`seed ${opponent.seed}`);
  }
  if (opponent.placement != null) {
    parts.push(`placed ${formatOrdinal(opponent.placement)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
