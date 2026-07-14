import type { Match, Playlist } from '@smash-tracker/shared';

/**
 * Client-side soft-orphan join (T-04-05): resolves `playlist.matchIds` to
 * their `Match` objects, preserving playlist order, against ONLY the
 * caller's own already-loaded `matches` (never a fetch, never cross-user).
 * A stored id with no match in `matches` (deleted match, foreign id, stale
 * cache) is silently skipped rather than throwing or rendering a gap.
 */
export function resolvePlaylistMatches(playlist: Playlist, matches: Match[]): Match[] {
  return playlist.matchIds
    .map((id) => matches.find((match) => match.id === id))
    .filter((match): match is Match => match != null);
}

/**
 * Returns a NEW array with `id` appended only if not already present
 * (idempotent add-to-playlist). Never mutates `matchIds`.
 */
export function addMatchToPlaylistIds(matchIds: string[], id: string): string[] {
  if (matchIds.includes(id)) {
    return matchIds;
  }
  return [...matchIds, id];
}

/**
 * Returns a NEW array with the item at `index` swapped one slot toward
 * `dir` ('up' moves it earlier, 'down' moves it later). A no-op (a new
 * array with the same order) at either boundary. Never mutates `matchIds`.
 */
export function movePlaylistItem(matchIds: string[], index: number, dir: 'up' | 'down'): string[] {
  const targetIndex = dir === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= matchIds.length || index < 0 || index >= matchIds.length) {
    return [...matchIds];
  }
  const next = [...matchIds];
  const temp = next[index]!;
  next[index] = next[targetIndex]!;
  next[targetIndex] = temp;
  return next;
}
