import {
  GetMatchesRequest,
  GetUserRequest,
  GetUsersRequest,
  MatchesFilter,
  MatchServiceClient,
  UsersFilter,
  UserServiceClient,
  type MatchContext as ParryMatchContext,
  type User as ParryUserMessage,
} from '@parry-gg/client';

/**
 * parry.gg gRPC-Web endpoint. Auth is a bare `X-API-KEY` header passed as
 * call metadata — there is no OAuth flow (verified live against the API;
 * see the V8-A probe notes). Sole endpoint for every service client.
 */
export const PARRYGG_GRPC_WEB_URL = 'https://grpcweb.parry.gg';

/**
 * gRPC-Web's browser-oriented transport (`grpc-web`) constructs an
 * `XMLHttpRequest` under the hood. In Node there is no global
 * `XMLHttpRequest`, so the official `@parry-gg/client` (and grpc-web
 * generally) requires a polyfill — `xhr2` — installed as `global.
 * XMLHttpRequest` BEFORE any service client is constructed. This runs
 * exactly once per process; constructing multiple clients afterward is
 * fine (verified working pattern from the V8-A API probe).
 */
let polyfilled = false;
async function ensureXhrPolyfill(): Promise<void> {
  if (polyfilled) {
    return;
  }
  const xhr2 = await import('xhr2');
  (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = xhr2.default ?? xhr2;
  polyfilled = true;
}

export interface ParryggClients {
  users: UserServiceClient;
  matches: MatchServiceClient;
}

let cachedClients: ParryggClients | null = null;

/**
 * Builds (and caches) the parry.gg gRPC-Web service clients, polyfilling
 * `XMLHttpRequest` first. Exported mainly so tests can construct throwaway
 * clients against a fake transport; production code should prefer the
 * `searchUsers`/`getUser`/`getUserMatches` functions below, which accept an
 * injectable `clients` param for exactly that purpose.
 */
export async function getParryggClients(): Promise<ParryggClients> {
  if (cachedClients) {
    return cachedClients;
  }
  await ensureXhrPolyfill();
  cachedClients = {
    users: new UserServiceClient(PARRYGG_GRPC_WEB_URL),
    matches: new MatchServiceClient(PARRYGG_GRPC_WEB_URL),
  };
  return cachedClients;
}

/** Result shape for `searchUsers` — the fields the search UI needs, already `.toObject()`-ed. */
export interface ParryggUserSummary {
  id: string;
  gamerTag: string;
  sponsorName?: string;
  locationCountry?: string;
  avatarUrl?: string;
}

function toUserSummary(user: ParryUserMessage.AsObject): ParryggUserSummary {
  return {
    id: user.id,
    gamerTag: user.gamerTag,
    ...(user.sponsorName ? { sponsorName: user.sponsorName } : {}),
    ...(user.locationCountry ? { locationCountry: user.locationCountry } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/**
 * Fuzzy gamer-tag search (verified live: `UsersFilter.setGamerTag` performs
 * a fuzzy match, not an exact one). Caps at `limit` results — the search UI
 * only ever needs a short candidate list.
 */
export async function searchUsers(
  apiKey: string,
  gamerTag: string,
  limit = 10,
  clients?: ParryggClients,
): Promise<ParryggUserSummary[]> {
  const { users } = clients ?? (await getParryggClients());
  const filter = new UsersFilter();
  filter.setGamerTag(gamerTag);
  const request = new GetUsersRequest();
  request.setFilter(filter);
  const response = await users.getUsers(request, { 'X-API-KEY': apiKey });
  return response
    .getUsersList()
    .slice(0, limit)
    .map((user) => toUserSummary(user.toObject()));
}

/** Full parry.gg user record (used for link confirmation + bio-based verification). */
export type ParryggUser = ParryUserMessage.AsObject;

/** Fetches a parry.gg user by id, or null when no such user exists. */
export async function getUser(
  apiKey: string,
  id: string,
  clients?: ParryggClients,
): Promise<ParryggUser | null> {
  const { users } = clients ?? (await getParryggClients());
  const request = new GetUserRequest();
  request.setId(id);
  const response = await users.getUser(request, { 'X-API-KEY': apiKey });
  const user = response.getUser();
  return user ? user.toObject() : null;
}

/** A parry.gg match, fully expanded (`.toObject()`-ed) for the sync mapper. */
export type ParryggMatchContext = ParryMatchContext.AsObject;

/**
 * Fetches every match a parry.gg user has participated in. Public data — no
 * ownership/verification required to read it (mirrors start.gg's own-token
 * sync trust level).
 */
export async function getUserMatches(
  apiKey: string,
  userId: string,
  clients?: ParryggClients,
): Promise<ParryggMatchContext[]> {
  const { matches } = clients ?? (await getParryggClients());
  const filter = new MatchesFilter();
  filter.setUserId(userId);
  const request = new GetMatchesRequest();
  request.setFilter(filter);
  const response = await matches.getMatches(request, { 'X-API-KEY': apiKey });
  return response.getMatchesList().map((match) => match.toObject());
}
