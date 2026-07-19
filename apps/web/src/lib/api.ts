import { z } from 'zod';
import {
  bulkShareResponseSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  clientHubListSchema,
  clientHubRowSchema,
  createClientRequestSchema,
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
  vodTimestampEntrySchema,
  vodTimestampSchema,
  type BulkShareRequest,
  type CreateClientRequest,
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
  createShareInputSchema,
  type ScoutQuery,
  type UpdateGspReadingInput,
  type UpdateMatchInput,
  type UpsertGspSettingsInput,
  type UpsertOpponentAliasInput,
  type UpsertOpponentNoteInput,
  type UpsertStageFavoritesInput,
} from '@smash-tracker/shared';
import { getFirebaseAuth } from './firebase';
import { getActiveSubjectHeader } from './subjectQueryKey';

/**
 * POST /api/vod-shares request body, typed from the schema's INPUT side:
 * `kind` and `permissions` carry Zod `.default()`s (`'review'`/`'view'`),
 * so callers may omit them — the shared `CreateShareInput` (`z.infer`, the
 * OUTPUT type) would force every caller to spell out both defaults.
 */
export type CreateShareRequest = z.input<typeof createShareInputSchema>;

/**
 * Request body for the dedicated note endpoints (`POST/PATCH
 * /api/matches/:id/notes[/:noteId]`) — the id-less `vodTimestampSchema`
 * shape. The server owns id assignment (RTDB push keys); responses come
 * back as the id-bearing `vodTimestampEntrySchema` shape.
 */
export type VodTimestampInput = z.infer<typeof vodTimestampSchema>;

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
      'X-Active-Subject': getActiveSubjectHeader(),
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

/**
 * GET /api/coaching/clients/:id/export response shape. Mirrors
 * `apps/api/src/routes/coachingTenants.ts`'s `clientWorkspaceExportSchema`
 * exactly (that schema is assembled inline in the route file, not exported
 * from `@smash-tracker/shared` — duplicated here rather than promoting it to
 * shared, to keep this plan's footprint to the web package).
 */
const clientWorkspaceExportSchema = z.object({
  clientId: z.string(),
  label: z.string(),
  exportedAt: z.number().int().nonnegative(),
  matches: matchSchema.array(),
  playlists: playlistSchema.array(),
  opponents: z.array(z.string()),
  opponentAliases: opponentAliasMapSchema,
  opponentNotes: opponentNoteMapSchema,
  stageFavorites: stageFavoritesSchema,
  fighterSelection: fighterSelectionSchema,
});

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
    /**
     * PUT /api/users/me — idempotent user provisioning. Optionally carries a
     * `referredByShareId` (Phase 7 FUNNEL-02) from the localStorage referral
     * stamp. The stamped value is the share-page route TOKEN — the API
     * resolves it server-side to the durable shareId before storing
     * (write-once/first-touch), so passing one on a returning user's sign-in
     * is harmless. Omit the argument entirely to preserve the exact bodyless
     * request every pre-Phase-7 caller sends.
     */
    upsertMe: (input?: { referredByShareId?: string }) =>
      apiRequestParsed('/api/users/me', userProfileSchema.pick({ uid: true, email: true }), {
        method: 'PUT',
        body: input,
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
    /**
     * POST /api/matches/:id/clear-vod — the explicit "remove VOD link"
     * intent (MatchTable's "Remove VOD link" action): drops
     * `vodUrl`/`vodStartSeconds`/`vodTimestamps` together in one call.
     * Now that the PATCH above preserves `vodTimestamps` whenever it's
     * omitted (Phase 8), this dedicated endpoint is the only way to also
     * clear the note subtree — RESEARCH Pitfall 2.
     */
    clearVod: (id: string) =>
      apiRequestParsed(`/api/matches/${encodeURIComponent(id)}/clear-vod`, matchSchema, {
        method: 'POST',
      }),
    /**
     * POST /api/matches/:id/notes — creates ONE timestamp note via the
     * dedicated note endpoint (Phase 8: note writes never ride the
     * full-match PATCH). Returns the created, id-bearing note.
     */
    createNote: (matchId: string, input: VodTimestampInput) =>
      apiRequestParsed(
        `/api/matches/${encodeURIComponent(matchId)}/notes`,
        vodTimestampEntrySchema,
        {
          method: 'POST',
          body: input,
        },
      ),
    /** PATCH /api/matches/:id/notes/:noteId — full-note replace addressed by stable note id. */
    updateNote: (matchId: string, noteId: string, input: VodTimestampInput) =>
      apiRequestParsed(
        `/api/matches/${encodeURIComponent(matchId)}/notes/${encodeURIComponent(noteId)}`,
        vodTimestampEntrySchema,
        { method: 'PATCH', body: input },
      ),
    /** DELETE /api/matches/:id/notes/:noteId — removes one note by stable note id. */
    deleteNote: (matchId: string, noteId: string) =>
      apiRequest<void>(
        `/api/matches/${encodeURIComponent(matchId)}/notes/${encodeURIComponent(noteId)}`,
        { method: 'DELETE' },
      ),
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
  coaching: {
    clients: {
      /** GET /api/coaching/clients — the signed-in coach's non-archived clients. */
      list: () => apiRequestParsed('/api/coaching/clients', clientHubListSchema),
      /** POST /api/coaching/clients — label-only creation; 409 on a duplicate (case-insensitive) label. */
      create: (input: CreateClientRequest) =>
        apiRequestParsed('/api/coaching/clients', clientHubRowSchema, {
          method: 'POST',
          body: createClientRequestSchema.parse(input),
        }),
      /** PATCH /api/coaching/clients/:id/archive — soft archive by default, or restore with `archived: false`. */
      archive: (clientId: string, archived = true) =>
        apiRequest<void>(`/api/coaching/clients/${encodeURIComponent(clientId)}/archive`, {
          method: 'PATCH',
          body: { archived },
        }),
      /** DELETE /api/coaching/clients/:id — irreversible hard-delete cascade. */
      remove: (clientId: string) =>
        apiRequest<void>(`/api/coaching/clients/${encodeURIComponent(clientId)}`, {
          method: 'DELETE',
        }),
      /** GET /api/coaching/clients/:id/export — synchronous JSON dump of the client's workspace (TEN-06). */
      export: (clientId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/export`,
          clientWorkspaceExportSchema,
        ),
    },
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
    /**
     * POST /api/billing/checkout — creates a Stripe Checkout Session for a
     * credit pack; returns the URL to redirect to. `attemptId` (BILL-03) is
     * generated fresh here, once per call — since this function is invoked
     * exactly once per "buy credits" click (via `useCheckoutMutation`'s
     * `mutationFn`), that gives Stripe a stable idempotency key scoped to
     * THIS click; a retry of the same click never re-generates it.
     */
    checkout: (packId: CreditPackId) =>
      apiRequestParsed('/api/billing/checkout', checkoutResponseSchema, {
        method: 'POST',
        body: checkoutRequestSchema.parse({ packId, attemptId: crypto.randomUUID() }),
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
    create: (input: CreateShareRequest) =>
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
     * POST /api/vod-shares/bulk — walkthrough amendment (FB-03): batch
     * revoke or delete up to MAX_SHARES_PER_USER shares in ONE round-trip.
     * The server re-validates ownership per shareId; the UI never asserts
     * authority over the selection.
     */
    bulk: (input: BulkShareRequest) =>
      apiRequestParsed('/api/vod-shares/bulk', bulkShareResponseSchema, {
        method: 'POST',
        body: input,
      }),
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
