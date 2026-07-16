import type { z } from 'zod';
import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  createGroupRequestSchema,
  creditsStatusSchema,
  errorResponseSchema,
  fighterSelectionSchema,
  generateReportRequestSchema,
  groupLeaderboardSchema,
  groupListSchema,
  groupRecordSchema,
  gspLiveSchema,
  gspReadingSchema,
  gspSettingsSchema,
  joinGroupRequestSchema,
  matchSchema,
  opponentAliasMapSchema,
  opponentListSchema,
  opponentNoteMapSchema,
  opponentNoteSchema,
  parryggLinkRequestSchema,
  parryggLoginCompleteRequestSchema,
  parryggLoginCompleteResponseSchema,
  parryggLoginSearchRequestSchema,
  parryggLoginSearchResultListSchema,
  parryggLoginStartRequestSchema,
  parryggLoginStartResponseSchema,
  parryggSearchResultListSchema,
  parryggStatusSchema,
  parryggSyncSummarySchema,
  parryggVerificationCompleteResponseSchema,
  parryggVerificationStartResponseSchema,
  playlistSchema,
  publicShareSnapshotSchema,
  reportsConfigSchema,
  scoutReportDataSchema,
  scoutReportRecordSchema,
  shareCreatedResponseSchema,
  shareSummarySchema,
  stageFavoritesSchema,
  startggAuthorizeResponseSchema,
  startggStatusSchema,
  startggSyncSummarySchema,
  tournamentEntryListSchema,
  userProfileSchema,
  type CreateGspReadingInput,
  type CreateMatchInput,
  type CreditPackId,
  type FighterSelectionInput,
  type GenerateReportRequest,
  type Match,
  type ParryggLinkRequest,
  type ParryggLoginCompleteRequest,
  type ParryggLoginSearchRequest,
  type ParryggLoginStartRequest,
  type CreatePlaylistInput,
  type UpdatePlaylistInput,
  type CreateShareInput,
  type ScoutQuery,
  type UpdateGspReadingInput,
  type UpdateMatchInput,
  type UpsertGspSettingsInput,
  type UpsertOpponentAliasInput,
  type UpsertOpponentNoteInput,
  type UpsertStageFavoritesInput,
} from '@smash-tracker/shared';
import { getFirebaseAuth } from './firebase';

/**
 * Thrown for any non-2xx response. Carries the parsed error envelope
 * (`packages/shared`'s `errorResponseSchema`) when the API returned one, so
 * callers/UI can show `message` directly.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly statusCode?: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

/** Thrown when a response body doesn't match the expected shared schema. */
export class ApiSchemaError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'ApiSchemaError';
  }
}

/**
 * Base URL prepended to `/api/**` request paths.
 *
 * `VITE_API_BASE_URL` is `undefined` when unset (falls back to the local
 * dev API) but an explicit empty string in production, where the SPA is
 * served from the same origin as the API (Firebase Hosting rewrites
 * `/api/**` to Cloud Run) — in that case requests should stay relative
 * (`""` + `/api/...` = `/api/...`) rather than falling back to localhost.
 * A trailing slash is stripped so `path` (which always starts with `/`)
 * doesn't produce a double slash when joined.
 */
export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const base = configured ?? 'http://localhost:3001';
  return base.replace(/\/+$/, '');
}

/**
 * Base URL for requests that must NOT go through the Firebase Hosting
 * `/api/**` rewrite. The Hosting proxy hard-caps every rewritten request at
 * 60 seconds (not configurable), which AI report generation can exceed —
 * the model call alone can run past a minute. `VITE_API_DIRECT_URL` holds
 * the Cloud Run service URL so those calls hit the API origin directly
 * (CORS-allowed via the API's CORS_ORIGIN env var) and get Cloud Run's own
 * 300-second window instead. Falls back to the regular base when unset
 * (local dev and tests, where there is no proxy in the middle).
 */
export function getDirectApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_DIRECT_URL;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.replace(/\/+$/, '');
  }
  return getApiBaseUrl();
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    return {};
  }
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

interface RequestOptions<TBody> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: TBody;
  /** Overrides the request origin (see `getDirectApiBaseUrl`). */
  baseUrl?: string;
}

/**
 * Fetch wrapper: attaches the Bearer ID token for the current Firebase user,
 * parses JSON, and throws `ApiError` for non-2xx responses. Does not itself
 * validate the success payload — call `apiRequest` + `schema.parse(...)`, or
 * use `apiRequestParsed` for the common case.
 */
async function apiRequest<TResponse, TBody = unknown>(
  path: string,
  options: RequestOptions<TBody> = {},
): Promise<TResponse> {
  const authHeader = await getAuthHeader();
  const hasBody = options.body !== undefined;

  const response = await fetch(`${options.baseUrl ?? getApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...authHeader,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(json);
    if (parsedError.success) {
      throw new ApiError(response.status, parsedError.data.message, parsedError.data.details);
    }
    throw new ApiError(response.status, response.statusText || 'Request failed');
  }

  return json as TResponse;
}

/** Runs `apiRequest` then validates the parsed JSON against `schema`. */
async function apiRequestParsed<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options: RequestOptions<unknown> = {},
): Promise<z.infer<TSchema>> {
  const json = await apiRequest<unknown>(path, options);
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiSchemaError(
      `Response from ${path} did not match the expected schema`,
      result.error,
    );
  }
  return result.data;
}

export const api = {
  users: {
    /** PUT /api/users/me — idempotent user provisioning. */
    upsertMe: () =>
      apiRequestParsed('/api/users/me', userProfileSchema.pick({ uid: true, email: true }), {
        method: 'PUT',
      }),
    /** GET /api/users/me */
    getMe: () => apiRequestParsed('/api/users/me', userProfileSchema),
    /** GET /api/users/me/fighters */
    getFighters: () => apiRequestParsed('/api/users/me/fighters', fighterSelectionSchema),
    /** PUT /api/users/me/fighters */
    saveFighters: (input: FighterSelectionInput) =>
      apiRequestParsed('/api/users/me/fighters', fighterSelectionSchema, {
        method: 'PUT',
        body: input,
      }),
  },
  matches: {
    /** GET /api/matches */
    list: () => apiRequestParsed('/api/matches', matchSchema.array()),
    /** POST /api/matches */
    create: (input: CreateMatchInput) =>
      apiRequestParsed('/api/matches', matchSchema, { method: 'POST', body: input }),
    /** PATCH /api/matches/:id */
    update: (id: string, input: UpdateMatchInput) =>
      apiRequestParsed(`/api/matches/${encodeURIComponent(id)}`, matchSchema, {
        method: 'PATCH',
        body: input,
      }),
    /** DELETE /api/matches/:id */
    remove: (id: string) =>
      apiRequest<void>(`/api/matches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  opponents: {
    /** GET /api/opponents */
    list: () => apiRequestParsed('/api/opponents', opponentListSchema),
    aliases: {
      /** GET /api/opponents/aliases */
      list: () => apiRequestParsed('/api/opponents/aliases', opponentAliasMapSchema),
      /** PUT /api/opponents/aliases/:alias */
      upsert: (alias: string, input: UpsertOpponentAliasInput) =>
        apiRequestParsed(
          `/api/opponents/aliases/${encodeURIComponent(alias)}`,
          opponentAliasMapSchema,
          { method: 'PUT', body: input },
        ),
      /** DELETE /api/opponents/aliases/:alias */
      remove: (alias: string) =>
        apiRequest<void>(`/api/opponents/aliases/${encodeURIComponent(alias)}`, {
          method: 'DELETE',
        }),
    },
    notes: {
      /** GET /api/opponent-notes */
      list: () => apiRequestParsed('/api/opponent-notes', opponentNoteMapSchema),
      /** PUT /api/opponent-notes/:name */
      upsert: (name: string, input: UpsertOpponentNoteInput) =>
        apiRequestParsed(`/api/opponent-notes/${encodeURIComponent(name)}`, opponentNoteSchema, {
          method: 'PUT',
          body: input,
        }),
      /** DELETE /api/opponent-notes/:name */
      remove: (name: string) =>
        apiRequest<void>(`/api/opponent-notes/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        }),
    },
  },
  startgg: {
    /** GET /api/integrations/startgg/status */
    status: () => apiRequestParsed('/api/integrations/startgg/status', startggStatusSchema),
    /** GET /api/integrations/startgg/authorize — returns the URL to send the user to. */
    authorize: () =>
      apiRequestParsed('/api/integrations/startgg/authorize', startggAuthorizeResponseSchema),
    /** POST /api/integrations/startgg/sync */
    sync: () =>
      apiRequestParsed('/api/integrations/startgg/sync', startggSyncSummarySchema, {
        method: 'POST',
      }),
    /** DELETE /api/integrations/startgg/link */
    unlink: () => apiRequest<void>('/api/integrations/startgg/link', { method: 'DELETE' }),
  },
  parrygg: {
    /** GET /api/integrations/parrygg/status */
    status: () => apiRequestParsed('/api/integrations/parrygg/status', parryggStatusSchema),
    /** GET /api/integrations/parrygg/search?tag=... — up to 10 candidates. */
    search: (tag: string) =>
      apiRequestParsed(
        `/api/integrations/parrygg/search?tag=${encodeURIComponent(tag)}`,
        parryggSearchResultListSchema,
      ),
    /** POST /api/integrations/parrygg/link */
    link: (input: ParryggLinkRequest) =>
      apiRequestParsed('/api/integrations/parrygg/link', parryggStatusSchema, {
        method: 'POST',
        body: parryggLinkRequestSchema.parse(input),
      }),
    /** POST /api/integrations/parrygg/unlink */
    unlink: () => apiRequest<void>('/api/integrations/parrygg/unlink', { method: 'POST' }),
    /** POST /api/integrations/parrygg/verify/start */
    verifyStart: () =>
      apiRequestParsed(
        '/api/integrations/parrygg/verify/start',
        parryggVerificationStartResponseSchema,
        { method: 'POST' },
      ),
    /** POST /api/integrations/parrygg/verify/complete */
    verifyComplete: () =>
      apiRequestParsed(
        '/api/integrations/parrygg/verify/complete',
        parryggVerificationCompleteResponseSchema,
        { method: 'POST' },
      ),
    /** POST /api/integrations/parrygg/sync */
    sync: () =>
      apiRequestParsed('/api/integrations/parrygg/sync', parryggSyncSummarySchema, {
        method: 'POST',
      }),
    /**
     * "Log in with parry.gg" (V8-B) — public routes, no Bearer auth (the
     * shared fetch wrapper simply sends no Authorization header while
     * signed out). Bio-code claim flow: search -> start -> complete.
     */
    login: {
      /** POST /api/auth/parrygg/login/search — up to 5 candidates. */
      search: (input: ParryggLoginSearchRequest) =>
        apiRequestParsed('/api/auth/parrygg/login/search', parryggLoginSearchResultListSchema, {
          method: 'POST',
          body: parryggLoginSearchRequestSchema.parse(input),
        }),
      /** POST /api/auth/parrygg/login/start — issues (or resumes) an ST-XXXXXX code. */
      start: (input: ParryggLoginStartRequest) =>
        apiRequestParsed('/api/auth/parrygg/login/start', parryggLoginStartResponseSchema, {
          method: 'POST',
          body: parryggLoginStartRequestSchema.parse(input),
        }),
      /** POST /api/auth/parrygg/login/complete — checks the bio, returns a Firebase custom token. */
      complete: (input: ParryggLoginCompleteRequest) =>
        apiRequestParsed('/api/auth/parrygg/login/complete', parryggLoginCompleteResponseSchema, {
          method: 'POST',
          body: parryggLoginCompleteRequestSchema.parse(input),
        }),
    },
  },
  tournaments: {
    /** GET /api/tournaments */
    list: () => apiRequestParsed('/api/tournaments', tournamentEntryListSchema),
  },
  scout: {
    /** POST /api/scout — scout ANY start.gg OR parry.gg player (V9-B) by URL, slug/tag, or numeric id. */
    lookup: (input: ScoutQuery) =>
      apiRequestParsed('/api/scout', scoutReportDataSchema, { method: 'POST', body: input }),
  },
  reports: {
    /** GET /api/reports/config — whether the signed-in user can generate AI reports. */
    config: () => apiRequestParsed('/api/reports/config', reportsConfigSchema),
    /**
     * POST /api/reports — generate (and store) an AI scouting report.
     * Goes directly to the API origin: generation regularly outlives the
     * Hosting proxy's 60s rewrite timeout. `source` (V9-B Feature 4) picks
     * start.gg vs. parry.gg for a bare query — same semantics as POST
     * /api/scout.
     */
    generate: (input: GenerateReportRequest) =>
      apiRequestParsed('/api/reports', scoutReportRecordSchema, {
        method: 'POST',
        body: generateReportRequestSchema.parse(input),
        baseUrl: getDirectApiBaseUrl(),
      }),
    /** GET /api/reports — the signed-in user's past AI reports, newest first. */
    list: () => apiRequestParsed('/api/reports', scoutReportRecordSchema.array()),
    /** GET /api/reports/:id — a single stored AI report. */
    get: (id: string) =>
      apiRequestParsed(`/api/reports/${encodeURIComponent(id)}`, scoutReportRecordSchema),
  },
  groups: {
    /** GET /api/groups — the signed-in user's groups. */
    list: () => apiRequestParsed('/api/groups', groupListSchema),
    /** POST /api/groups — create a group (caller becomes owner + first member). */
    create: (name: string) =>
      apiRequestParsed('/api/groups', groupRecordSchema, {
        method: 'POST',
        body: createGroupRequestSchema.parse({ name }),
      }),
    /** POST /api/groups/join — join a group by invite code (idempotent if already a member). */
    join: (code: string) =>
      apiRequestParsed('/api/groups/join', groupRecordSchema, {
        method: 'POST',
        body: joinGroupRequestSchema.parse({ code }),
      }),
    /** GET /api/groups/:id/leaderboard */
    leaderboard: (id: string) =>
      apiRequestParsed(`/api/groups/${encodeURIComponent(id)}/leaderboard`, groupLeaderboardSchema),
    /** POST /api/groups/:id/leave */
    leave: (id: string) =>
      apiRequest<void>(`/api/groups/${encodeURIComponent(id)}/leave`, { method: 'POST' }),
    /** DELETE /api/groups/:id — owner only. */
    remove: (id: string) =>
      apiRequest<void>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  billing: {
    /** GET /api/billing/credits — the signed-in user's free-access flag, credit balance, and the available packs. */
    credits: () => apiRequestParsed('/api/billing/credits', creditsStatusSchema),
    /** POST /api/billing/checkout — creates a Stripe Checkout Session for a credit pack; returns the URL to redirect to. */
    checkout: (packId: CreditPackId) =>
      apiRequestParsed('/api/billing/checkout', checkoutResponseSchema, {
        method: 'POST',
        body: checkoutRequestSchema.parse({ packId }),
      }),
  },
  gspSettings: {
    /** GET /api/gsp-settings — the signed-in user's Elite Smash threshold setting (defaults are synthesized server-side, never 404s). */
    get: () => apiRequestParsed('/api/gsp-settings', gspSettingsSchema),
    /** PUT /api/gsp-settings */
    update: (input: UpsertGspSettingsInput) =>
      apiRequestParsed('/api/gsp-settings', gspSettingsSchema, { method: 'PUT', body: input }),
  },
  gspLive: {
    /** GET /api/gsp-live — cached live elite/max GSP thresholds (server refreshes from gsptiers.com when stale; 404 until the first successful fetch). */
    get: () => apiRequestParsed('/api/gsp-live', gspLiveSchema),
  },
  gspReadings: {
    /** GET /api/gsp-readings — the signed-in user's standalone "set GSP" calibration readings (V17). */
    list: () => apiRequestParsed('/api/gsp-readings', gspReadingSchema.array()),
    /** POST /api/gsp-readings — `time` is server-stamped. */
    create: (input: CreateGspReadingInput) =>
      apiRequestParsed('/api/gsp-readings', gspReadingSchema, { method: 'POST', body: input }),
    /** PATCH /api/gsp-readings/:id — corrects the value only. */
    update: (id: string, input: UpdateGspReadingInput) =>
      apiRequestParsed(`/api/gsp-readings/${encodeURIComponent(id)}`, gspReadingSchema, {
        method: 'PATCH',
        body: input,
      }),
    /** DELETE /api/gsp-readings/:id */
    remove: (id: string) =>
      apiRequest<void>(`/api/gsp-readings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  playlists: {
    /** GET /api/playlists — the signed-in user's playlists. */
    list: () => apiRequestParsed('/api/playlists', playlistSchema.array()),
    /** POST /api/playlists — `createdAt` is server-stamped, `matchIds` starts empty. */
    create: (input: CreatePlaylistInput) =>
      apiRequestParsed('/api/playlists', playlistSchema, { method: 'POST', body: input }),
    /** PATCH /api/playlists/:id — rename and/or reorder (both optional). */
    update: (id: string, input: UpdatePlaylistInput) =>
      apiRequestParsed(`/api/playlists/${encodeURIComponent(id)}`, playlistSchema, {
        method: 'PATCH',
        body: input,
      }),
    /** DELETE /api/playlists/:id */
    remove: (id: string) =>
      apiRequest<void>(`/api/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  stageFavorites: {
    /** GET /api/stage-favorites — the signed-in user's favorited stage ids (an empty default is synthesized server-side, never 404s). */
    get: () => apiRequestParsed('/api/stage-favorites', stageFavoritesSchema),
    /** PUT /api/stage-favorites — replaces the whole favorites list. */
    update: (input: UpsertStageFavoritesInput) =>
      apiRequestParsed('/api/stage-favorites', stageFavoritesSchema, {
        method: 'PUT',
        body: input,
      }),
  },
  vodShares: {
    /** GET /api/vod-shares — the signed-in user's share links (active + revoked). */
    list: () => apiRequestParsed('/api/vod-shares', shareSummarySchema.array()),
    /** POST /api/vod-shares — creates a new redacted share snapshot + token. */
    create: (input: CreateShareInput) =>
      apiRequestParsed('/api/vod-shares', shareCreatedResponseSchema, {
        method: 'POST',
        body: input,
      }),
    /** POST /api/vod-shares/:id/revoke — soft-revokes; the share stays listed. */
    revoke: (id: string) =>
      apiRequest<void>(`/api/vod-shares/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    /** DELETE /api/vod-shares/:id — removes a REVOKED share from the list (409 if still active). */
    remove: (id: string) =>
      apiRequest<void>(`/api/vod-shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * GET /api/vod-shares/:token — anonymous, unauthenticated read of a
     * redacted share snapshot by its public token. No Authorization header
     * is sent for signed-out callers (`getAuthHeader` already no-ops
     * without a current Firebase user); a real signed-in caller opening
     * their own share link would harmlessly attach one, which the API
     * ignores on this route.
     */
    getPublic: (token: string) =>
      apiRequestParsed(`/api/vod-shares/${encodeURIComponent(token)}`, publicShareSnapshotSchema),
  },
};

/** Public "login with start.gg" entrypoint — a full-page navigation, not an XHR. */
export function getStartggLoginUrl(): string {
  return `${getApiBaseUrl()}/api/auth/startgg/login`;
}

export type { Match };
