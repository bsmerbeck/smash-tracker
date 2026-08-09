import { z } from 'zod';

/**
 * Minimal start.gg GraphQL client (https://api.start.gg/gql/alpha).
 * Rate limits: 80 req/60s, max 1000 objects per request — the sets query
 * below keeps perPage small enough to stay comfortably under both.
 */
const STARTGG_GQL_URL = 'https://api.start.gg/gql/alpha';

export const SSBU_VIDEOGAME_ID = 1386;

/**
 * Cap on the non-2xx response body excerpt captured onto
 * `StartggApiError.responseBody`. start.gg signals both its rate-limit
 * rejection and its query-complexity rejection with a documented JSON body,
 * and the two demand opposite responses — wait and retry versus fail
 * immediately and shrink the query. Discarding the body made those two
 * indistinguishable at the transport boundary (review C-H10). Capped so an
 * unexpected HTML error page can never bloat a log line or an error object.
 */
export const STARTGG_ERROR_BODY_EXCERPT_MAX = 1000;

export class StartggApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * The raw `Retry-After` response header when start.gg sent one —
     * start.gg's published rate-limit documentation does not promise this
     * header, so every consumer must treat it as opportunistic and have a
     * header-independent fallback (see `30-RESEARCH.md` Pitfall 4).
     */
    readonly retryAfter?: string,
    /**
     * A bounded excerpt (see `STARTGG_ERROR_BODY_EXCERPT_MAX`) of the
     * non-2xx response body. start.gg signals BOTH its rate-limit rejection
     * and its query-complexity rejection with a documented body, and the two
     * demand opposite responses — wait and retry versus fail immediately and
     * shrink the query. Discarding the body made those two indistinguishable
     * at the transport boundary (review C-H10).
     */
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'StartggApiError';
  }
}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(STARTGG_GQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    // Read the body defensively — a rejecting `text()` (e.g. a body already
    // consumed, or a transport-level read failure) must never turn a
    // provider error into a different error; it degrades to `undefined`.
    let excerpt: string | undefined;
    try {
      const text = await response.text();
      excerpt = text.slice(0, STARTGG_ERROR_BODY_EXCERPT_MAX);
    } catch {
      excerpt = undefined;
    }
    // The message text is the ONLY thing existing callers and existing
    // tests observe on this path — it MUST stay byte-identical to the
    // pre-existing status-only format, or this becomes a behavior change to
    // the legacy personal-sync path this phase otherwise locks against
    // drift (researchQueryLock.test.ts).
    throw new StartggApiError(
      `start.gg API returned ${response.status}`,
      response.status,
      response.headers.get('retry-after') ?? undefined,
      excerpt,
    );
  }
  const body = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new StartggApiError(body.errors.map((e) => e.message).join('; '));
  }
  return schema.parse(body.data);
}

// ---- currentUser (OAuth identity) -----------------------------------------

const currentUserSchema = z.object({
  currentUser: z.object({
    id: z.number().int().positive(),
    slug: z.string().min(1),
    email: z.string().nullish(),
    player: z.object({
      id: z.number().int().positive(),
      gamerTag: z.string().min(1),
    }),
  }),
});
export type StartggCurrentUser = z.infer<typeof currentUserSchema>['currentUser'];

/** Identity of the user who granted the OAuth token (scopes user.identity + user.email). */
export async function fetchCurrentUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StartggCurrentUser> {
  const data = await gql(
    accessToken,
    `query { currentUser { id slug email player { id gamerTag } } }`,
    {},
    currentUserSchema,
    fetchImpl,
  );
  return data.currentUser;
}

// ---- player identity resolution (public data, server token) ---------------
// Verified via read-only probe queries against api.start.gg (V7-A scouting
// work): both shapes below returned real data for player id 1802316 / user
// slug "user/07dc2239" (gamerTag "Pandem1c").

const resolveBySlugSchema = z.object({
  user: z
    .object({
      id: z.number().int().positive(),
      slug: z.string().min(1),
      player: z.object({ id: z.number().int().positive(), gamerTag: z.string().min(1) }).nullish(),
    })
    .nullish(),
});

/**
 * Resolves a start.gg profile slug (e.g. "user/07dc2239") to a player
 * identity. Returns null when the slug doesn't resolve to a user, or the
 * user has no linked player profile (e.g. a spectator-only account).
 */
export async function resolvePlayerBySlug(
  serverToken: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; gamerTag: string; userSlug: string } | null> {
  const data = await gql(
    serverToken,
    `query ResolveBySlug($slug: String) {
      user(slug: $slug) { id slug player { id gamerTag } }
    }`,
    { slug },
    resolveBySlugSchema,
    fetchImpl,
  );
  const player = data.user?.player;
  if (!data.user || !player) {
    return null;
  }
  return { id: player.id, gamerTag: player.gamerTag, userSlug: data.user.slug };
}

const resolveByIdSchema = z.object({
  player: z
    .object({
      id: z.number().int().positive(),
      gamerTag: z.string().min(1),
      user: z.object({ id: z.number().int().positive(), slug: z.string().min(1) }).nullish(),
    })
    .nullish(),
});

/**
 * Resolves a numeric start.gg player id directly. Returns null when the id
 * doesn't resolve to a player. `userSlug` is absent when start.gg has no
 * linked user profile for the player (rare, but the field is nullish).
 */
export async function resolvePlayerById(
  serverToken: string,
  playerId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; gamerTag: string; userSlug?: string } | null> {
  const data = await gql(
    serverToken,
    `query ResolveById($id: ID!) {
      player(id: $id) { id gamerTag user { id slug } }
    }`,
    { id: playerId },
    resolveByIdSchema,
    fetchImpl,
  );
  const player = data.player;
  if (!player) {
    return null;
  }
  return {
    id: player.id,
    gamerTag: player.gamerTag,
    ...(player.user?.slug ? { userSlug: player.user.slug } : {}),
  };
}

// ---- player sets (public data, server token) --------------------------------

const setsPageSchema = z.object({
  player: z
    .object({
      sets: z
        .object({
          pageInfo: z.object({ totalPages: z.number().int().nonnegative() }),
          nodes: z.array(
            z.object({
              id: z.union([z.number(), z.string()]),
              completedAt: z.number().int().nullish(),
              /** Human-readable round label, e.g. "Losers Round 2". */
              fullRoundText: z.string().nullish(),
              /** Signed bracket round; negative = losers side. */
              round: z.number().int().nullish(),
              /** Literally the string "DQ" for sets decided by disqualification. */
              displayScore: z.string().nullish(),
              totalGames: z.number().int().nullish(),
              /**
               * URL of a VOD for this set, when a TO has attached one.
               * Confirmed via schema introspection during the V6-W1b probe
               * ("Url of a VOD for this set") but observed null on every
               * sampled set, including majors' streamed Grand Finals — TOs
               * rarely populate it in practice. Harvested anyway since it's
               * free and additive; applies to every game of the set.
               */
              vodUrl: z.string().nullish(),
              event: z
                .object({
                  id: z.number().nullish(),
                  name: z.string().nullish(),
                  /** Event slug, e.g. "tournament/the-big-house-9/event/ultimate-singles" — used to deep-link scouted recent events (V9-B). */
                  slug: z.string().nullish(),
                  isOnline: z.boolean().nullish(),
                  numEntrants: z.number().int().nullish(),
                  videogame: z.object({ id: z.number() }).nullish(),
                  tournament: z.object({ name: z.string().nullish() }).nullish(),
                })
                .nullish(),
              slots: z
                .array(
                  z
                    .object({
                      entrant: z
                        .object({
                          id: z.number(),
                          name: z.string().nullish(),
                          participants: z
                            .array(
                              z
                                .object({
                                  player: z
                                    .object({ id: z.number(), gamerTag: z.string().nullish() })
                                    .nullish(),
                                  user: z.object({ slug: z.string().nullish() }).nullish(),
                                })
                                .nullish(),
                            )
                            .nullish(),
                          seeds: z
                            .array(z.object({ seedNum: z.number().int().nullish() }).nullish())
                            .nullish(),
                          standing: z.object({ placement: z.number().int().nullish() }).nullish(),
                        })
                        .nullish(),
                    })
                    .nullish(),
                )
                .nullish(),
              games: z
                .array(
                  z.object({
                    winnerId: z.number().nullish(),
                    /**
                     * `id` is start.gg's stable, global numeric stage id
                     * (verified via the V6-W1b probe: the same stage
                     * consistently returns the same id across unrelated
                     * sets/events/years). `name` remains for the
                     * name-resolution fallback in `resolveStage`.
                     */
                    stage: z
                      .object({ id: z.union([z.number(), z.string()]).nullish(), name: z.string() })
                      .nullish(),
                    selections: z
                      .array(
                        z.object({
                          character: z.object({ id: z.number() }).nullish(),
                          entrant: z.object({ id: z.number() }).nullish(),
                        }),
                      )
                      .nullish(),
                    /**
                     * Score of entrant1/entrant2 in this game — per
                     * start.gg's own field description, "For smash, this is
                     * equivalent to stocks remaining." Verified during the
                     * V6-W1b probe: positionally corresponds to
                     * `slots[0]`/`slots[1]`, ranges 0-3, and the winner's
                     * value is always strictly greater than the loser's
                     * when both are present (frequently both are null —
                     * stock counts aren't tracked for every set).
                     */
                    entrant1Score: z.number().int().nullish(),
                    entrant2Score: z.number().int().nullish(),
                  }),
                )
                .nullish(),
            }),
          ),
        })
        .nullish(),
    })
    .nullish(),
});
export type StartggSetsPage = z.infer<typeof setsPageSchema>;
export type StartggSet = NonNullable<
  NonNullable<StartggSetsPage['player']>['sets']
>['nodes'][number];

// Complexity budget per page (perPage 10): ~10 sets x (2 slots x ~4 fields +
// ~5 games x 5 fields + ~9 set/event fields) stays well under the 1000
// object limit — nowhere near the ~200 objects/page this shape produces.
const SETS_QUERY = `query PlayerSets($playerId: ID!, $page: Int!, $perPage: Int!) {
  player(id: $playerId) {
    sets(perPage: $perPage, page: $page) {
      pageInfo { totalPages }
      nodes {
        id
        completedAt
        fullRoundText
        round
        displayScore
        totalGames
        vodUrl
        event { id name slug isOnline numEntrants videogame { id } tournament { name } }
        slots {
          entrant {
            id
            name
            participants { player { id gamerTag } user { slug } }
            seeds { seedNum }
            standing { placement }
          }
        }
        games {
          winnerId
          stage { id name }
          selections { character { id } entrant { id } }
          entrant1Score
          entrant2Score
        }
      }
    }
  }
}`;

/** One page of a player's sets (newest first per start.gg default ordering). */
export async function fetchPlayerSetsPage(
  serverToken: string,
  playerId: number,
  page: number,
  perPage = 10,
  fetchImpl: typeof fetch = fetch,
): Promise<{ totalPages: number; sets: StartggSet[] }> {
  const data = await gql(
    serverToken,
    SETS_QUERY,
    { playerId, page, perPage },
    setsPageSchema,
    fetchImpl,
  );
  const sets = data.player?.sets;
  return { totalPages: sets?.pageInfo.totalPages ?? 0, sets: sets?.nodes ?? [] };
}

// ---- research sets (lossless backfill, public data, server token) ----------
// Phase 30 (ING-01/04/06): a NEW query variant, not a fork of the client
// above and not a rewrite of SETS_QUERY/fetchPlayerSetsPage — those stay
// byte-unchanged for the legacy bounded personal sync (see
// researchQueryLock.test.ts). This section adds the lossless shape the
// research backfill needs: bye slots, DQ booleans, set state, and a
// high-water `updatedAfter` filter for correction re-reads.

const researchSetsPageSchema = z.object({
  player: z
    .object({
      sets: z
        .object({
          pageInfo: z.object({ totalPages: z.number().int().nonnegative() }),
          nodes: z.array(
            z.object({
              id: z.union([z.number(), z.string()]),
              /**
               * Undocumented integer state code (30-RESEARCH.md Open
               * Question 1 / Assumption A2) — a SECONDARY signal behind
               * `completedAt`/`games`/`isDisqualified` until the live probe
               * (Task 3) records the observed vocabulary.
               */
              state: z.number().int().nullish(),
              completedAt: z.number().int().nullish(),
              createdAt: z.number().int().nullish(),
              updatedAt: z.number().int().nullish(),
              fullRoundText: z.string().nullish(),
              round: z.number().int().nullish(),
              displayScore: z.string().nullish(),
              totalGames: z.number().int().nullish(),
              vodUrl: z.string().nullish(),
              /** Provider set identifier string, distinct from `id` — a gap-detection aid. */
              identifier: z.string().nullish(),
              event: z
                .object({
                  id: z.number().nullish(),
                  name: z.string().nullish(),
                  slug: z.string().nullish(),
                  isOnline: z.boolean().nullish(),
                  numEntrants: z.number().int().nullish(),
                  /** Undocumented event-type integer (30-RESEARCH.md Tertiary source) — not relied on for eligibility. */
                  type: z.number().int().nullish(),
                  videogame: z.object({ id: z.number() }).nullish(),
                  tournament: z
                    .object({
                      id: z.number().nullish(),
                      name: z.string().nullish(),
                      slug: z.string().nullish(),
                    })
                    .nullish(),
                })
                .nullish(),
              slots: z
                .array(
                  z
                    .object({
                      // A bye slot arrives with a null/absent entrant — this
                      // must survive parsing, not be rejected (ING-04).
                      entrant: z
                        .object({
                          id: z.number(),
                          name: z.string().nullish(),
                          /** Structural DQ signal (30-RESEARCH.md Pitfall 3) — primary over `displayScore`. */
                          isDisqualified: z.boolean().nullish(),
                          initialSeedNum: z.number().int().nullish(),
                          participants: z
                            .array(
                              z
                                .object({
                                  player: z
                                    .object({ id: z.number(), gamerTag: z.string().nullish() })
                                    .nullish(),
                                  user: z.object({ slug: z.string().nullish() }).nullish(),
                                })
                                .nullish(),
                            )
                            .nullish(),
                          seeds: z
                            .array(z.object({ seedNum: z.number().int().nullish() }).nullish())
                            .nullish(),
                          standing: z.object({ placement: z.number().int().nullish() }).nullish(),
                        })
                        .nullish(),
                    })
                    .nullish(),
                )
                .nullish(),
              games: z
                .array(
                  z.object({
                    id: z.union([z.number(), z.string()]).nullish(),
                    winnerId: z.number().nullish(),
                    stage: z
                      .object({ id: z.union([z.number(), z.string()]).nullish(), name: z.string() })
                      .nullish(),
                    selections: z
                      .array(
                        z.object({
                          character: z.object({ id: z.number() }).nullish(),
                          entrant: z.object({ id: z.number() }).nullish(),
                        }),
                      )
                      .nullish(),
                    entrant1Score: z.number().int().nullish(),
                    entrant2Score: z.number().int().nullish(),
                  }),
                )
                .nullish(),
            }),
          ),
        })
        .nullish(),
    })
    .nullish(),
});
export type StartggResearchSetsPage = z.infer<typeof researchSetsPageSchema>;
export type StartggResearchSet = NonNullable<
  NonNullable<StartggResearchSetsPage['player']>['sets']
>['nodes'][number];

/**
 * Filters accepted by the research backfill's `player.sets` fetch.
 * `showByes` is documented purely so a future caller cannot assume the
 * provider's default matches ours — the query text below hard-codes
 * `showByes: true` unconditionally (a bye-blind backfill silently
 * undercounts discovered sets, per 30-RESEARCH.md), so this member is
 * never actually plumbed as a variable. `updatedAfter` is ING-06's
 * high-water reread mechanism — the only overlap primitive the provider
 * exposes on this query.
 *
 * Deliberately has NO entrant-size member: singles/doubles eligibility is
 * decided client-side by 30-03's classifier (30-RESEARCH.md Pitfall 1/2),
 * and the only entrant-size REQUEST this codebase can issue is the
 * probe-only variant below (review C2-A1) — `RESEARCH_SETS_QUERY` cannot
 * express it, by design.
 */
export interface ResearchSetsFilters {
  showByes?: boolean;
  updatedAfter?: number;
}

// Complexity budget: this shape adds `isDisqualified`/`initialSeedNum` per
// entrant, `state`/`createdAt`/`updatedAt`/`identifier` per set, fuller
// event/tournament identity, and `game.id` on top of the legacy SETS_QUERY's
// already-budgeted ~200 objects/page at `perPage: 10` — still comfortably
// under the 1000-object-per-request cap by rough estimate — but the live
// probe (2026-08-08, player 1004/Hungrybox, 15,590 sets) answered Open
// Question 2 the hard way: at perPage 10 this shape sits ON the budget
// cliff, and start.gg enforces the budget by SILENTLY CLIPPING node lists
// (10 -> 5 -> 0 across consecutive pages, with totalPages collapsing to 0
// on a fully clipped page) instead of returning its documented over-budget
// rejection. Clipped rows are unrecoverable at the next page offset.
// perPage 5 returned full pages everywhere, including the page that clipped
// at 10 and a deep page (200); perPage 3 likewise. RESEARCH_SETS_PER_PAGE
// is therefore pinned at 5, and fetchResearchSetsPage refuses short
// non-final pages (see the guard below) so a future shape/budget shift can
// never silently under-ingest again.
// `SetFilters` exposes no videogame filter (30-RESEARCH.md Anti-Pattern), so
// SSBU eligibility is decided client-side by 30-03's classifier — this query
// deliberately returns the player's full cross-game history.
const RESEARCH_SETS_QUERY = `query ResearchPlayerSets($playerId: ID!, $page: Int!, $perPage: Int!, $updatedAfter: Timestamp) {
  player(id: $playerId) {
    sets(perPage: $perPage, page: $page, filters: { showByes: true, updatedAfter: $updatedAfter }) {
      pageInfo { totalPages }
      nodes {
        id
        state
        completedAt
        createdAt
        updatedAt
        fullRoundText
        round
        displayScore
        totalGames
        vodUrl
        identifier
        event {
          id name slug isOnline numEntrants type
          videogame { id }
          tournament { id name slug }
        }
        slots {
          entrant {
            id
            name
            isDisqualified
            initialSeedNum
            participants { player { id gamerTag } user { slug } }
            seeds { seedNum }
            standing { placement }
          }
        }
        games {
          id
          winnerId
          stage { id name }
          selections { character { id } entrant { id } }
          entrant1Score
          entrant2Score
        }
      }
    }
  }
}`;

/** Empirically-safe page size for the research selection shape (live probe 2026-08-08) — see the budget comment above; 10 silently clips. */
export const RESEARCH_SETS_PER_PAGE = 5;

/**
 * The single validated crossing between the run record's STRING `playerId`
 * (an RTDB key) and the numeric `playerId` the existing client's
 * `fetchPlayerSetsPage`/`resolvePlayerById` require (review C-H9b). Accepts
 * a digits-only shape of at most 20 characters and returns it as a finite
 * positive integer; returns null for anything else — empty, non-numeric,
 * negative, fractional, or beyond `Number.isSafeInteger`'s range. No caller
 * should write an ad-hoc `Number(...)` here: that turns a malformed id into
 * `NaN` and then into a provider request for player `null`.
 */
export function normalizeStartggPlayerId(value: string | number): number | null {
  const asString = typeof value === 'number' ? String(value) : value;
  if (!/^[0-9]{1,20}$/.test(asString)) {
    return null;
  }
  const parsed = Number(asString);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One page of a player's SSBU-and-cross-game set history, lossless (bye
 * slots and DQ flags included, `updatedAfter` honored) for the research
 * backfill. Unlike `fetchPlayerSetsPage`, `playerId` accepts `string |
 * number` — the GraphQL `ID!` scalar accepts either — and is normalized to
 * its canonical string form for the outgoing variable, so a caller passing
 * the stored string id and a caller passing the equivalent number produce
 * byte-identical request bodies; this function does NOT perform
 * `normalizeStartggPlayerId`'s digit-only validation/rejection — a caller
 * that needs a validated number for a sibling function (e.g.
 * `resolvePlayerById`) calls `normalizeStartggPlayerId` itself first, then
 * passes either form straight through here.
 */
export async function fetchResearchSetsPage(
  serverToken: string,
  playerId: string | number,
  page: number,
  perPage = RESEARCH_SETS_PER_PAGE,
  filters: ResearchSetsFilters = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ totalPages: number; sets: StartggResearchSet[] }> {
  const data = await gql(
    serverToken,
    RESEARCH_SETS_QUERY,
    { playerId: String(playerId), page, perPage, updatedAfter: filters.updatedAfter ?? null },
    researchSetsPageSchema,
    fetchImpl,
  );
  const sets = data.player?.sets;
  const totalPages = sets?.pageInfo.totalPages ?? 0;
  const nodes = sets?.nodes ?? [];
  // PROVIDER-TRUNCATION GUARD (live probe, 2026-08-08): when a page's
  // response would exceed start.gg's object budget, the API silently clips
  // the node list (never returning its documented over-budget rejection).
  // A short page while the SAME response says more pages exist is that
  // clipping — the missing rows cannot be recovered at the next page
  // offset, so surfacing a loud error here is the only lossless option
  // (ING-01). A short FINAL page (totalPages <= page) is legitimate. The
  // fully-clipped variant (zero nodes AND totalPages collapsed to 0) is
  // invisible in-response; the batch executor catches it against the
  // cursor's prior pagination knowledge.
  if (nodes.length < perPage && totalPages > page) {
    throw new StartggApiError(
      `provider-truncated-page: ${nodes.length}/${perPage} nodes at page ${page} with totalPages=${totalPages} — start.gg silently clipped the response to fit its object budget; lower perPage (truncated rows are unrecoverable at the next offset)`,
    );
  }
  return { totalPages, sets: nodes };
}

const probeSetsPageSchema = z.object({
  player: z
    .object({
      sets: z
        .object({
          pageInfo: z.object({ totalPages: z.number().int().nonnegative() }),
          nodes: z.array(z.object({ id: z.union([z.number(), z.string()]) })),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * A SECOND, separate template literal — deliberately not a parameterization
 * of `RESEARCH_SETS_QUERY`. `SetFilters.entrantSize` is an UNVERIFIED
 * provider field (30-RESEARCH.md A5 / Open Question 3); GraphQL fails the
 * WHOLE request on an unknown argument, so putting it in the executor's
 * query — even behind a null variable — would risk breaking every backfill
 * page to answer a research question. Isolating it here means the worst
 * case is one failed PROBE request whose failure IS the answer (review
 * C2-A1). Selects only `pageInfo.totalPages` and each node's `id` — the
 * entrant-size comparison needs set identity and nothing else, so this
 * probe's extra request costs a fraction of a real page.
 */
const RESEARCH_SETS_ENTRANT_SIZE_PROBE_QUERY = `query ResearchPlayerSetsEntrantSizeProbe($playerId: ID!, $page: Int!, $perPage: Int!, $entrantSize: Int) {
  player(id: $playerId) {
    sets(perPage: $perPage, page: $page, filters: { showByes: true, entrantSize: $entrantSize }) {
      pageInfo { totalPages }
      nodes { id }
    }
  }
}`;

/**
 * PROBE-ONLY: `apps/api/scripts/probeResearchSetsSchema.ts` is this
 * function's only caller. The batch executor (plan 30-07) must never call
 * it, and `researchQueryLock.test.ts` asserts `RESEARCH_SETS_QUERY`'s
 * captured request body carries no entrant-size argument while this
 * function's does. A `StartggApiError` naming an unknown argument is the
 * EXPECTED negative outcome here — the caller converts it to the
 * `filter-unavailable` verdict (`researchProbe.ts`'s
 * `compareEntrantSizeProbe`) rather than treating it as a failure.
 */
export async function fetchResearchSetsProbePage(
  serverToken: string,
  playerId: string | number,
  page: number,
  perPage: number,
  entrantSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ totalPages: number; sets: StartggResearchSet[] }> {
  const data = await gql(
    serverToken,
    RESEARCH_SETS_ENTRANT_SIZE_PROBE_QUERY,
    { playerId: String(playerId), page, perPage, entrantSize },
    probeSetsPageSchema,
    fetchImpl,
  );
  const sets = data.player?.sets;
  return { totalPages: sets?.pageInfo.totalPages ?? 0, sets: sets?.nodes ?? [] };
}

// ---- event details (slugs + standings, public data, server token) ----------

const EVENT_STANDINGS_PER_PAGE = 8;

const eventDetailsSchema = z.object({
  event: z
    .object({
      slug: z.string().nullish(),
      tournament: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish(),
      standings: z
        .object({
          nodes: z
            .array(
              z
                .object({
                  placement: z.number().int().nullish(),
                  entrant: z
                    .object({
                      name: z.string().nullish(),
                      participants: z
                        .array(
                          z
                            .object({
                              player: z
                                .object({
                                  id: z.number().nullish(),
                                  gamerTag: z.string().nullish(),
                                })
                                .nullish(),
                              user: z.object({ slug: z.string().nullish() }).nullish(),
                            })
                            .nullish(),
                        )
                        .nullish(),
                    })
                    .nullish(),
                })
                .nullish(),
            )
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const EVENT_DETAILS_QUERY = `query EventDetails($eventId: ID!, $perPage: Int!) {
  event(id: $eventId) {
    slug
    tournament { name slug }
    standings(query: { perPage: $perPage, page: 1 }) {
      nodes {
        placement
        entrant {
          name
          participants { player { id gamerTag } user { slug } }
        }
      }
    }
  }
}`;

export interface StartggEventDetails {
  /** Tournament slug, e.g. "tournament/the-box-juice-box-26". */
  tournamentSlug?: string;
  /** Event slug, e.g. "tournament/the-box-juice-box-26/event/ultimate-singles". */
  slug?: string;
  /** Top finishers of the event, per start.gg's default standings ordering. */
  topStandings: {
    placement: number;
    name: string;
    gamerTag?: string;
    userSlug?: string;
  }[];
}

/**
 * Fetches an event's slug, parent tournament slug, and top standings
 * (capped to `EVENT_STANDINGS_PER_PAGE`). Public data — usable with the
 * server token. Nullish-tolerant throughout: start.gg omits fields freely,
 * and callers (sync.ts) treat a fetch/parse failure for one event as
 * non-fatal.
 */
export async function fetchEventDetails(
  serverToken: string,
  eventId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<StartggEventDetails> {
  const data = await gql(
    serverToken,
    EVENT_DETAILS_QUERY,
    { eventId, perPage: EVENT_STANDINGS_PER_PAGE },
    eventDetailsSchema,
    fetchImpl,
  );
  const event = data.event;
  const topStandings = (event?.standings?.nodes ?? []).flatMap((node) => {
    if (!node || node.placement == null || !node.entrant?.name) {
      return [];
    }
    const participant = node.entrant.participants?.find((p) => p != null);
    const gamerTag = participant?.player?.gamerTag ?? undefined;
    const userSlug = participant?.user?.slug ?? undefined;
    return [
      {
        placement: node.placement,
        name: node.entrant.name,
        ...(gamerTag ? { gamerTag } : {}),
        ...(userSlug ? { userSlug } : {}),
      },
    ];
  });

  return {
    ...(event?.slug ? { slug: event.slug } : {}),
    ...(event?.tournament?.slug ? { tournamentSlug: event.tournament.slug } : {}),
    topStandings,
  };
}
