import { z } from 'zod';

/**
 * VOD Manager overhaul: `playlists/{uid}/{pushKey}` — user-curated ordered
 * collections of match ids, letting a player group footage the way they
 * actually think about their own play (e.g. "combo reel", "counterpick
 * reviews") rather than only by opponent/date/tag.
 *
 * `matchIds` preserves insertion/reorder order chosen by the user — same
 * "array doubles as priority order" convention as `stageFavoritesSchema`.
 * `.default([])` on the READ schema matters: RTDB silently drops empty
 * arrays on write, so a playlist emptied to zero matches reads back as
 * `{ name, createdAt }` with no `matchIds` key at all (same lesson as
 * `stageFavorites.ts`).
 */

/** Max playlists a single user may create. */
export const MAX_PLAYLISTS_PER_USER = 50;
/** Max matches a single playlist may hold. */
export const MAX_PLAYLIST_MATCHES = 100;

/** `playlists/{uid}/{pushKey}` — a playlist record as stored in RTDB. */
export const playlistRecordSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** Epoch ms the playlist was created — server-stamped on create. */
  createdAt: z.number().int().nonnegative(),
  /** Match ids in user-chosen (insertion/reorder) order. */
  matchIds: z.array(z.string().min(1)).max(MAX_PLAYLIST_MATCHES).default([]),
});
export type PlaylistRecord = z.infer<typeof playlistRecordSchema>;

/** A playlist with its RTDB push key, as returned by the API. */
export const playlistSchema = playlistRecordSchema.extend({
  id: z.string(),
});
export type Playlist = z.infer<typeof playlistSchema>;

/** POST /api/playlists body — `createdAt` is server-stamped, `matchIds` starts empty. */
export const createPlaylistInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
});
export type CreatePlaylistInput = z.infer<typeof createPlaylistInputSchema>;

/**
 * PATCH /api/playlists/:id body — name and/or matchIds, both optional so a
 * rename-only or reorder-only call doesn't have to resend the other field
 * (the service merges against the current record; see RtdbService.updatePlaylist).
 */
export const updatePlaylistInputSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  matchIds: z.array(z.string().min(1)).max(MAX_PLAYLIST_MATCHES).optional(),
});
export type UpdatePlaylistInput = z.infer<typeof updatePlaylistInputSchema>;
