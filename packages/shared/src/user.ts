import { z } from 'zod';

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
 */
export const userSchema = z.object({
  email: z.string().email(),
  referredByShareId: z.string().nullish(),
});
export type User = z.infer<typeof userSchema>;

/**
 * GET /api/users/me response: the user node plus their fighter selections,
 * for a single profile fetch.
 */
export const userProfileSchema = z.object({
  uid: z.string().min(1),
  email: z.string().email(),
  fighters: z.object({
    primary: z.array(z.number().int().positive()),
    secondary: z.array(z.number().int().positive()),
  }),
});
export type UserProfile = z.infer<typeof userProfileSchema>;
