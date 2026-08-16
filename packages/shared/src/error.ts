import { z } from 'zod';

/**
 * Standard error response envelope used by apps/api for 400/404/500s.
 * `details` carries zod issue data for validation failures; omitted
 * otherwise so internals aren't leaked.
 *
 * `code` is a STABLE, MACHINE-VERIFIABLE application error identifier. It is
 * OPTIONAL and OPT-IN per refusal site — see {@link ApiErrorCode} below for
 * why it is emitted by exactly one handler today and must not be sprayed
 * across the others.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
  /**
   * Stable machine-readable discriminator for THIS refusal. Absent on every
   * refusal that has not deliberately opted in, so adding it can never make
   * an existing response more informative than it is today.
   */
  code: z.string().min(1).optional(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Phase 30.3 (Gate 6 capture-evidence hardening, item 2): the stable
 * application error codes.
 *
 * WHY THIS EXISTS. The Gate-6 probe-capture operator proves a refusal before
 * it seals a probe asserting "this refused call wrote nothing". It used to
 * accept ANY HTTP 403 as that proof. A CDN, reverse proxy, WAF, or an
 * unrelated authorization failure all return 403 while leaving every RTDB
 * surface untouched — so the probe would pass VACUOUSLY, attesting to a
 * refusal the application never made. Status alone is not evidence; only an
 * identifier the APPLICATION emits is. A human message is not that
 * identifier either: it can be reworded in any release without ceremony,
 * which is precisely what a proof must not be.
 *
 * WHY EXACTLY ONE CODE, AND NOT A CODE ON EVERY REFUSAL. Several refusals in
 * this API are deliberately UNINFORMATIVE. The coaching delivery guards
 * (`routes/coachingReviewDeliveries.ts`, `routes/coachingSessionDeliveries.ts`)
 * throw a byte-identical `NotFoundError` precisely so a caller cannot
 * distinguish "refused because demo" from "no such review" (D-05 no-oracle),
 * and the public bearer-token surfaces answer the same way for an unknown,
 * expired, and revoked token. Attaching a discriminating code to any of those
 * would hand out exactly the oracle they were built to withhold.
 *
 * {@link DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE} is therefore scoped to ONE
 * authenticated, self-addressed path — `POST /api/billing/checkout`'s
 * demo-account guard — where no oracle exists to leak: the route is behind
 * `app.authenticate`, the refusal concerns the CALLER'S OWN account, and that
 * same caller can already read `isDemoAccount: true` from `GET /api/users/me`,
 * which derives it from the very same allowlist. The code tells the caller
 * nothing they were not already entitled to know about themselves, and tells
 * an unauthenticated or non-owning caller nothing at all, because neither can
 * reach the handler.
 *
 * Values are snake_case, matching this project's existing ON-THE-WIRE
 * identifier convention (domain event names such as `checkout_started`)
 * rather than the kebab-case used for internal audit finding codes.
 */
export const DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE = 'demo_account_checkout_forbidden';

/** Every stable application error code. Additive only — never renamed, never reused. */
export const API_ERROR_CODES = [DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
