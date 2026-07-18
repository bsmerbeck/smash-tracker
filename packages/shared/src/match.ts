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
  /**
   * Free-text callout for this moment, e.g. "missed punish on shield".
   * Deliberately allows an empty string: the VOD Manager's quick-tag flow
   * (QuickTagPanel) captures a timestamp + tags instantly with no note text
   * — a tag-only moment is a legitimate, valid entry, not an error.
   */
  note: z.string().trim().max(200),
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

/**
 * Phase 8 (Coaching Edit Sessions): attribution stamped on a timestamp note
 * written by an edit-tier share's coach, rather than the match owner.
 * `sessionId` is the coach's per-browser localStorage uuid (not a real
 * account) — see `apps/web/src/lib/coachSession.ts` (a later 08-0x plan) for
 * the generation side. `.nullish()`: absent means "an owner-authored note,"
 * per the RTDB null-stripping convention (CONCERNS.md).
 */
export const coachAttributionSchema = z.object({
  sessionId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(60),
});
export type CoachAttribution = z.infer<typeof coachAttributionSchema>;

/**
 * Phase 8: the id-bearing, normalized shape every `VodTimestamp` reader
 * actually sees after `matchRecordSchema`'s dual-read preprocess runs (see
 * `normalizeVodTimestampsNode` below). Extends the base `vodTimestampSchema`
 * (never redeclares its caps — RESEARCH Pitfall 5) with a stable `id`
 * (synthesized for legacy array entries, the RTDB push key for keyed-subtree
 * entries) and an optional `coach` attribution (absent = owner-authored).
 */
export const vodTimestampEntrySchema = vodTimestampSchema.extend({
  id: z.string(),
  coach: coachAttributionSchema.nullish(),
});
export type VodTimestamp = z.infer<typeof vodTimestampEntrySchema>;

/**
 * Phase 8 dual-read normalizer for the `vodTimestamps` node. Accepts EITHER
 * shape the node has ever been stored in:
 * - a legacy dense JS array (every record written before this migration) —
 *   each element gets a synthesized `id` of `legacy-<index>` (display-stable
 *   within a single read only; a record migrates to the keyed shape the
 *   first time its notes are written post-deploy).
 * - a keyed push-key subtree (`{ [pushKey]: VodTimestamp }`) — each value's
 *   own RTDB key becomes its `id`, and any `coach` attribution rides through
 *   unchanged.
 *
 * `null`/`undefined` normalizes to `[]`. Every entry is `safeParse`d through
 * `vodTimestampEntrySchema` (inheriting the 200-char/5-tag caps), and a
 * malformed or over-cap entry is SKIPPED — never thrown on (review CR-02).
 * This normalizer runs inside `matchRecordSchema`'s `z.preprocess`, and in
 * Zod v4 an exception thrown inside a preprocess callback is NOT converted
 * into a validation issue: it propagates straight out of `safeParse`,
 * bypassing every safeParse-and-skip guard downstream (`listMatches`,
 * `getEditSessionByToken`) and 500ing the whole request for one corrupt
 * entry — the exact incident class the safeParse-and-skip production rule
 * exists for. The shared read normalizer is therefore TOTAL: strictness for
 * bad note data is enforced at the write boundaries (the note endpoints'
 * body schemas), never here on the read path.
 *
 * The result is ALWAYS sorted by `seconds` ascending before returning —
 * unconditional, not inherited from write-time ordering, because a keyed
 * object's key-iteration order tracks push-key CREATION time, not
 * `seconds` (a coach can add an earlier-seconds note after a later one
 * already exists). Exported for reuse by the API note-cap transaction and
 * the coach edit-session read (later 08-0x plans) — the single
 * discriminator implementation in this codebase.
 */
export function normalizeVodTimestampsNode(raw: unknown): VodTimestamp[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  let rawEntries: Array<[string, unknown]>;
  if (Array.isArray(raw)) {
    // Legacy dense array — includes RTDB's array-coercion edge where a
    // mostly-numeric keyed node comes back as an array with `null` holes;
    // those holes fail the per-entry safeParse below and are skipped.
    rawEntries = raw.map((element, index): [string, unknown] => [`legacy-${index}`, element]);
  } else if (typeof raw === 'object') {
    rawEntries = Object.entries(raw as Record<string, unknown>);
  } else {
    // A scalar node is wholesale corrupt — nothing salvageable.
    return [];
  }

  const entries = rawEntries.flatMap(([key, value]): VodTimestamp[] => {
    const parsed = vodTimestampEntrySchema.safeParse({
      ...(typeof value === 'object' && value !== null ? value : {}),
      id: key,
    });
    if (!parsed.success) {
      // Skip-and-report, never throw (review CR-02) — key only, no values.
      // (Guarded globalThis access: this package compiles without dom/node
      // libs, so `console` isn't a typed global here.)
      (globalThis as { console?: { warn(message: string): void } }).console?.warn(
        `normalizeVodTimestampsNode: skipping corrupt note entry ${key}`,
      );
      return [];
    }
    return [parsed.data];
  });
  return entries.sort((a, b) => a.seconds - b.seconds);
}

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
   * Walkthrough round 3 (07-11): the human opponent's parry.gg user id (a
   * UUID), when parry.gg provides it — the parry.gg equivalent of
   * `opponentUserSlug` (start.gg has no numeric/slug user id parity, so this
   * is a separate field rather than a reused one). Same per-event
   * duplication rationale as `opponentSeed`/`opponentUserSlug`. Server-set,
   * imported matches only (`apps/api/src/parrygg/sync.ts`). Feeds
   * `buildRecapOpponentUrl`'s parry.gg profile-link branch
   * (`https://parry.gg/profile/{id}`).
   */
  opponentParryUserId: z.string().optional(),
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
   * shield". Capped at 20 entries per match so a single game's notes stay
   * skimmable.
   *
   * Phase 8 (Coaching Edit Sessions): this is now a DUAL-READ field — the
   * raw RTDB node is either a legacy dense array or a keyed push-key
   * subtree (see `normalizeVodTimestampsNode`'s doc comment). The
   * `z.preprocess` below reshapes+sorts the raw node (guarding
   * null/undefined so the field itself stays optional/absent, never
   * fabricating `[]`) before the normal `z.array(...)` validation runs, so
   * every existing reader keeps seeing a plain, stable-sorted, id-bearing
   * `VodTimestamp[]` with zero call-site changes. `createMatchInputSchema`/
   * `updateMatchInputSchema` no longer accept this field from the client at
   * all — note writes now go through dedicated note endpoints (owner and
   * coach), never the match-fact PATCH path (see `RtdbService.updateMatch`'s
   * unconditional carry-through of `current.vodTimestamps`).
   */
  vodTimestamps: z.preprocess(
    (raw) => (raw === null || raw === undefined ? undefined : normalizeVodTimestampsNode(raw)),
    z.array(vodTimestampEntrySchema).max(20).optional(),
  ),
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
 *
 * `vodTimestamps` is re-declared here as a PLAIN (non-preprocess) array
 * schema, overriding the `z.preprocess`-wrapped field it would otherwise
 * inherit from `matchRecordSchema`. `matchSchema` is used ONLY as a Fastify
 * response schema — `fastify-type-provider-zod`'s `serializerCompiler`
 * encodes outgoing data via Zod v4's `safeEncode`, never `safeParse`, and a
 * `z.preprocess` transform is decode-only: encoding through it throws
 * `ZodEncodeError: Encountered unidirectional transform during encode`
 * (discovered as the root cause of every PATCH/GET/POST /api/matches 500
 * once 08-01 wrapped `vodTimestamps` in `z.preprocess`). The object handed
 * to this schema for serialization is always an already-normalized `Match`
 * (built from `matchRecordSchema.parse`/`safeParse` over the raw RTDB node
 * earlier in the request), so no re-normalization is needed on the way out
 * — a plain array schema is both correct and encode-safe here.
 * `matchRecordSchema` itself keeps the preprocess version unchanged, since
 * every one of ITS callers parses raw RTDB data (decode direction only).
 */
export const matchSchema = matchRecordSchema.extend({
  id: z.string().min(1),
  vodTimestamps: z.array(vodTimestampEntrySchema).max(20).optional(),
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
 * `vodUrl`/`vodStartSeconds` (V7-E) are user-editable here too — omitting a
 * field (rather than sending it) is how a caller clears it, following the
 * same full-overwrite + conditional-spread convention as
 * `stocksLeft`/`eventName`/`tournamentName` (see `RtdbService.updateMatch`).
 *
 * `gsp` (V10) follows the same convention — omit to leave/clear it.
 *
 * `tags` (TAG-01..05) follows the same convention too — omit (or send an
 * empty array) to leave/clear match-level tags.
 *
 * Phase 8 (Coaching Edit Sessions): `vodTimestamps` is deliberately NOT
 * accepted here anymore. Notes are now server-preserved across every
 * match-fact PATCH (`RtdbService.updateMatch` carries `current.vodTimestamps`
 * through unconditionally) and are written exclusively via dedicated note
 * endpoints (owner and coach) — the client can no longer influence the notes
 * node through this create/update path at all.
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
 *
 * Phase 8: same as `createMatchInputSchema`, `vodTimestamps` is not accepted
 * here — see that schema's doc comment above.
 */
export const updateMatchInputSchema = createMatchInputSchema;
export type UpdateMatchInput = z.infer<typeof updateMatchInputSchema>;
