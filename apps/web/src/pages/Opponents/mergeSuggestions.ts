/**
 * "Merge into..." suggestion ranking for the Scouting page. Given the
 * opponent name being merged away and the full candidate list (every other
 * opponent name), ranks near-miss names first: a small Levenshtein edit
 * distance (<= 2) or a prefix relationship (either name is a prefix of the
 * other) to the selected name. Remaining candidates keep their original
 * relative order (stable), appended after the suggestions.
 */

/** Classic iterative Levenshtein edit distance (single-row DP, case-sensitive). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          previousRow[j]! + 1, // deletion
          currentRow[j - 1]! + 1, // insertion
          previousRow[j - 1]! + substitutionCost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }

  return previousRow[b.length]!;
}

/** True when `a` and `b` are in a prefix relationship (either is a prefix of the other), both non-empty. */
export function isPrefixRelation(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  return a.startsWith(b) || b.startsWith(a);
}

const SUGGESTION_MAX_DISTANCE = 2;

/**
 * Whether `candidate` is a "near-miss" of `name` worth suggesting first:
 * Levenshtein distance <= 2, or a prefix relationship. Names are compared
 * case-insensitively (opponent names are already lowercased in practice,
 * but this stays defensive) and a candidate is never suggested against
 * itself.
 */
export function isNearMissSuggestion(name: string, candidate: string): boolean {
  const a = name.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) {
    return false;
  }
  return levenshteinDistance(a, b) <= SUGGESTION_MAX_DISTANCE || isPrefixRelation(a, b);
}

/**
 * Orders `candidates` (every other opponent name) for the merge-target
 * picker: near-miss suggestions first (sorted by ascending edit distance,
 * ties broken alphabetically for determinism), then the rest in their
 * original order. `name` itself is excluded if present in `candidates`.
 */
export function rankMergeSuggestions(name: string, candidates: string[]): string[] {
  const others = candidates.filter((c) => c !== name);

  const withDistance = others.map((candidate) => ({
    candidate,
    distance: levenshteinDistance(name.toLowerCase(), candidate.toLowerCase()),
    isNearMiss: isNearMissSuggestion(name, candidate),
  }));

  const suggestions = withDistance
    .filter((c) => c.isNearMiss)
    .sort((x, y) => x.distance - y.distance || x.candidate.localeCompare(y.candidate))
    .map((c) => c.candidate);

  const suggestionSet = new Set(suggestions);
  const rest = others.filter((c) => !suggestionSet.has(c));

  return [...suggestions, ...rest];
}
