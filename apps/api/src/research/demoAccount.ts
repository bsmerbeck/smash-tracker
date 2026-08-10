import type { DemoAccountConfig } from '../config/env.js';

/**
 * Phase 30.1 (Demo Account Topology & Migration, RTEN-03 re-scope, review
 * H4): a pure predicate consulted at all SEVEN bearer-token enforcement
 * sites (the three mint writers — `RtdbService.createShare`,
 * `createReviewDelivery`, `createSessionDelivery` — and the four
 * resolution chokepoints — `getShareByToken`, `resolveCoachReviewShareRef`,
 * `resolveSessionShareRef`, `resolveEditSession`, all in
 * `apps/api/src/services/rtdb.ts`) so an allowlisted demo-account uid can
 * never publicly share seeded competitive data, whether by minting a fresh
 * token OR resolving a pre-existing/seeded one.
 *
 * `config === null` means demo enforcement is INACTIVE — NOT "fail-closed"
 * (see `getDemoAccountConfig`'s own doc comment in `../config/env.ts` for
 * the honest framing correction, review H4). Only when the allowlist is
 * configured AND the given uid resolves into it does this return true; the
 * fail-closed guarantee at each enforcement site applies only in that
 * combined case. Every ordinary (non-demo) subject's mint/resolution
 * behavior is completely unchanged regardless of whether the allowlist is
 * configured.
 */
export function isDemoAccountSubject(config: DemoAccountConfig | null, uid: string): boolean {
  if (config === null) {
    return false;
  }
  return config.demoUids.has(uid);
}
