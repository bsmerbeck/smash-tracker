import { z } from 'zod';

/**
 * `opponents/{uid}` is stored as a set-membership map: keys are lowercased
 * free-text opponent names, values are always the boolean literal `true`
 * (see AddMatchForm.js / EditMatchForm.js: `firebase.set(`/opponents/${uid}/${name}`,
 * true)`). There is no numeric id — the name itself is the identity.
 */
export const opponentMapSchema = z.record(z.string(), z.literal(true));
export type OpponentMap = z.infer<typeof opponentMapSchema>;

/** GET /api/opponents response: the flat list of known opponent names. */
export const opponentListSchema = z.array(z.string());
export type OpponentList = z.infer<typeof opponentListSchema>;

/**
 * `opponents/{uid}/{opponentName}` (and now `opponentAliases/{uid}/{alias}`)
 * both use the free-text opponent name as the literal RTDB key, so it can't
 * contain the characters RTDB reserves for paths (`.`, `#`, `$`, `[`, `]`,
 * `/`) or ASCII control characters. This mirrors match.ts's
 * `opponentNameInputSchema` exactly (trim + lowercase + reject illegal
 * chars) — duplicated here (rather than imported from match.ts) to avoid a
 * cross-file dependency between the two concurrently-owned modules; kept
 * byte-for-byte identical intentionally.
 */
const RTDB_RESERVED_KEY_CHARS = ['.', '#', '$', '[', ']', '/'];

function containsRtdbIllegalChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i);
    if (codePoint !== undefined && codePoint <= 0x1f) {
      return true;
    }
  }
  return RTDB_RESERVED_KEY_CHARS.some((char) => value.includes(char));
}

/**
 * Normalizes a free-text opponent name into its canonical RTDB-safe form:
 * trim, lowercase, and reject characters RTDB reserves for path segments.
 * Reused anywhere an opponent name is read from user input outside of
 * match.ts's own schema (e.g. the alias endpoints below) so both places
 * apply byte-for-byte the same rule that already unifies manual + imported
 * matches (exact lowercased name equality).
 */
export const opponentNameInputSchema = z
  .string()
  .trim()
  .min(1, 'Opponent name is required')
  .transform((value) => value.toLowerCase())
  .refine((value) => !containsRtdbIllegalChar(value), {
    message: 'Opponent name cannot contain . # $ [ ] / or control characters',
  });

/**
 * `opponentAliases/{uid}` — a flat map from an alias opponent name to the
 * canonical opponent name it should be merged into for display/aggregation
 * purposes. Both keys and values are pre-normalized (trimmed/lowercased,
 * RTDB-safe) opponent names, same shape as `opponents/{uid}` keys.
 *
 * Invariant: no alias key may equal its own canonical value (a direct
 * self-cycle) — enforced at write time by the API, not by this schema
 * (schema-level cross-field refinement isn't practical for a `z.record`).
 * Longer cycles are prevented procedurally: writes resolve the requested
 * target through the existing map first (see rtdb.ts's `resolveCanonical`),
 * so a chain can never form — every value in the map is always itself a
 * terminal (non-aliased) name.
 */
export const opponentAliasMapSchema = z.record(z.string(), z.string());
export type OpponentAliasMap = z.infer<typeof opponentAliasMapSchema>;

/**
 * PUT /api/opponents/aliases/:alias body. `canonical` is validated through
 * the same normalizer as the alias itself; the API additionally rejects
 * `alias === canonical` (self-merge) after normalization.
 */
export const upsertOpponentAliasInputSchema = z.object({
  canonical: opponentNameInputSchema,
});
export type UpsertOpponentAliasInput = z.infer<typeof upsertOpponentAliasInputSchema>;

// ---------------------------------------------------------------------------
// V6-W1c: opponent tendency notes
// ---------------------------------------------------------------------------

/** Character limit for each free-text note field — generous for a few paragraphs, cheap to store in RTDB. */
export const OPPONENT_NOTE_TEXT_MAX_LENGTH = 2000;

/** Max number of stage ids a scouting report can flag under "ban these". */
export const OPPONENT_NOTE_BAN_STAGES_MAX = 5;

/**
 * `opponentNotes/{uid}/{canonicalName}` — a single structured scouting note
 * per canonical opponent name (never an alias; the web app resolves aliases
 * to their canonical name via `useFilteredMatches` before a note is ever
 * read or written, same choke point as every other opponent-name consumer).
 * Deliberately structured (not one free-text blob) per the V6 research
 * basis: habits/watch-for are separate free-text fields, and "ban these" is
 * a small set of stage ids rather than more prose to parse.
 */
export const opponentNoteSchema = z.object({
  /** Patterns/tendencies observed, e.g. opening habits, punish routes, recovery mixups. */
  habits: z.string().trim().max(OPPONENT_NOTE_TEXT_MAX_LENGTH).optional(),
  /** Stage ids to strike/ban against this opponent, capped at `OPPONENT_NOTE_BAN_STAGES_MAX`. */
  banThese: z.array(z.number().int().nonnegative()).max(OPPONENT_NOTE_BAN_STAGES_MAX).optional(),
  /** Things to watch for going into the next set, e.g. reads, mind games, tech chases. */
  watchFor: z.string().trim().max(OPPONENT_NOTE_TEXT_MAX_LENGTH).optional(),
  /** Epoch ms of the last save — drives the "saved X ago" timestamp in the UI. */
  updatedAt: z.number().int().nonnegative(),
});
export type OpponentNote = z.infer<typeof opponentNoteSchema>;

/** GET /api/opponent-notes response: canonical name -> note, for every note the user has saved. */
export const opponentNoteMapSchema = z.record(z.string(), opponentNoteSchema);
export type OpponentNoteMap = z.infer<typeof opponentNoteMapSchema>;

/**
 * PUT /api/opponent-notes/:name body. `updatedAt` is intentionally omitted —
 * the API stamps it server-side (matches the `time` field on match records:
 * clients never dictate the server's notion of "now").
 */
export const upsertOpponentNoteInputSchema = opponentNoteSchema.omit({ updatedAt: true });
export type UpsertOpponentNoteInput = z.infer<typeof upsertOpponentNoteInputSchema>;
