import { z } from 'zod';

/**
 * Phase 13 (Coach-Aware Intent Onboarding, ONBD-02/D-01): the five locked
 * onboarding intents a new account can select from `/welcome`. Deliberately
 * closed — CONTEXT.md's stop hypothesis treats the chooser as cheap to
 * remove/simplify, and any additional intents beyond these five are
 * explicitly deferred (see 13-CONTEXT.md's Deferred Ideas).
 */
export const ONBOARDING_INTENTS = [
  'prepare',
  'review_vod',
  'track_improvement',
  'scout',
  'coach_clients',
] as const;
export type OnboardingIntent = (typeof ONBOARDING_INTENTS)[number];

/**
 * `users/{uid}` node. Previously created by the (now-deleted) Cloud
 * Function's `onCreate` auth trigger as `{ email }`; that behavior is now
 * replaced by an idempotent `PUT /api/users/me` called by the client after
 * sign-in, populated from the verified Firebase ID token's email claim.
 *
 * Phase 7 (Recap Cards & Share-Loop Analytics): `referredByShareId` is a
 * write-once, first-touch attribution field (FUNNEL-02) — `.nullish()` per
 * the conditional-spread RTDB write discipline (CONCERNS.md); once set by
 * `RtdbService.upsertUser`, it is never overwritten by a later call.
 *
 * Phase 11 walkthrough fix round 1 (FB-3): `coachingModeEnabled` gates the
 * Topbar's Personal/Coaching switch and the `/coach/*` routes behind an
 * explicit opt-in (Profile > Account) — beginners never see coaching UI by
 * default. `.nullish()` per the same conditional-spread discipline: absent
 * (never written, or explicitly cleared) means disabled.
 *
 * Phase 13 (ONBD-02): `onboardingIntent` mirrors `coachingModeEnabled`'s
 * exact two-schema shape — `.nullish()` here (storage), never a literal
 * `null` write (production-gap item 3); absent means no intent saved yet.
 */
export const userSchema = z.object({
  email: z.string().email(),
  referredByShareId: z.string().nullish(),
  coachingModeEnabled: z.boolean().nullish(),
  onboardingIntent: z.enum(ONBOARDING_INTENTS).nullish(),
});
export type User = z.infer<typeof userSchema>;

/**
 * GET /api/users/me response: the user node plus their fighter selections,
 * for a single profile fetch. `coachingModeEnabled` is always present here
 * (defaulted `false` server-side) even though the underlying storage field
 * is nullish — callers should never need an `?? false` of their own.
 *
 * Phase 13 (ONBD-02): `onboardingIntent` follows the same always-present
 * convention — the API defaults it to `null` when unset, so routing/client
 * logic can rely on the field existing without an `?? null` of its own.
 */
export const userProfileSchema = z.object({
  uid: z.string().min(1),
  email: z.string().email(),
  fighters: z.object({
    primary: z.array(z.number().int().positive()),
    secondary: z.array(z.number().int().positive()),
  }),
  coachingModeEnabled: z.boolean(),
  onboardingIntent: z.enum(ONBOARDING_INTENTS).nullable(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;
