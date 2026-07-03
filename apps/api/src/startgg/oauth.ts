import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * start.gg OAuth2 (https://developer.start.gg/docs/oauth/):
 * - authorize:  https://start.gg/oauth/authorize (response_type=code)
 * - exchange:   POST https://api.start.gg/oauth/access_token
 * - refresh:    POST https://api.start.gg/oauth/refresh
 * Scopes: identity + email only (there is no match-data scope; set data is
 * public and fetched server-side with our own API token).
 */
export const STARTGG_AUTHORIZE_URL = 'https://start.gg/oauth/authorize';
export const STARTGG_TOKEN_URL = 'https://api.start.gg/oauth/access_token';
export const STARTGG_SCOPES = 'user.identity user.email';

export interface StartggOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
}

/** Mode is carried in the signed state: 'link' attaches to an existing signed-in user; 'login' mints a Firebase custom token afterwards. */
const statePayloadSchema = z.object({
  m: z.enum(['link', 'login']),
  /** Firebase uid — present for 'link' only. */
  u: z.string().optional(),
  /** Expiry, epoch ms. */
  e: z.number().int(),
  /** Nonce. */
  n: z.string(),
});
export type StatePayload = z.infer<typeof statePayloadSchema>;

const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Serializes and signs an OAuth state value (payload.signature, both base64url). */
export function signState(
  secret: string,
  mode: 'link' | 'login',
  uid?: string,
  now = Date.now(),
): string {
  const payload: StatePayload = {
    m: mode,
    ...(uid ? { u: uid } : {}),
    e: now + STATE_TTL_MS,
    n: b64url(randomBytes(8)),
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  return `${encoded}.${b64url(hmac(secret, encoded))}`;
}

/** Verifies signature + expiry and returns the payload, or null when invalid. */
export function verifyState(secret: string, state: string, now = Date.now()): StatePayload | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) {
    return null;
  }
  const expected = hmac(secret, encoded);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  } catch {
    return null;
  }
  const result = statePayloadSchema.safeParse(parsed);
  if (!result.success || result.data.e < now) {
    return null;
  }
  return result.data;
}

export function buildAuthorizeUrl(config: StartggOauthConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: STARTGG_SCOPES,
    redirect_uri: config.redirectUri,
    state,
  });
  return `${STARTGG_AUTHORIZE_URL}?${params.toString()}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().optional(),
});
export type StartggTokens = z.infer<typeof tokenResponseSchema>;

/** Exchanges an authorization code for tokens. */
export async function exchangeCode(
  config: StartggOauthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StartggTokens> {
  const response = await fetchImpl(STARTGG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      scope: STARTGG_SCOPES,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`start.gg token exchange failed with status ${response.status}`);
  }
  return tokenResponseSchema.parse(await response.json());
}
