import { z } from 'zod';
import { matchStageSchema } from './stage.js';

/**
 * `matchType` is a free-form-looking field that is in practice constrained
 * to a fixed set of radio options in legacy's MatchTypeSelect.js /
 * EditMatchForm's MatchTypeSelect.js. Older records may have an empty
 * string when unset (see MatchTable.js coalescing `m.matchType ? m.matchType
 * : ""`), so `""` is accepted alongside the real options for stored/read
 * shapes.
 */
export const matchTypeValues = [
  'none',
  'quickplay',
  'online-friendly',
  'online-tourney',
  'offline-friendly',
  'offline-tourney',
] as const;
export const matchTypeSchema = z.enum(matchTypeValues);
export type MatchType = z.infer<typeof matchTypeSchema>;

/**
 * A single VOD timestamp note (V7-E): `seconds` is the offset into the VOD
 * to deep-link to, `note` is the free-text callout (e.g. "missed punish on
 * shield"). Lives alongside `vodUrl` on `matchRecordSchema` — user-editable
 * via the same update path (see `createMatchInputSchema`/
 * `updateMatchInputSchema`), unlike the server-only start.gg-sync fields
 * below.
 */
export const vodTimestampSchema = z.object({
  /** Offset in whole seconds into the VOD this note refers to. */
  seconds: z.number().int().min(0),
  /** Free-text callout for this moment, e.g. "missed punish on shield". */
  note: z.string().trim().min(1).max(200),
  /**
   * Note-level tags (TAG-01..05), e.g. preset slugs like 'punish' or
   * freeform custom text. Embedded directly on the timestamp entry rather
   * than referencing a separate tag registry — there is no tags tree,
   * matching the "embedded arrays, no registry" model used for match-level
   * `tags` below. Capped at 5 per note to keep a single moment's tags
   * skimmable. Optional (not `.default([])`): absence means "no tags on
   * this note" for both legacy notes and freshly-created ones, a
   * meaningful, valid state like every other optional field on this
   * schema. Because RTDB silently drops keys holding an empty array on
   * write, sending `tags: []` and omitting `tags` are equivalent on
   * read-back — see `RtdbService.updateMatch`'s clearing-semantics
   * comment.
   */
  tags: z.array(z.string().trim().min(1).max(24)).max(5).optional(),
});
export type VodTimestamp = z.infer<typeof vodTimestampSchema>;

/**
 * `matches/{uid}/{pushKey}` — the stored shape, derived verbatim from
 * legacy AddMatchForm.js `onSaveMatchClick` / EditMatchForm.js
 * `onSaveMatchClick` (both `.set()` the full record — legacy never used
 * `.update()` on matches). Field names are exactly as legacy wrote them and
 * MUST NOT be renamed: production data already exists under these keys.
 *
 * ```js
 * matchRef.set({
 *   fighter_id: playerOne.id,
 *   opponent_id: playerTwo.id,
 *   time: firebase.database.ServerValue.TIMESTAMP,
 *   map: mapDetails, // { id, name }
 *   opponent: opponent,
 *   notes: notes,
 *   matchType: selectedType,
 *   win: result === "win",
 * });
 * ```
 *
 * Older records may be missing `map`, `matchType`, `opponent`, `notes`
 * entirely (legacy readers defensively coalesce these) — modeled here as
 * optional so reads of legacy data don't fail validation.
 */
export const matchRecordSchema = z.object({
  /** SpriteList id of the tracked user's own fighter for this match. */
  fighter_id: z.number().int().positive(),
  /** SpriteList id of the opponent's in-game fighter (character, not the human opponent). */
  opponent_id: z.number().int().positive(),
  /** Unix epoch milliseconds. Written server-side via ServerValue.TIMESTAMP. */
  time: z.number().int().nonnegative(),
  /** Stage the match was played on; `{ id: 0, ... }` means "no selection". */
  map: matchStageSchema.optional(),
  /** Free-text human opponent name, always lowercased by the legacy client. */
  opponent: z.string().optional(),
  /** Free-text notes, legacy soft-capped client-side at 100 chars (not enforced server-side). */
  notes: z.string().optional(),
  matchType: matchTypeSchema.or(z.literal('')).optional(),
  /** true = win, false = loss. */
  win: z.boolean(),
  /**
   * The winner's remaining stock count when the match ended (0-3 for a
   * standard 4-stock game). Optional — legacy data and matches where the
   * player didn't track it omit this entirely.
   */
  stocksLeft: z.number().int().min(0).max(3).optional(),
  /**
   * Where this match came from. Absent on manually-entered matches (all
   * legacy data); 'startgg' on records imported from start.gg tournament
   * sets, 'parrygg' on records imported from parry.gg (V8-A). Set
   * server-side by the sync service only — never accepted from client input
   * (see createMatchInputSchema).
   */
  source: z.enum(['startgg', 'parrygg']).optional(),
  /**
   * Stable idempotency key for imported records, e.g. 'sgg:<setId>:g<n>' or
   * 'pgg-<matchId>-g<n>'. Doubles as the RTDB child key (prefixed) so
   * re-syncs overwrite instead of duplicating.
   */
  externalId: z.string().optional(),
  /** Bracket/event name for imported matches (e.g. "Ultimate Singles"). Server-set. */
  eventName: z.string().optional(),
  /** Tournament name for imported matches (e.g. "The Big House 9"). Server-set. */
  tournamentName: z.string().optional(),
  /**
   * start.gg's human-readable round label for the set this game belonged to
   * (e.g. "Losers Round 2", "Winners Semi-Final"). Server-set, imported
   * matches only.
   */
  roundText: z.string().optional(),
  /**
   * start.gg's `set.round` — a signed integer where negative values mean the
   * losers side of a double-elimination bracket (e.g. -2 = Losers Round 2).
   * Server-set, imported matches only.
   */
  bracketRound: z.number().int().optional(),
  /**
   * The human opponent's seed in the event this match belonged to, when
   * start.gg provides it. Per-event fact about the opponent, intentionally
   * duplicated across every game/match row from that event (RTDB read
   * simplicity beats normalization here). Server-set, imported matches only.
   */
  opponentSeed: z.number().int().positive().optional(),
  /**
   * The human opponent's final placement in the event this match belonged
   * to, when start.gg provides it. Same per-event duplication rationale as
   * `opponentSeed`. Server-set, imported matches only.
   */
  opponentPlacement: z.number().int().positive().optional(),
  /**
   * The human opponent's start.gg profile slug (e.g. "user/9fb774ae"), when
   * start.gg provides it. Same per-event duplication rationale as
   * `opponentSeed`. Server-set, imported matches only.
   */
  opponentUserSlug: z.string().optional(),
  /**
   * URL of a VOD for the set this game belonged to. Originally populated
   * only by start.gg's TO-curated `Set.vodUrl` (verified via the V6-W1b
   * probe to exist but be null on essentially every real set sampled,
   * including majors' streamed Grand Finals; duplicated across every game of
   * the set, same rationale as `opponentSeed`/`opponentPlacement`) — as of
   * V7-E, also user-editable directly (see `createMatchInputSchema` /
   * `updateMatchInputSchema`), so players can attach a VOD link themselves
   * when the TO never does.
   */
  vodUrl: z.string().url().optional(),
  /**
   * User-authored VOD timestamp notes (V7-E), e.g. "2:41 — missed punish on
   * shield". Unlike the start.gg-only fields above, this is set entirely by
   * the player via the update path — capped at 20 entries per match so a
   * single game's notes stay skimmable.
   */
  vodTimestamps: z.array(vodTimestampSchema).max(20).optional(),
  /**
   * User-set offset (whole seconds) into the match's VOD where this match
   * begins — takes precedence over any `t=`/`start=` param in `vodUrl` (see
   * `parseVodStartSeconds` on the web). Lets an entire event recorded as ONE
   * video be shared by several matches: the player types each match's start
   * time once instead of hand-editing the URL's query param. Same
   * user-editable / conditional-spread convention as `vodUrl`/`vodTimestamps`.
   */
  vodStartSeconds: z.number().int().nonnegative().optional(),
  /**
   * Post-match GSP (Global Smash Power) reading, as shown on the in-game
   * results screen (V10). Only meaningful for online matches — GSP is
   * per-fighter, so a series of these across matches sharing `fighter_id`
   * traces that fighter's GSP over time (see `gsp.ts`'s `getGspSeries`).
   * User-editable, same optional/conditional-spread convention as
   * `stocksLeft`.
   */
  gsp: z.number().int().min(0).optional(),
  /**
   * Match-level tags (TAG-01..05), e.g. preset slugs like
   * 'practice-friendlies' or freeform custom text the player types. Stored
   * as a plain embedded array on the match record — there is no separate
   * tags tree/registry to keep in sync, so deleting a match cascades tag
   * removal for free. Capped at 10 per match. User-editable, same
   * optional/conditional-spread convention as `vodTimestamps`/
   * `vodStartSeconds`/`gsp` (see `createMatchInputSchema` /
   * `RtdbService.createMatch`/`updateMatch`). Deliberately `.optional()`,
   * NOT `.default([])`: this is a read schema over records that predate
   * the field, and absence (legacy/untagged matches) is a meaningful,
   * valid state — unlike `stageFavoritesSchema`'s single always-present
   * document, where `.default([])` is correct. RTDB silently drops keys
   * holding an empty array on write, so `tags: []` and an omitted `tags`
   * key are equivalent on read-back.
   */
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
});
export type MatchRecord = z.infer<typeof matchRecordSchema>;

/**
 * A match record as returned by the API, with its RTDB push key surfaced as
 * `id` (legacy attached this as `key` client-side; the API calls it `id`).
 */
export const matchSchema = matchRecordSchema.extend({
  id: z.string().min(1),
});
export type Match = z.infer<typeof matchSchema>;

/**
 * `opponents/{uid}/{opponentName}` uses the name as the literal RTDB key
 * (see opponent.ts), so it can't contain the characters RTDB reserves for
 * paths (`.`, `#`, `$`, `[`, `]`, `/`) or ASCII control characters. Legacy's
 * `AddMatchForm.js`/`EditMatchForm.js` always lowercase the name client-side
 * before writing (`updateOpponent`); the API is the sole write path now, so
 * this schema normalizes (trim + lowercase) and validates server-side too —
 * it must not rely on every caller replicating that client-side behavior.
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
 * Opponent name for match entry where the opponent may legitimately be
 * anonymous — online quickplay (the GSP logger, V10) matches you against
 * random players whose tag you never see. Trims + lowercases + rejects
 * RTDB-illegal characters when a name IS given, but a blank/whitespace
 * string transforms to `undefined` (→ omitted from the stored record, whose
 * `opponent` is already optional) instead of failing validation. Manual
 * entry keeps its own client-side name requirement (MatchForm/SetWizard).
 */
const optionalOpponentNameInputSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .refine((value) => !containsRtdbIllegalChar(value), {
    message: 'Opponent name cannot contain . # $ [ ] / or control characters',
  })
  .transform((value) => (value ? value : undefined));

/**
 * A trimmed, 1-80 char optional free-text name field (`eventName` /
 * `tournamentName` on manual entry). An empty/whitespace-only string — the
 * shape a blank, untouched form field submits as — transforms to
 * `undefined` so the key is omitted from the parsed result entirely, rather
 * than sending `''` through to RTDB (which rejects `undefined` values on
 * write, but would happily persist a meaningless empty string).
 */
const optionalNameInputSchema = z
  .string()
  .trim()
  .max(80, 'Limit 80 characters')
  .optional()
  .transform((value) => (value ? value : undefined))
  .optional();

/**
 * POST /api/matches body. `time` is set server-side (mirrors legacy's use of
 * ServerValue.TIMESTAMP) so it is not accepted from the client. `map` is
 * required on create to match legacy's always-present mapDetails object
 * (defaulting to `{ id: 0, name: "no selection" }` client-side); callers
 * that don't have a stage should send that same sentinel.
 *
 * `stocksLeft`/`eventName`/`tournamentName` are optional manual-entry
 * additions (set wizard + tournament hint fields) — `source`/`externalId`
 * remain server-set only (see `matchRecordSchema`) and are intentionally
 * NOT accepted here.
 *
 * `vodUrl`/`vodTimestamps`/`vodStartSeconds` (V7-E) are user-editable here
 * too — omitting a field (rather than sending it) is how a caller clears it,
 * following the same full-overwrite + conditional-spread convention as
 * `stocksLeft`/`eventName`/`tournamentName` (see `RtdbService.updateMatch`).
 *
 * `gsp` (V10) follows the same convention — omit to leave/clear it.
 *
 * `tags` (TAG-01..05) follows the same convention too — omit (or send an
 * empty array) to leave/clear match-level tags. Note-level tags ride
 * inside each `vodTimestamps` entry (see `vodTimestampSchema.tags`) and
 * need no separate handling here since `vodTimestamps` is already passed
 * through wholesale.
 */
export const createMatchInputSchema = z.object({
  fighter_id: z.number().int().positive(),
  opponent_id: z.number().int().positive(),
  map: matchStageSchema,
  opponent: optionalOpponentNameInputSchema,
  notes: z.string().default(''),
  matchType: matchTypeSchema,
  win: z.boolean(),
  stocksLeft: z.number().int().min(0).max(3).optional(),
  eventName: optionalNameInputSchema,
  tournamentName: optionalNameInputSchema,
  vodUrl: z.string().url().optional(),
  vodTimestamps: z.array(vodTimestampSchema).max(20).optional(),
  vodStartSeconds: z.number().int().nonnegative().optional(),
  gsp: z.number().int().min(0).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
});
export type CreateMatchInput = z.infer<typeof createMatchInputSchema>;

/**
 * PATCH /api/matches/:id body. Legacy's edit form always re-`.set()`s every
 * field (full overwrite), so the API accepts the same full set of fields as
 * create; PATCH semantics here mean "identify by id in the URL", not
 * "partial update" — full field set is still required to keep behavior
 * identical to legacy's edit form.
 */
export const updateMatchInputSchema = createMatchInputSchema;
export type UpdateMatchInput = z.infer<typeof updateMatchInputSchema>;
