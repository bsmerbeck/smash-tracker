import { z } from 'zod';
import { userProfileSchema } from '@smash-tracker/shared';

/**
 * Phase 30.3 (Gate 6, web demo-isolation worker): GAP REPORT — as of this
 * worker, NOTHING in `GET /api/users/me` (or any other endpoint the web
 * reads) tells the browser whether the SIGNED-IN caller's own account is one
 * of the login-bearing demo/research accounts. `isDemoAccountSubject`
 * (`apps/api/src/research/demoAccount.ts`) is consulted only at the seven
 * bearer-token mint/resolution chokepoints inside `RtdbService` — it is a
 * pure server-side allowlist check, never surfaced to a route response.
 * `packages/shared`'s `userProfileSchema` (this file's only import from it)
 * has no such field, and there is no custom Firebase Auth claim carrying one
 * either (`AuthContext.tsx` never reads `getIdTokenResult().claims`).
 *
 * The field this worker needs, so a PARALLEL API worker can add it without
 * either side blocking on the other: **`isDemoAccount: boolean`** on the
 * `GET /api/users/me` response (`userProfileSchema`), populated the same way
 * `coachingModeEnabled` already is — always present, defaulted `false`
 * server-side (`isDemoAccountSubject(demoConfig, request.uid)`), never
 * `.nullish()` in the RESPONSE shape (storage-vs-response split precedent:
 * `coachingModeEnabled` is `.nullish()` in `userSchema` but non-nullable
 * here). A demo account needs no stored flag at all — the existing allowlist
 * config already answers the question; the route just needs to call the
 * existing `isDemoAccountSubject` predicate.
 *
 * Exactly the "Gate 5" web-evidence-surfaces precedent
 * (`apps/web/src/lib/enrichmentEvidence.ts`'s doc comment): rather than
 * blocking on that landing, this module EXTENDS the shared response schema
 * locally — `.extend()` on an imported zod object schema is an ordinary use
 * of the shared export, not a modification of the shared package — so:
 *
 *   - today, before the API sends `isDemoAccount`, parsing is unaffected
 *     (the field is `.nullish()` here, read as `false` by
 *     `useIsDemoAccount()`) — every account renders byte-identically to
 *     today, including the four real demo accounts (they simply don't get
 *     the label/disabled-affordance treatment yet);
 *   - the moment the API starts sending it, THIS schema (not the narrower
 *     shared one) is what `api.users.getMe` actually parses responses with
 *     (see `apps/web/src/lib/api.ts`), so the field survives instead of
 *     being silently stripped by zod's default unknown-key behaviour on
 *     `.parse()`/`.safeParse()`.
 *
 * Every consumer of `useProfile()`/`api.users.getMe()` elsewhere in the app
 * keeps working unchanged: `WebUserProfile` is a strict structural
 * SUPERSET of the shared `UserProfile` type, so it's assignable everywhere
 * a `UserProfile` is expected.
 */
export const webUserProfileSchema = userProfileSchema.extend({
  isDemoAccount: z.boolean().nullish(),
});
export type WebUserProfile = z.infer<typeof webUserProfileSchema>;
