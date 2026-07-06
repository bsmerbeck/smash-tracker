import { z } from 'zod';

/**
 * Minimal start.gg GraphQL client (https://api.start.gg/gql/alpha).
 * Rate limits: 80 req/60s, max 1000 objects per request — the sets query
 * below keeps perPage small enough to stay comfortably under both.
 */
const STARTGG_GQL_URL = 'https://api.start.gg/gql/alpha';

export const SSBU_VIDEOGAME_ID = 1386;

export class StartggApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
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
    throw new StartggApiError(`start.gg API returned ${response.status}`, response.status);
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
