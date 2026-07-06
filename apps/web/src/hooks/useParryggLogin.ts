import { useMutation } from '@tanstack/react-query';
import type {
  ParryggLoginCompleteRequest,
  ParryggLoginSearchRequest,
  ParryggLoginStartRequest,
} from '@smash-tracker/shared';
import { api } from '@/lib/api';

/**
 * "Log in with parry.gg" (V8-B) — three mutations backing the login dialog
 * wizard (search gamer tag -> pick candidate -> paste bio code -> verify).
 * All three hit PUBLIC routes (no signed-in user yet), unlike every other
 * `useParrygg*` hook in `useParrygg.ts`, which manage an already-signed-in
 * user's link.
 */

/** Step 1: gamer-tag search — up to 5 candidates. */
export function useParryggLoginSearch() {
  return useMutation({
    mutationFn: (input: ParryggLoginSearchRequest) => api.parrygg.login.search(input),
  });
}

/** Step 2: issues (or resumes, if unexpired) the ST-XXXXXX login code for a chosen candidate. */
export function useParryggLoginStart() {
  return useMutation({
    mutationFn: (input: ParryggLoginStartRequest) => api.parrygg.login.start(input),
  });
}

/** Step 3: checks the bio for the code; on success returns a Firebase custom token to sign in with. */
export function useParryggLoginComplete() {
  return useMutation({
    mutationFn: (input: ParryggLoginCompleteRequest) => api.parrygg.login.complete(input),
  });
}
