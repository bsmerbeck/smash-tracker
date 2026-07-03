import { z } from 'zod';

/**
 * `users/{uid}` node. Previously created by the (now-deleted) Cloud
 * Function's `onCreate` auth trigger as `{ email }`; that behavior is now
 * replaced by an idempotent `PUT /api/users/me` called by the client after
 * sign-in, populated from the verified Firebase ID token's email claim.
 */
export const userSchema = z.object({
  email: z.string().email(),
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
