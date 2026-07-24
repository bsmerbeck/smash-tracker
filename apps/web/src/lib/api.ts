import { z } from 'zod';
import {
  bulkShareResponseSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  clientHubListSchema,
  clientHubRowSchema,
  clientVisibleVersionSchema,
  createClientRequestSchema,
  createDraftPatchInputSchema,
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
  homeworkItemSchema,
  HOMEWORK_ITEM_TEXT_MAX_LENGTH,
  joinGroupRequestSchema,
  manualTournamentEntryInputSchema,
  MAX_DELIVERY_VODS,
  MAX_SESSION_CHARACTER_TAGS,
  MAX_SESSION_HOMEWORK_ITEMS,
  MAX_SESSION_LINKED_MATCH_IDS,
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
  REVIEW_DELIVERY_STATES,
  REVIEW_SECTION_KINDS,
  reviewDraftSchema,
  SAFE_MARKDOWN_DOC_MAX_LENGTH,
  scoutReportDataSchema,
  scoutReportRecordSchema,
  sessionPatchInputSchema,
  shareCreatedResponseSchema,
  shareSummarySchema,
  stageFavoritesSchema,
  startggAuthorizeResponseSchema,
  startggStatusSchema,
  startggSyncSummarySchema,
  tournamentEntryListSchema,
  tournamentEntrySchema,
  userProfileSchema,
  vodTimestampEntrySchema,
  vodTimestampSchema,
  type BulkShareRequest,
  type CreateClientRequest,
  type CreateDraftPatchInput,
  type CreateGspReadingInput,
  type CreateMatchInput,
  type CreditPackId,
  type FighterSelectionInput,
  type GenerateReportRequest,
  type ManualTournamentEntryInput,
  type Match,
  type OnboardingIntent,
  type ParryggLinkRequest,
  type ParryggLoginCompleteRequest,
  type ParryggLoginSearchRequest,
  type ParryggLoginStartRequest,
  type CreatePlaylistInput,
  type UpdatePlaylistInput,
  createShareInputSchema,
  type ScoutQuery,
  type SessionPatchInput,
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
      // Phase 12 (Coach Reviews & Delivery, T-12-18): some routes (the
      // autosave draft PATCH's 409) attach extra route-specific fields
      // directly on the error body (e.g. `serverDraft`) rather than nesting
      // them under `details` — `errorResponseSchema`'s default Zod object
      // mode silently strips any key it doesn't know about, which would
      // otherwise drop `serverDraft` before a caller ever sees it. Falling
      // back to the full raw `json` (only when the endpoint didn't already
      // populate `details` itself) preserves those fields for callers like
      // `useReviewAutosave` that need to read them off `ApiError.details`.
      throw new ApiError(
        response.status,
        parsedError.data.message,
        parsedError.data.details ?? json,
      );
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

/**
 * Phase 12 (Coach Reviews & Delivery): response/request shapes for the
 * coach-side review routes (`apps/api/src/routes/coachingReviews.ts`) that
 * are assembled inline in that route file, not exported from
 * `@smash-tracker/shared` — duplicated here rather than promoting them to
 * shared, mirroring `clientWorkspaceExportSchema`'s existing precedent
 * above. `REVIEW_STATUSES`'s literal values are copied from
 * `apps/api/src/coaching/reviews.ts` (an API-internal module this package
 * cannot import).
 */
const REVIEW_STATUSES = ['draft', 'published', 'archived'] as const;

const reviewListItemResponseSchema = z.object({
  reviewId: z.string().min(1),
  status: z.enum(REVIEW_STATUSES),
  latestVersion: z.number().int().positive().nullable(),
  revision: z.number().int().nonnegative(),
  deliveryState: z.enum(REVIEW_DELIVERY_STATES).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastAutosavedAt: z.number().int().nonnegative(),
});
export type ReviewListItem = z.infer<typeof reviewListItemResponseSchema>;

const reviewCreatedResponseSchema = z.object({
  reviewId: z.string().min(1),
  revision: z.number().int().positive(),
});

const reviewPublishResultSchema = z.object({ version: z.number().int().positive() });

const addReviewSectionRequestSchema = z.object({
  kind: z.enum(REVIEW_SECTION_KINDS),
  title: z.string().trim().max(60).nullish(),
});
export type AddReviewSectionRequest = z.infer<typeof addReviewSectionRequestSchema>;

/**
 * DLV-01 (plan 04, `apps/api/src/routes/coachingReviewDeliveries.ts`):
 * shapes duplicated here per this file's own precedent (see the doc
 * comment above `reviewListItemResponseSchema`) rather than promoted to
 * `@smash-tracker/shared`.
 *
 * Phase 21 (Rich Client Delivery View, DLVX-04): `includedVods` carries the
 * coach-picked matchId list from `DeliveryVodPicker` — the server (Plan 01's
 * `freezeIncludedVods`) is the sole authority that resolves/tenant-scopes/
 * caps it at creation time; this client-side `.max()` is defense in depth,
 * matching the route body schema's own cap.
 */
const createReviewDeliveryRequestSchema = z.object({
  version: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
  includedVods: z.array(z.string().min(1)).max(MAX_DELIVERY_VODS).optional(),
});
export type CreateReviewDeliveryRequest = z.infer<typeof createReviewDeliveryRequestSchema>;

const deliveryCreatedResponseSchema = z.object({
  deliveryId: z.string().min(1),
  token: z.string().min(1),
  url: z.string().url(),
});

const deliveryListItemResponseSchema = z.object({
  deliveryId: z.string().min(1),
  status: z.enum(REVIEW_DELIVERY_STATES),
  token: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  ackAt: z.number().int().nonnegative().nullable(),
  viewedAt: z.number().int().nonnegative().nullable(),
  url: z.string().url(),
});
export type ReviewDeliveryListItem = z.infer<typeof deliveryListItemResponseSchema>;

/**
 * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02): response/request shapes for the coach-side training-session
 * routes (`apps/api/src/routes/coachingSessions.ts`) — assembled inline in
 * that route file, not exported from `@smash-tracker/shared`, duplicated
 * here per this file's own `reviewListItemResponseSchema` precedent above.
 */
const sessionHomeworkCreateItemSchema = z.object({
  text: z.string().trim().max(HOMEWORK_ITEM_TEXT_MAX_LENGTH),
  done: z.boolean().optional(),
});

/** POST .../sessions body — homework items arrive without an `id` (the server assigns one per item). */
const createSessionRequestSchema = z.object({
  date: z.number().int().nonnegative(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS).optional(),
  summary: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH),
  homework: z.array(sessionHomeworkCreateItemSchema).max(MAX_SESSION_HOMEWORK_ITEMS).optional(),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullish(),
  coachPrivateNotes: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH).nullish(),
});
export type CreateSessionRequest = z.input<typeof createSessionRequestSchema>;

/**
 * Wire-response shape for a session — mirrors `coachingSessions.ts`'s own
 * `sessionResponseSchema` (`.nullable()`, never `.nullish()`, on
 * `linkedMatchIds`/`coachPrivateNotes`).
 */
const sessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  date: z.number().int().nonnegative(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS),
  summary: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH),
  homework: z.array(homeworkItemSchema).max(MAX_SESSION_HOMEWORK_ITEMS),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullable(),
  coachPrivateNotes: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastEditedAt: z.number().int().nonnegative(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * SESS-01 (D-10 immutability): shapes for
 * `apps/api/src/routes/coachingSessionDeliveries.ts` — a session delivery's
 * list-item status is only ever `'delivered' | 'revoked'` (no
 * viewed/acknowledged/expired lifecycle, unlike a review delivery's 6-state
 * `REVIEW_DELIVERY_STATES` — sessions deliberately have no viewed/ack
 * lifecycle this phase, per this plan's own scope).
 */
const sessionDeliveryCreatedResponseSchema = z.object({
  deliveryId: z.string().min(1),
  token: z.string().min(1),
  url: z.string().url(),
});
export type SessionDeliveryCreatedResponse = z.infer<typeof sessionDeliveryCreatedResponseSchema>;

/**
 * Phase 21 (Rich Client Delivery View, DLVX-04): the session-delivery
 * create route's optional body — mirrors `createReviewDeliveryRequestSchema`
 * above (same `includedVods` field, same client-side cap). The route's own
 * body schema is `.nullish()` on the whole object (Plan 01), so a caller
 * that omits `input` entirely still sends the exact bodyless POST every
 * pre-Phase-21 test/caller relies on — see `deliveries.create` below.
 */
const createSessionDeliveryRequestSchema = z.object({
  includedVods: z.array(z.string().min(1)).max(MAX_DELIVERY_VODS).optional(),
});
export type CreateSessionDeliveryRequest = z.infer<typeof createSessionDeliveryRequestSchema>;

const sessionDeliveryListItemResponseSchema = z.object({
  deliveryId: z.string().min(1),
  status: z.enum(['delivered', 'revoked']),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
  url: z.string().url(),
});
export type SessionDeliveryListItem = z.infer<typeof sessionDeliveryListItemResponseSchema>;

/**
 * GET /api/onboarding/progress response shape (Phase 13, ONBD-04/D-04) —
 * assembled inline in `apps/api/src/routes/onboarding.ts`, not exported
 * from `@smash-tracker/shared`, duplicated here per this file's own
 * `clientWorkspaceExportSchema`/`reviewListItemResponseSchema` precedent
 * above. The four booleans are the SAME `eventDedup` markers the player
 * activation D events write server-side — `GuidedPathCard`/
 * `useOnboardingProgress` must read them as-is, never recompute them from
 * `matches`/`vodTimestamps`/`tournamentEntries` locally (D-04's explicit
 * anti-pattern).
 */
const onboardingProgressSchema = z.object({
  analytics: z.boolean(),
  vod: z.boolean(),
  tournamentPrep: z.boolean(),
  scout: z.boolean(),
});
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;

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
     *
     * Phase 11 walkthrough fix round 1 (FB-3): also accepts
     * `coachingModeEnabled` — the Profile > Account toggle. The response
     * stays `{ uid, email }`; callers that changed the toggle should
     * invalidate/refetch `getMe()` to observe the new value.
     *
     * Phase 13 (ONBD-02/D-01/D-02): also accepts `onboardingIntent` (the
     * `/welcome` chooser's selection) and `onboardingAsked` (asked-vs-
     * context-skipped cohort split). Same invalidate/refetch-`getMe()`
     * convention applies for observing the saved intent.
     */
    upsertMe: (input?: {
      referredByShareId?: string;
      coachingModeEnabled?: boolean;
      onboardingIntent?: OnboardingIntent;
      onboardingAsked?: boolean;
    }) =>
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
    /**
     * POST /api/tournaments/manual-entry (Phase 13, ONBD-04 D-05): the
     * prep-path integration-failure recovery — records an event to prepare
     * for without a start.gg/parry.gg sync, reaching the same
     * server-verified `tournament_prep_activated` outcome. Returns the
     * full written entry (including the server-derived `entryKey`).
     */
    manualEntry: (input: ManualTournamentEntryInput) =>
      apiRequestParsed('/api/tournaments/manual-entry', tournamentEntrySchema, {
        method: 'POST',
        body: manualTournamentEntryInputSchema.parse(input),
      }),
  },
  /**
   * Phase 13 (ONBD-04, D-04): the guided-path checklist's server-derived
   * done-states.
   */
  onboarding: {
    /** GET /api/onboarding/progress — personal-only, always the signed-in user's own activation. */
    getProgress: () => apiRequestParsed('/api/onboarding/progress', onboardingProgressSchema),
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
      /**
       * GET /api/coaching/clients — the signed-in coach's clients. Defaults
       * to non-archived only; pass `true` to also include soft-archived
       * clients (the restore entry point, TEN-06).
       */
      list: (includeArchived?: boolean) =>
        apiRequestParsed(
          `/api/coaching/clients${includeArchived ? '?includeArchived=true' : ''}`,
          clientHubListSchema,
        ),
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
    /**
     * Phase 12 (Coach Reviews & Delivery): coach-side review-authoring
     * routes, nested under `/api/coaching/clients/:clientId/reviews`. Every
     * call takes `clientId` as an explicit argument (never the
     * `X-Active-Subject` header) — these routes gate directly on the URL's
     * `:clientId` param (`requireMembership`, no header), matching
     * `apps/api/src/routes/coachingReviews.ts`'s own documented pattern.
     */
    reviews: {
      /** GET .../reviews — the review + delivery state list for one client (D-05). */
      list: (clientId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews`,
          reviewListItemResponseSchema.array(),
        ),
      /** POST .../reviews — starts a new review draft (the first autosave, revision 0). */
      create: (clientId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews`,
          reviewCreatedResponseSchema,
          { method: 'POST' },
        ),
      /**
       * GET .../reviews/:reviewId/draft — the ONLY composer-side fetch that
       * returns `coachPrivateNotes` (coach-only; REV-03). Never spread into
       * any preview/delivery component's props.
       */
      getDraft: (clientId: string, reviewId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/draft`,
          reviewDraftSchema,
        ),
      /**
       * PATCH .../reviews/:reviewId/draft — autosave (REV-02/D-07). A stale
       * `expectedRevision` maps to a 409 whose body carries `serverDraft`
       * (see `apiRequest`'s `ApiError.details` fallback above) — callers
       * (`useReviewAutosave`) must catch `ApiError` with `status === 409`
       * rather than treating a rejected promise as a generic failure.
       */
      patchDraft: (clientId: string, reviewId: string, input: CreateDraftPatchInput) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/draft`,
          reviewDraftSchema,
          { method: 'PATCH', body: createDraftPatchInputSchema.parse(input) },
        ),
      /** GET .../preview — the exact client-visible render (no private notes; REV-05). */
      preview: (clientId: string, reviewId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/preview`,
          clientVisibleVersionSchema,
        ),
      /** POST .../publish — server-authoritative seal; body carries no content field (D-06/T-12-06). */
      publish: (clientId: string, reviewId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/publish`,
          reviewPublishResultSchema,
          { method: 'POST' },
        ),
      /** POST .../sections/:sectionId/hide — D-03 "Hide section" (content preserved, Undo-able). */
      hideSection: (clientId: string, reviewId: string, sectionId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/sections/${encodeURIComponent(sectionId)}/hide`,
          reviewDraftSchema,
          { method: 'POST' },
        ),
      /** POST .../sections/:sectionId/show — the Undo counterpart; restores in place (never duplicates). */
      showSection: (clientId: string, reviewId: string, sectionId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/sections/${encodeURIComponent(sectionId)}/show`,
          reviewDraftSchema,
          { method: 'POST' },
        ),
      /** POST .../sections — "Add section" (restores a hidden suggested block, or adds General Notes / an optional SSBU-specific section). */
      addSection: (clientId: string, reviewId: string, input: AddReviewSectionRequest) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/sections`,
          reviewDraftSchema,
          { method: 'POST', body: addReviewSectionRequestSchema.parse(input) },
        ),
      /** POST .../archive — removes the review from the active (non-archived) list. */
      archive: (clientId: string, reviewId: string) =>
        apiRequest<void>(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/archive`,
          { method: 'POST' },
        ),
      /**
       * DLV-01: the coach-side delivery-management routes, nested under
       * `.../reviews/:reviewId/deliveries` (`apps/api/src/routes/
       * coachingReviewDeliveries.ts`, plan 04 — response shapes duplicated
       * here per this file's own `clientWorkspaceExportSchema` precedent,
       * not exported from `@smash-tracker/shared`). The Reviews list's
       * delivery overflow menu (D-05: a SEPARATE control from Open) is the
       * only caller.
       */
      deliveries: {
        /** POST .../deliveries — mints a revocable delivery pinned to exactly one published version. */
        create: (clientId: string, reviewId: string, input: CreateReviewDeliveryRequest) =>
          apiRequestParsed(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/deliveries`,
            deliveryCreatedResponseSchema,
            { method: 'POST', body: createReviewDeliveryRequestSchema.parse(input) },
          ),
        /** GET .../deliveries — every delivery ever created for this review, most-recent-first. */
        list: (clientId: string, reviewId: string) =>
          apiRequestParsed(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/deliveries`,
            deliveryListItemResponseSchema.array(),
          ),
        /** POST .../deliveries/:deliveryId/revoke — idempotent soft-revoke. */
        revoke: (clientId: string, reviewId: string, deliveryId: string) =>
          apiRequest<void>(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}/deliveries/${encodeURIComponent(deliveryId)}/revoke`,
            { method: 'POST' },
          ),
      },
    },
    /**
     * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
     * SESS-01/02): coach-side training-session routes, nested under
     * `/api/coaching/clients/:clientId/sessions` — the SAME direct
     * `requireMembership` URL-`:clientId` gating as `coaching.reviews.*`
     * above (`apps/api/src/routes/coachingSessions.ts`). A session is a
     * mutable log (no draft/publish/status machinery, unlike reviews).
     */
    sessions: {
      /** GET .../sessions — a client's training sessions, most-recent-first. */
      list: (clientId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions`,
          sessionResponseSchema.array(),
        ),
      /** POST .../sessions — logs a new session (SESS-01). */
      create: (clientId: string, input: CreateSessionRequest) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions`,
          sessionResponseSchema,
          { method: 'POST', body: createSessionRequestSchema.parse(input) },
        ),
      /** GET .../sessions/:sessionId — read one session. */
      get: (clientId: string, sessionId: string) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}`,
          sessionResponseSchema,
        ),
      /** PATCH .../sessions/:sessionId — in-place edit (mutable log, no version machinery). */
      update: (clientId: string, sessionId: string, input: SessionPatchInput) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}`,
          sessionResponseSchema,
          { method: 'PATCH', body: sessionPatchInputSchema.parse(input) },
        ),
      /** POST .../sessions/:sessionId/homework/:itemId/toggle — flips one item's done-state in place. */
      toggleHomework: (clientId: string, sessionId: string, itemId: string, done: boolean) =>
        apiRequestParsed(
          `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}/homework/${encodeURIComponent(itemId)}/toggle`,
          sessionResponseSchema,
          { method: 'POST', body: { done } },
        ),
      /**
       * SESS-01 (D-10 immutability): the coach-side session
       * delivery-management routes, nested under
       * `.../sessions/:sessionId/deliveries`
       * (`apps/api/src/routes/coachingSessionDeliveries.ts`) — a SIBLING to
       * `coaching.reviews.deliveries` above, never a fork.
       */
      deliveries: {
        /**
         * POST .../deliveries — mints a revocable delivery embedding a
         * FROZEN client-visible snapshot. `input.includedVods` (DLVX-04,
         * Phase 21) is the coach-picked matchId list from
         * `DeliveryVodPicker`; omitting `input` entirely sends the exact
         * bodyless POST every pre-Phase-21 caller still relies on.
         */
        create: (clientId: string, sessionId: string, input?: CreateSessionDeliveryRequest) =>
          apiRequestParsed(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}/deliveries`,
            sessionDeliveryCreatedResponseSchema,
            input !== undefined
              ? { method: 'POST', body: createSessionDeliveryRequestSchema.parse(input) }
              : { method: 'POST' },
          ),
        /** GET .../deliveries — every delivery ever created for this session, most-recent-first. */
        list: (clientId: string, sessionId: string) =>
          apiRequestParsed(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}/deliveries`,
            sessionDeliveryListItemResponseSchema.array(),
          ),
        /** POST .../deliveries/:deliveryId/revoke — idempotent soft-revoke. */
        revoke: (clientId: string, sessionId: string, deliveryId: string) =>
          apiRequest<void>(
            `/api/coaching/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/revoke`,
            { method: 'POST' },
          ),
      },
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
  /**
   * Phase 12 Plan 08 (DLV-02/DLV-04, Rule 2 gap-fill): the anonymous
   * no-account recipient surface for a coach review delivery
   * (`apps/api/src/routes/publicReviewDeliveries.ts`, plan 05) — a SIBLING
   * to `vodShares.getPublic` above (same unauthenticated-read posture,
   * different route family: `/api/review-deliveries/:token`, never
   * `/api/vod-shares/:token`). No web client existed for either route until
   * this plan's own delivery page needed one.
   */
  reviewDeliveries: {
    /** GET /api/review-deliveries/:token — the pinned published-version `kind: 'coachReview'` snapshot. */
    get: (token: string) =>
      apiRequestParsed(
        `/api/review-deliveries/${encodeURIComponent(token)}`,
        publicShareSnapshotSchema,
      ),
    /** POST /api/review-deliveries/:token/ack — idempotent link acknowledgement (D-09). */
    ack: (token: string) =>
      apiRequestParsed(
        `/api/review-deliveries/${encodeURIComponent(token)}/ack`,
        z.object({ acknowledged: z.literal(true) }),
        { method: 'POST' },
      ),
    /**
     * POST /api/review-deliveries/:token/viewed — the crawler-safe
     * Delivered -> Viewed transition (D-09/D-11). Called ONLY from
     * `ReviewDeliveryPage`'s own isReady-gated, fire-once effect — never
     * automatically alongside `get` above.
     */
    markViewed: (token: string) =>
      apiRequestParsed(
        `/api/review-deliveries/${encodeURIComponent(token)}/viewed`,
        z.object({ viewed: z.literal(true) }),
        { method: 'POST' },
      ),
  },
};

/** Public "login with start.gg" entrypoint — a full-page navigation, not an XHR. */
export function getStartggLoginUrl(): string {
  return `${getApiBaseUrl()}/api/auth/startgg/login`;
}

export type { Match };
