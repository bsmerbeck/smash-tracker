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
              event: z
                .object({
                  id: z.number().nullish(),
                  name: z.string().nullish(),
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
                                  player: z.object({ id: z.number() }).nullish(),
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
                    stage: z.object({ name: z.string() }).nullish(),
                    selections: z
                      .array(
                        z.object({
                          character: z.object({ id: z.number() }).nullish(),
                          entrant: z.object({ id: z.number() }).nullish(),
                        }),
                      )
                      .nullish(),
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
// ~5 games x 3 fields + ~8 set/event fields) stays well under the 1000
// object limit — nowhere near the ~180 objects/page this shape produces.
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
        event { id name isOnline numEntrants videogame { id } tournament { name } }
        slots {
          entrant {
            id
            name
            participants { player { id } }
            seeds { seedNum }
            standing { placement }
          }
        }
        games {
          winnerId
          stage { name }
          selections { character { id } entrant { id } }
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
