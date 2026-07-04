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
