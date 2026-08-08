import { z } from 'zod';

/**
 * Startup environment validation. Fails fast with a readable message if
 * required vars are missing/malformed rather than letting the app boot into
 * a broken state.
 *
 * - `FIREBASE_DATABASE_URL` is always required — it tells the Admin SDK
 *   which Realtime Database instance to talk to (works for both the real
 *   database and the RTDB emulator).
 * - Credentials come from Application Default Credentials, which
 *   `applicationDefault()` resolves automatically: a service account JSON
 *   file when `GOOGLE_APPLICATION_CREDENTIALS` points at one (typical for
 *   local development), or the runtime service account's metadata-server
 *   credentials when running on Cloud Run/GCE/GKE (no env var needed there).
 *   `GOOGLE_APPLICATION_CREDENTIALS` is therefore never required here — it's
 *   also unnecessary for local/emulator use, which is supported via
 *   `FIREBASE_DATABASE_EMULATOR_HOST` and needs no real credentials at all.
 * - `PORT` defaults to 3001 but is read from `process.env.PORT` in
 *   production — Cloud Run injects `PORT` at runtime and the server must
 *   listen on it.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  FIREBASE_DATABASE_URL: z.string().min(1, 'FIREBASE_DATABASE_URL is required'),
  FIREBASE_DATABASE_EMULATOR_HOST: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Comma-separated list of allowed origins, e.g.
  // "https://smash-tracker-f97b7.web.app,https://smash-tracker-f97b7.firebaseapp.com".
  // Production traffic is same-origin via the Firebase Hosting rewrite, so
  // this mainly matters for local dev and as a belt-and-braces fallback.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // ---- start.gg integration (all optional — when incomplete, the
  // /api/integrations/startgg and /api/auth/startgg routes answer 503) -----
  /** OAuth app client id from https://start.gg/admin/profile/developer/applications */
  STARTGG_CLIENT_ID: z.string().optional(),
  STARTGG_CLIENT_SECRET: z.string().optional(),
  /** Must exactly match a redirect URI registered on the start.gg OAuth app. */
  STARTGG_REDIRECT_URI: z.string().optional(),
  /** Server-side API token used to fetch public set data during syncs. */
  STARTGG_API_TOKEN: z.string().optional(),
  /** Secret for HMAC-signing OAuth state; any long random string. */
  STARTGG_STATE_SECRET: z.string().optional(),
  /** SPA origin that OAuth callbacks redirect users back to. */
  WEB_BASE_URL: z.string().default('http://localhost:5173'),

  // ---- V7-B: AI scouting reports (all optional — when incomplete, the
  // /api/reports routes answer 503) ----------------------------------------
  /** Claude API key used to generate scouting reports. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Comma-separated list of Firebase uids allowed to generate AI reports. */
  REPORTS_ALLOWED_UIDS: z.string().optional(),

  // ---- Phase 29 (Research Tenancy, Isolation & Governance Gate) ----------
  /**
   * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): the
   * research-tenant administration allowlist. Comma-separated Firebase uids
   * permitted to create/administer research tenants. Structurally
   * INDEPENDENT of REPORTS_ALLOWED_UIDS above — this allowlist authorizes
   * research-tenant administration ONLY and confers no billing waiver, and
   * REPORTS_ALLOWED_UIDS confers no research administration; the two are
   * NEVER unioned, substituted, or layered. Fail-closed when unset, same
   * all-or-nothing convention as REPORTS_ALLOWED_UIDS/getReportsConfig.
   */
  RESEARCH_ADMIN_UIDS: z.string().optional(),

  // ---- V7-C: Stripe-powered credit packs (all optional — when incomplete,
  // /api/billing routes answer 503 and non-allowlisted uids get the exact
  // pre-V7-C 403 on report generation, i.e. no behavior change) -------------
  /** Stripe secret key used to create Checkout Sessions. */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Signing secret for the `POST /api/billing/webhook` endpoint. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // ---- V8-A: parry.gg integration (optional — when absent, the
  // /api/integrations/parrygg routes answer 503) ---------------------------
  /**
   * parry.gg API key, passed as the `X-API-KEY` call metadata on every
   * gRPC-Web request. There is no OAuth flow for parry.gg — a single
   * server-held key authenticates all reads (linking is proven separately,
   * via a bio-text verification code; see routes/parrygg.ts).
   */
  PARRYGG_API_KEY: z.string().optional(),

  // ---- Phase 7 (Recap Cards & Share-Loop Analytics): GA4 Measurement
  // Protocol server events (optional — when incomplete, review_shared is a
  // silent no-op; unlike the integrations above, absence never 503s a
  // route, since GA4 is instrumentation on an EXISTING product route, not a
  // route that exists solely to serve the integration) ----------------------
  /** GA4 Data Streams -> (web stream) -> Measurement ID (G-XXXXXXX). */
  GA4_MEASUREMENT_ID: z.string().optional(),
  /** GA4 Data Streams -> (web stream) -> Measurement Protocol API secrets. */
  GA4_API_SECRET: z.string().optional(),

  // ---- Phase 10 (Canonical Measurement & Money Safety): Cloud Scheduler ->
  // /internal/jobs/* auth (optional — when unset, the ENTIRE /internal/jobs/*
  // scope answers 503, same all-or-nothing convention as STRIPE_SECRET_KEY).
  // Deliberately a shared secret, not OIDC — avoids a new npm dependency
  // (RESEARCH.md Pattern 4).
  /** Shared secret Cloud Scheduler sends as the X-Internal-Jobs-Secret header. */
  INTERNAL_JOBS_SECRET: z.string().optional(),

  // ---- Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-02):
  // the server-held key that HMAC-digests claim codes at rest. When unset,
  // the ENTIRE claim issuance/redemption surface answers 503, same
  // all-or-nothing convention as INTERNAL_JOBS_SECRET; there is no "silently
  // degrade" mode, because minting or accepting a credential without the key
  // is never acceptable. Rotating this secret invalidates every outstanding
  // claim code by design.
  CLAIM_CODE_HMAC_SECRET: z.string().optional(),

  // ---- Phase 27 (Contextual Paid Prep Reports Behind the Activation Gate,
  // RPT-04): the server-side activation gate for paid prep reports/bundles.
  // Ships UNSET in production — the owner flips it only after the
  // ~2026-08-02 soak review passes. Deliberately a raw string compared for
  // EXACT equality (see `getPrepPaidConfig` below), never coerced to a
  // boolean: a half-configured deployment (a typo'd value, a stray space, an
  // accidental `"1"`/`"yes"`/`"TRUE"`) must fail closed, not silently enable
  // a paid, money-moving surface.
  PREP_PAID_REPORTS_ENABLED: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

/** Splits `CORS_ORIGIN` on commas into a trimmed list of allowed origins. */
export function parseCorsOrigins(corsOrigin: string): string[] {
  return corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export interface StartggConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Server data token for public set queries during syncs. */
  apiToken: string;
  stateSecret: string;
  webBaseUrl: string;
}

/**
 * Assembles the start.gg config when fully present, else null (the routes
 * then respond 503, so a deployment without the integration keeps working).
 */
export function getStartggConfig(env: Env): StartggConfig | null {
  if (
    !env.STARTGG_CLIENT_ID ||
    !env.STARTGG_CLIENT_SECRET ||
    !env.STARTGG_REDIRECT_URI ||
    !env.STARTGG_API_TOKEN ||
    !env.STARTGG_STATE_SECRET
  ) {
    return null;
  }
  return {
    clientId: env.STARTGG_CLIENT_ID,
    clientSecret: env.STARTGG_CLIENT_SECRET,
    redirectUri: env.STARTGG_REDIRECT_URI,
    apiToken: env.STARTGG_API_TOKEN,
    stateSecret: env.STARTGG_STATE_SECRET,
    webBaseUrl: env.WEB_BASE_URL,
  };
}

export interface ReportsConfig {
  anthropicApiKey: string;
  /** Firebase uids allowed to generate AI scouting reports. */
  allowedUids: Set<string>;
}

/**
 * Assembles the AI-reports config when fully present (a key AND a non-empty
 * allowlist), else null (the /api/reports routes then respond 503, same
 * all-or-nothing pattern as `getStartggConfig`) — this is a paid, per-token
 * feature, so it stays opt-in per deployment even once `ANTHROPIC_API_KEY` is
 * set.
 */
export function getReportsConfig(env: Env): ReportsConfig | null {
  if (!env.ANTHROPIC_API_KEY || !env.REPORTS_ALLOWED_UIDS) {
    return null;
  }
  const allowedUids = new Set(
    env.REPORTS_ALLOWED_UIDS.split(',')
      .map((uid) => uid.trim())
      .filter((uid) => uid.length > 0),
  );
  if (allowedUids.size === 0) {
    return null;
  }
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    allowedUids,
  };
}

export interface ResearchConfig {
  /** Firebase uids allowed to create/administer research tenants. */
  adminUids: Set<string>;
}

/**
 * Assembles the research-admin allowlist config (Phase 29, D-04). Mirrors
 * `getReportsConfig` above exactly: returns null when the raw value is
 * absent, empty, or contains only separators/whitespace; splits on comma;
 * trims each entry; filters empty entries. Never coerced through
 * `Boolean(...)`/`!!` truthiness — same explicit warning as
 * `getPrepPaidConfig` below: a stray non-empty string (`"false"`, `"0"`, a
 * typo) must not silently enable research-tenant administration, since this
 * allowlist is itself a plain string presence check, not a boolean flag.
 *
 * This allowlist authorizes research-tenant administration ONLY and confers
 * no billing waiver; `REPORTS_ALLOWED_UIDS`/`getReportsConfig` confers no
 * research administration — the two Sets are NEVER unioned, substituted, or
 * layered (D-04). With `RESEARCH_ADMIN_UIDS` unset, this resolves to null
 * and nothing downstream can grant research-admin rights.
 */
export function getResearchConfig(env: Env): ResearchConfig | null {
  if (!env.RESEARCH_ADMIN_UIDS) {
    return null;
  }
  const adminUids = new Set(
    env.RESEARCH_ADMIN_UIDS.split(',')
      .map((uid) => uid.trim())
      .filter((uid) => uid.length > 0),
  );
  if (adminUids.size === 0) {
    return null;
  }
  return { adminUids };
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

/**
 * Assembles the Stripe config when fully present (a secret key AND a webhook
 * signing secret), else null — same all-or-nothing pattern as
 * `getStartggConfig`/`getReportsConfig`. When null, `/api/billing/*` routes
 * answer 503 and non-allowlisted uids get the same 403 on report generation
 * that existed before V7-C (no behavior change for deployments that don't
 * opt in to billing).
 */
export function getStripeConfig(env: Env): StripeConfig | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return null;
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  };
}

export interface ParryggConfig {
  apiKey: string;
}

/**
 * Assembles the parry.gg config when present, else null — the routes then
 * respond 503, same pattern as `getStartggConfig`. A single env var (no
 * "all-or-nothing" tuple needed, since parry.gg has no OAuth app
 * credentials to configure).
 */
export function getParryggConfig(env: Env): ParryggConfig | null {
  if (!env.PARRYGG_API_KEY) {
    return null;
  }
  return { apiKey: env.PARRYGG_API_KEY };
}

export interface Ga4Config {
  measurementId: string;
  apiSecret: string;
}

/**
 * Assembles the GA4 Measurement Protocol config when fully present (both a
 * measurement id AND an api secret), else null — same all-or-nothing
 * pattern as `getStartggConfig`/`getReportsConfig`/`getStripeConfig`. Unlike
 * those, a null result must NEVER 503 a route: `review_shared` is
 * instrumentation on the existing `POST /api/vod-shares` route, so its
 * caller (`sendMeasurementProtocolEvent`) treats a null config as a silent,
 * per-call no-op, and the one-time "unconfigured" notice is logged once at
 * startup instead (see index.ts) — never per-request.
 */
export function getGa4Config(env: Env): Ga4Config | null {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return null;
  }
  return { measurementId: env.GA4_MEASUREMENT_ID, apiSecret: env.GA4_API_SECRET };
}

export interface InternalJobsConfig {
  secret: string;
}

/**
 * Assembles the `/internal/jobs/*` shared-secret config when present, else
 * null — same all-or-nothing pattern as `getStripeConfig`/`getGa4Config`/
 * `getParryggConfig`. When null, EVERY `/internal/jobs/*` path answers 503
 * (T-10-05-01) — this scope has no "instrumentation on an existing route"
 * exception like GA4 does, since it exists solely to serve
 * Cloud-Scheduler-triggered jobs and must never be silently reachable.
 */
export function getInternalJobsConfig(env: Env): InternalJobsConfig | null {
  if (!env.INTERNAL_JOBS_SECRET) {
    return null;
  }
  return { secret: env.INTERNAL_JOBS_SECRET };
}

export interface ClaimCodeConfig {
  hmacSecret: string;
}

/**
 * Assembles the claim-code HMAC config when present, else null — same
 * all-or-nothing pattern as `getInternalJobsConfig`/`getStripeConfig`. When
 * null, the ENTIRE claim issuance/redemption surface answers 503 (plans 04
 * and 05 register those routes); there is no partial-degrade mode, since
 * minting or accepting a credential without the key is never acceptable.
 */
export function getClaimCodeConfig(env: Env): ClaimCodeConfig | null {
  if (!env.CLAIM_CODE_HMAC_SECRET) {
    return null;
  }
  return { hmacSecret: env.CLAIM_CODE_HMAC_SECRET };
}

/** The single, case-sensitive value that turns paid prep reports on. */
const PREP_PAID_REPORTS_ENABLED_VALUE = 'true';

export interface PrepPaidConfig {
  enabled: true;
}

/**
 * Assembles the paid-prep-reports activation config (RPT-04). This is the
 * first BOOLEAN-style config-null gate in this file — every prior
 * `get*Config` above keys off a SECRET's presence (a value that's either
 * configured or it isn't). This one keys off a plain flag whose value could
 * plausibly be any of several "truthy-looking" strings, so it MUST NOT be
 * "simplified" into a `Boolean(env.PREP_PAID_REPORTS_ENABLED)` or
 * `!!env.PREP_PAID_REPORTS_ENABLED` truthiness check — that would enable the
 * gate on ANY non-empty string (`"false"`, `"0"`, a stray typo), silently
 * turning on a money-moving surface. Only the exact lowercase word `"true"`
 * enables it; every other value (unset, `"TRUE"`, `"1"`, `"yes"`, `"on"`, or
 * a value with surrounding whitespace) leaves it off (27-CONTEXT.md
 * "Activation gate mechanics").
 */
export function getPrepPaidConfig(env: Env): PrepPaidConfig | null {
  if (env.PREP_PAID_REPORTS_ENABLED !== PREP_PAID_REPORTS_ENABLED_VALUE) {
    return null;
  }
  return { enabled: true };
}
