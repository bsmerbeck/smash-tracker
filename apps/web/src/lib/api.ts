import type { z } from 'zod';
import {
  errorResponseSchema,
  fighterSelectionSchema,
  matchSchema,
  opponentListSchema,
  userProfileSchema,
  type CreateMatchInput,
  type FighterSelectionInput,
  type Match,
  type UpdateMatchInput,
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

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
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
  },
};

export type { Match };
