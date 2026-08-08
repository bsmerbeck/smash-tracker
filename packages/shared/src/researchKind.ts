/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-01/RTEN-06):
 * the ONE cross-tier home for the tenant-kind discriminator vocabulary and
 * its predicate. Review finding 29-01 MEDIUM: a server-only module cannot
 * govern the browser badge/banner plan 29-08 builds, so this lives in
 * `packages/shared` where both `apps/web` and `apps/api` import the SAME
 * definitions rather than each declaring their own copy of the string
 * literals.
 *
 * Two DELIBERATELY DIFFERENT vocabularies:
 *
 * - `CLIENT_TENANT_KINDS` / `ClientTenantKind` — what RTDB actually stores
 *   on `clientTenants/{tenantId}.kind` (see `coachingTenant.ts`). Exactly
 *   TWO members. The field is `.nullish()` (D-01): absence means the
 *   pre-existing legacy 'coaching' state and must remain readable forever
 *   — there is no migration, and no default is ever written for the
 *   coaching branch.
 * - `SUBJECT_KIND_RESOLUTIONS` / `SubjectKindResolution` — what a
 *   server-side lookup (`apps/api/src/research/subjectKind.ts`) or an API
 *   response (`clientHubRowSchema.kind`) asserts. Exactly THREE members,
 *   NEVER absent. The third member, `'unresolved'`, exists so a failed
 *   read, an unparseable stored value, or a malformed id can never be
 *   silently reported as ordinary (review finding 29-01 HIGH) — every
 *   consumer must branch on the unresolved member explicitly, never
 *   inherit a false "ordinary" by omission.
 */
export const CLIENT_TENANT_KINDS = ['coaching', 'research'] as const;
export type ClientTenantKind = (typeof CLIENT_TENANT_KINDS)[number];

export const SUBJECT_KIND_RESOLUTIONS = ['ordinary', 'research', 'unresolved'] as const;
export type SubjectKindResolution = (typeof SUBJECT_KIND_RESOLUTIONS)[number];

/**
 * The ONLY place in the monorepo permitted to compare a value against the
 * research member — every other call site on both tiers imports this
 * predicate rather than re-typing the `'research'` literal. Accepts either
 * vocabulary's members plus `null`/`undefined`; returns `true` ONLY for the
 * research member.
 *
 * Deliberately returns `false` for the unresolved resolution: an unresolved
 * read is not "known to be ordinary," but it is also not "known to be
 * research" — a caller that must fail closed on an unresolved read has to
 * inspect the `SubjectKindResolution` value directly (see
 * `apps/api/src/research/access.ts`'s `assertTenantAccess`), never infer it
 * from this boolean alone.
 *
 * MUST NEVER be invoked from inside `apps/api/src/events/ledger.ts`'s sole
 * writer (`createEvent`) — gating there would silently suppress telemetry
 * for every future caller without an explicit per-call-site decision, the
 * exact anti-pattern the `createClientCore`/`createClient` exclusion-by-
 * construction split (`apps/api/src/coaching/tenants.ts`) exists to avoid.
 */
export function isResearchKind(
  value: ClientTenantKind | SubjectKindResolution | null | undefined,
): boolean {
  return value === 'research';
}
