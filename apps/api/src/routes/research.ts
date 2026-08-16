import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clientHubListSchema,
  createClientRequestSchema,
  errorResponseSchema,
  idempotencyKeySchema,
  isPathSafeProviderId,
  RESEARCH_INGESTION_MODES,
  RESEARCH_INGESTION_RUN_STATUSES,
  RESEARCH_MAX_PROVIDER_TEXT,
  RESEARCH_SUPPLEMENT_SOURCE_KINDS,
  researchCoverageResponseSchema,
  researchEnrichmentConfirmRequestSchema,
  researchEnrichmentCoverageResponseSchema,
  researchEnrichmentReviewQueueResponseSchema,
  researchEnrichmentVodCandidateListResponseSchema,
  researchIdentityCandidateSchema,
  researchIdentityConfirmedPlayerSchema,
  researchSupplementRecordSchema,
} from '@smash-tracker/shared';
import { createResearchTenant, listResearchTenants } from '../research/tenants.js';
import { grantEntitlement, revokeEntitlement } from '../research/entitlements.js';
import {
  RESEARCH_FAMILY_REJECTION,
  requireResearchAdmin,
  requireResearchTenantAdmin,
} from '../research/routeGuards.js';
import { isPathSafeTenantId } from '../research/subjectKind.js';
import { ForbiddenError } from '../services/rtdb.js';
import {
  confirmedPlayerIdSet,
  confirmIdentityPlayers,
  readIdentityMapping,
  resolveSeedIdentity,
  revokeConfirmedPlayer,
  selectPrimaryConfirmedPlayerId,
} from '../research/ingestion/identity.js';
import {
  createOrResumeBackfillRun,
  readTenantIngestionState,
} from '../research/ingestion/backfillRun.js';
import { deriveRefreshUpdatedAfterSeconds } from '../research/ingestion/rollup.js';
import {
  deleteSupplement,
  listSupplementsForSet,
  upsertSupplement,
} from '../research/ingestion/supplements.js';
import { composeCoverageResponse } from '../research/coverageResponse.js';
import {
  confirmEnrichmentObservationByAdmin,
  deleteEnrichmentAttachment,
  listAttachmentsForSet,
  listEnrichmentReviewQueue,
  readEnrichmentObservation,
} from '../research/enrichment/store.js';
import { composeEnrichmentCoverageResponse } from '../research/enrichment/rollup.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
} from '../research/enrichment/projection.js';
import {
  confirmVodCandidateByAdmin,
  dismissVodCandidateByAdmin,
  listVodCandidatesForTenant,
  runVodCandidateDiscovery,
  VOD_DISCOVERY_MAX_SETS_PER_RUN,
} from '../research/enrichment/vodDiscovery.js';
import {
  runResearchBackfillBatch,
  TRIGGER_MAX_PAGES_PER_REQUEST,
  TRIGGER_MAX_SYNC_BACKOFF_MS,
} from '../jobs/researchBackfillBatch.js';
import { normalizeStartggPlayerId } from '../startgg/client.js';
import type { StartggConfig, YoutubeConfig } from '../config/env.js';

/**
 * `/api/research/tenants` — Phase 29 (Research Tenancy, Isolation &
 * Governance Gate, RTEN-01) plus Phase 30 Plan 07 (ING-01/ING-02/ING-05):
 * the admin-only research tenant collection routes, the two entitlement
 * routes, and the eleven backfill/identity/supplement/coverage routes that
 * wire the wave-2 ingestion modules and the batch executor into the
 * authenticated admin surface.
 *
 * Registered UNCONDITIONALLY in `apps/api/src/app.ts` — no config-null 503
 * gate at registration time, because route PRESENCE itself must leak
 * nothing. The research-admin config-null check lives inside each handler
 * via `requireResearchAdmin`/`requireResearchTenantAdmin` instead. The
 * start.gg config-null check is a SEPARATE, later gate (see
 * `startggUnavailable` below) that answers a DIFFERENT question — it only
 * ever runs after the dual gate has already passed, because it is a server
 * capability fact, not an authorization fact.
 *
 * `app.addHook('preHandler', app.authenticate)` runs BEFORE every other
 * check, so an unauthenticated caller is rejected by the authentication
 * boundary's OWN distinguishable failure — never the family's uniform
 * rejection (R-11-1, review finding 29-11 HIGH). Deliberately does NOT opt
 * into `app.resolveSubject` — these are admin-scoped routes over the
 * caller's OWN index (`request.uid` directly), not same-subject content
 * routes gated by the `X-Active-Subject` header.
 *
 * Every route validates EVERY path segment with a path-safe predicate in
 * its route schema, not merely by length (review C-H13, extended
 * family-wide per C2-A6): `pathSafeTenantIdSchema` and
 * `pathSafeProviderIdSchema` are declared ONCE below and referenced from
 * every route's `params` schema, so a route added later cannot quietly omit
 * the refinement.
 */

const pathSafeTenantIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isPathSafeTenantId, 'tenantId is not a path-safe key');

const pathSafeProviderIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isPathSafeProviderId, 'value is not a path-safe key');

const createResearchTenantResponseSchema = z.object({
  tenantId: z.string().min(1),
});

const tenantParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
});

const identityPlayerParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  playerId: pathSafeProviderIdSchema,
});

const supplementSetParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  targetSetId: pathSafeProviderIdSchema,
});

const supplementItemParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  targetSetId: pathSafeProviderIdSchema,
  supplementId: pathSafeProviderIdSchema,
});

// ---------------------------------------------------------------------------
// Enrichment review queue / confirm / detach / coverage (Phase 30.2 Plan 10)
// ---------------------------------------------------------------------------

const enrichmentObservationParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  observationId: pathSafeProviderIdSchema,
});

const enrichmentAttachmentParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  targetSetId: pathSafeProviderIdSchema,
  observationId: pathSafeProviderIdSchema,
});

/**
 * The only two 200-eligible members of `EnrichmentStoreOutcome`
 * (`research/enrichment/store.ts`) — every other member of that wider
 * union routes to a 400/404 below rather than reaching this schema, so the
 * response contract cannot silently widen if the store's internal outcome
 * union grows a member this route never intended to expose as a success
 * (the store type is not part of the shared package; it is API-internal).
 */
const enrichmentConfirmResponseSchema = z.object({
  outcome: z.enum(['created', 'replaced']),
});

const enrichmentDetachResponseSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// VOD candidates (30.3 Gate 5) — the admin-only candidates surface
// ---------------------------------------------------------------------------

const vodCandidateParamsSchema = z.object({
  tenantId: pathSafeTenantIdSchema,
  targetSetId: pathSafeProviderIdSchema,
  candidateId: pathSafeProviderIdSchema,
});

const vodCandidateConfirmResponseSchema = z.object({
  outcome: z.enum(['confirmed', 'already-confirmed']),
});

const vodCandidateDismissResponseSchema = z.object({ ok: z.literal(true) });

const vodDiscoverResponseSchema = z.object({
  bound: z.number().int().positive(),
  consideredSets: z.number().int().nonnegative(),
  queriedSets: z.number().int().nonnegative(),
  candidatesWritten: z.number().int().nonnegative(),
  candidatesSkippedExisting: z.number().int().nonnegative(),
  queryFailures: z.number().int().nonnegative(),
});

const grantEntitlementRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

const grantEntitlementResponseSchema = z.object({
  grantId: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
});

const revokeEntitlementRequestSchema = z.object({
  expectedGrantId: z.string().min(1),
});

const revokeEntitlementResponseSchema = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const identityResolveBodySchema = z
  .object({
    slug: z.string().min(1).max(200).optional(),
    playerId: z.string().min(1).max(64).optional(),
  })
  .refine((value) => value.slug != null || value.playerId != null, {
    message: 'either slug or playerId is required',
  });

const identityResolveResponseSchema = z.object({
  playerId: z.string().nullable(),
  gamerTag: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).optional(),
  userSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).optional(),
});

const confirmIdentityPlayerInputSchema = z.object({
  playerId: pathSafeProviderIdSchema,
  gamerTag: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).optional(),
  userSlug: z.string().max(RESEARCH_MAX_PROVIDER_TEXT).optional(),
  knownTagVariants: z.array(z.string().max(100)).max(50).optional(),
  sponsorPrefixes: z.array(z.string().max(100)).max(50).optional(),
  primary: z.boolean().optional(),
});

const identityConfirmBodySchema = z.object({
  players: z.array(confirmIdentityPlayerInputSchema).min(1).max(20),
});

const identityConfirmResponseSchema = z.object({
  confirmedPlayerIds: z.array(z.string()),
  rejectedPlayerIds: z.array(z.string()),
});

const identityGetResponseSchema = z.object({
  confirmedPlayers: z.array(researchIdentityConfirmedPlayerSchema),
  candidates: z.array(researchIdentityCandidateSchema),
});

const revokeIdentityResponseSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

const researchBackfillStopReasonSchema = z.enum([
  'completed',
  'page-budget',
  'lease-held',
  'lease-lost',
  'retryable-write',
  'backoff-pending',
  'infra-error',
  'failed',
  'noop-terminal',
]);

const researchBackfillBatchResultSchema = z.object({
  runId: z.string(),
  status: z.enum(RESEARCH_INGESTION_RUN_STATUSES),
  completed: z.boolean(),
  stopReason: researchBackfillStopReasonSchema,
  retryable: z.boolean(),
  pagesProcessed: z.number().int().nonnegative(),
  setsObserved: z.number().int().nonnegative(),
  cursorPage: z.number().int().nonnegative(),
  totalPages: z.number().int().nullable(),
  throttledMs: z.number().int().nonnegative(),
  backoffEvents: z.number().int().nonnegative(),
  writeRetries: z.number().int().nonnegative(),
  staleWritesSkipped: z.number().int().nonnegative(),
  retryAfterObserved: z.boolean(),
  reason: z.string().nullable(),
});

const backfillTriggerBodySchema = z.object({
  playerId: z.string().min(1).max(64).optional(),
  slug: z.string().min(1).max(200).optional(),
  mode: z.enum(RESEARCH_INGESTION_MODES),
  updatedAfterSeconds: z.number().int().nonnegative().optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
});

const backfillTriggerResponseSchema = z.object({
  runId: z.string(),
  resumed: z.boolean(),
  batch: researchBackfillBatchResultSchema,
});

// Shared 409 shape for the trigger route: covers BOTH the identity-not-
// confirmed refusal (no active-run identity to report) and the busy refusal
// (which names the ACTIVE run rather than a silent resume — review C2-H3).
// The active-run members are optional/nullable so one declared response
// schema serves both refusal reasons without a discriminated union.
const backfillBusyResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.literal(409),
  activeRunId: z.string().nullable().optional(),
  activePlayerId: z.string().nullable().optional(),
  activeMode: z.string().nullable().optional(),
});

const backfillAdvanceBodySchema = z.object({
  runId: pathSafeProviderIdSchema,
  maxPages: z.number().int().min(1).max(50).optional(),
});

const backfillStatusResponseSchema = researchCoverageResponseSchema;

// ---------------------------------------------------------------------------
// Supplements
// ---------------------------------------------------------------------------

const supplementPostBodySchema = z.object({
  targetSetId: pathSafeProviderIdSchema,
  field: z.string().min(1).max(64),
  value: z.string().min(1).max(2000),
  sourceKind: z.enum(RESEARCH_SUPPLEMENT_SOURCE_KINDS),
  note: z.string().max(2000).optional(),
  vodUrl: z
    .string()
    .max(2048)
    .regex(/^https?:\/\//i, 'vodUrl must be an http(s) URL')
    .optional(),
  vodTimestampSeconds: z.number().int().min(0).max(2_592_000).optional(),
});

const supplementPostResponseSchema = z.object({
  outcome: z.enum(['created', 'replaced', 'rejected-key', 'rejected-field', 'rejected-cap']),
  supplementId: z.string().nullable(),
});

const supplementDeleteResponseSchema = z.object({ ok: z.literal(true) });

const supplementListResponseSchema = z.array(researchSupplementRecordSchema);

export interface ResearchRoutesOptions {
  startgg: StartggConfig | null;
  /** Overridable fetch for the start.gg identity-resolution and batch calls (tests). */
  startggFetch?: typeof fetch;
  /**
   * 30.3 Gate 5: the YouTube Data API config for bounded VOD candidate
   * discovery. OPTIONAL and nullable so every existing registration site
   * keeps compiling; when absent (today's production registration in
   * `app.ts` does not pass it yet — see the gate report's wiring note) the
   * discover route answers 503 while the candidates list/confirm/dismiss
   * routes keep working. Both members must be present for discovery: the
   * fetch is injected alongside the key because the discovery module has NO
   * default-fetch path (mirroring the Liquipedia client's compile-time
   * gate).
   */
  youtube?: YoutubeConfig | null;
  youtubeFetch?: typeof fetch;
}

const researchTenantsRoutes: FastifyPluginAsyncZod<ResearchRoutesOptions> = async (
  app,
  options,
) => {
  const { startgg, startggFetch, youtube, youtubeFetch } = options;

  app.addHook('preHandler', app.authenticate);

  // Answers 503 when the start.gg config is null — the caller has already
  // passed the dual gate, so this refusal is a server-capability fact, not
  // an authorization fact. Collapsing it into the family rejection would
  // make a misconfigured deployment indistinguishable from a permissions
  // problem during the owner's own backfill. Returns the BODY only (never
  // calls `reply` itself) so every call site's own typed `reply.code(503)`
  // stays exactly the response schema fastify-type-provider-zod expects for
  // that route.
  function startggUnavailableBody() {
    return {
      error: 'Service Unavailable',
      message: 'start.gg integration is not configured on this server',
      statusCode: 503 as const,
    };
  }

  // After the guard passes, "you have not confirmed who this workspace is"
  // is a domain state the admin must be able to see and act on, not an
  // authorization outcome to hide.
  function identityNotConfirmedBody(detail?: string) {
    return {
      error: 'Conflict',
      message: detail
        ? `Identity mapping is not confirmed for this tenant (resolved id ${detail})`
        : 'Identity mapping is not confirmed for this tenant',
      statusCode: 409 as const,
    };
  }

  // A research workspace may hold several confirmed start.gg player IDs
  // (D-10, the MkLeo pattern), and one `activeRunId` pointer means one
  // advancing run per tenant — an admin who triggers a backfill for their
  // second player ID must be told the first one is still running, never
  // handed the first run's id.
  function backfillBusyBody(active: {
    runId: string | null;
    activePlayerId: string | null;
    activeMode: string | null;
  }) {
    return {
      error: 'Conflict',
      message: 'A backfill is already running for a different confirmed player on this tenant',
      statusCode: 409 as const,
      activeRunId: active.runId,
      activePlayerId: active.activePlayerId,
      activeMode: active.activeMode,
    };
  }

  // POST /api/research/tenants
  app.post(
    '/research/tenants',
    {
      schema: {
        body: createClientRequestSchema,
        response: {
          201: createResearchTenantResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = requireResearchAdmin(request);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const { tenantId } = await createResearchTenant(
        app.firebase.database,
        request.uid,
        request.body.label,
      );
      return reply.code(201).send({ tenantId });
    },
  );

  // GET /api/research/tenants — declares no route parameter and no
  // querystring, mirroring `clientWorkspaces.ts`'s enumeration-proof
  // posture: it accepts no tenantId/uid/clientId of any kind, so
  // cross-uid enumeration is structurally impossible, not merely
  // policy-enforced.
  app.get(
    '/research/tenants',
    {
      schema: {
        response: {
          200: clientHubListSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = requireResearchAdmin(request);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      return listResearchTenants(app.firebase.database, request.uid);
    },
  );

  // POST /api/research/tenants/:tenantId/entitlement/grant — plan 29-10
  // (RTEN-05A). The family's FIRST tenant-addressed routes: reuses
  // `requireResearchTenantAdmin` verbatim (never a second authorization
  // path) so a caller cannot distinguish "not an admin" from "not a
  // member" from "no such tenant" from "not a research tenant".
  //
  // Independence rules (D-04, T-29-10-03): holding this entitlement
  // confers NO administrative capability of any kind, and holding
  // administrative capability (passing this route's own guard) does NOT by
  // itself waive any charge — the entitlement is a third, structurally
  // independent authorization from the research allowlist and tenant
  // membership this guard already checks.
  app.post(
    '/research/tenants/:tenantId/entitlement/grant',
    {
      schema: {
        params: tenantParamsSchema,
        body: grantEntitlementRequestSchema,
        response: {
          200: grantEntitlementResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      try {
        const result = await grantEntitlement(
          app.firebase.database,
          request.params.tenantId,
          request.uid,
          request.body.idempotencyKey,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          // The store's own defense-in-depth "is this actually a research
          // tenant" check (see entitlements.ts's module header) — folded
          // into the SAME family rejection as the guard above, never a
          // second, distinguishable shape or status code.
          return reply
            .code(RESEARCH_FAMILY_REJECTION.statusCode)
            .send(RESEARCH_FAMILY_REJECTION.body);
        }
        throw err;
      }
    },
  );

  // POST /api/research/tenants/:tenantId/entitlement/revoke — plan 29-10
  // (RTEN-05A). Same guard, same uniform-rejection discipline as the grant
  // route above.
  app.post(
    '/research/tenants/:tenantId/entitlement/revoke',
    {
      schema: {
        params: tenantParamsSchema,
        body: revokeEntitlementRequestSchema,
        response: {
          200: revokeEntitlementResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await revokeEntitlement(
        app.firebase.database,
        request.params.tenantId,
        request.body.expectedGrantId,
      );
      return reply.code(200).send(result);
    },
  );

  // ---- identity ---------------------------------------------------------

  // POST /api/research/tenants/:tenantId/identity/resolve — writes NOTHING;
  // resolution proposes and confirmation is a separate call.
  app.post(
    '/research/tenants/:tenantId/identity/resolve',
    {
      schema: {
        params: tenantParamsSchema,
        body: identityResolveBodySchema,
        response: {
          200: identityResolveResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      if (!startgg) {
        return reply.code(503).send(startggUnavailableBody());
      }

      const { slug, playerId } = request.body;
      let resolved: { playerId: string; gamerTag?: string; userSlug?: string } | null = null;
      if (slug != null) {
        resolved = await resolveSeedIdentity(startgg.apiToken, { slug }, startggFetch);
      } else if (playerId != null) {
        const numeric = normalizeStartggPlayerId(playerId);
        resolved =
          numeric != null
            ? await resolveSeedIdentity(startgg.apiToken, { playerId: numeric }, startggFetch)
            : null;
      }

      return reply.code(200).send(resolved ?? { playerId: null });
    },
  );

  // POST /api/research/tenants/:tenantId/identity/confirm
  app.post(
    '/research/tenants/:tenantId/identity/confirm',
    {
      schema: {
        params: tenantParamsSchema,
        body: identityConfirmBodySchema,
        response: {
          200: identityConfirmResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await confirmIdentityPlayers(
        app.firebase.database,
        request.params.tenantId,
        request.uid,
        request.body.players,
      );
      return reply.code(200).send(result);
    },
  );

  // GET /api/research/tenants/:tenantId/identity — confirmed players and
  // unconfirmed candidates, both sorted deterministically by player id.
  app.get(
    '/research/tenants/:tenantId/identity',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: identityGetResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const mapping = await readIdentityMapping(app.firebase.database, request.params.tenantId);
      const confirmedPlayers = Object.values(mapping.confirmedPlayerIds ?? {}).sort((a, b) =>
        a.playerId.localeCompare(b.playerId),
      );
      const candidates = Object.values(mapping.candidates ?? {}).sort((a, b) =>
        a.playerId.localeCompare(b.playerId),
      );
      return reply.code(200).send({ confirmedPlayers, candidates });
    },
  );

  // DELETE /api/research/tenants/:tenantId/identity/:playerId — idempotent.
  app.delete(
    '/research/tenants/:tenantId/identity/:playerId',
    {
      schema: {
        params: identityPlayerParamsSchema,
        response: {
          200: revokeIdentityResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await revokeConfirmedPlayer(
        app.firebase.database,
        request.params.tenantId,
        request.params.playerId,
      );
      return reply.code(200).send(result);
    },
  );

  // ---- backfill -----------------------------------------------------------

  // POST /api/research/tenants/:tenantId/backfill/trigger — VALIDATE-THEN-
  // CREATE (review C3-H1): every check below runs BEFORE
  // `createOrResumeBackfillRun`, so a request that fails one of them creates
  // no run row at all. This route closes the front door by never minting a
  // bad run; the executor's acquire-before-validate ordering closes the
  // internal-job door, which addresses a run that already exists.
  app.post(
    '/research/tenants/:tenantId/backfill/trigger',
    {
      schema: {
        params: tenantParamsSchema,
        body: backfillTriggerBodySchema,
        response: {
          200: backfillTriggerResponseSchema,
          404: errorResponseSchema,
          409: backfillBusyResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      if (!startgg) {
        return reply.code(503).send(startggUnavailableBody());
      }

      const database = app.firebase.database;
      const { tenantId } = request.params;
      const { playerId, slug, mode, updatedAfterSeconds, maxPages } = request.body;

      const mapping = await readIdentityMapping(database, tenantId);
      const confirmedIds = confirmedPlayerIdSet(mapping);
      if (confirmedIds.size === 0) {
        return reply.code(409).send(identityNotConfirmedBody());
      }

      let targetPlayerId: string;
      if (playerId != null) {
        // A trigger can never name an unconfirmed id (D-10, D-11).
        if (!confirmedIds.has(playerId)) {
          return reply.code(409).send(identityNotConfirmedBody());
        }
        targetPlayerId = playerId;
      } else if (slug != null) {
        // review C-H9c: a slug is a lookup key, never an authorization to
        // ingest — it must resolve to a CONFIRMED id.
        const resolved = await resolveSeedIdentity(startgg.apiToken, { slug }, startggFetch);
        if (!resolved) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'start.gg slug did not resolve to a player',
            statusCode: 404,
          });
        }
        if (!confirmedIds.has(resolved.playerId)) {
          return reply.code(409).send(identityNotConfirmedBody(resolved.playerId));
        }
        targetPlayerId = resolved.playerId;
      } else {
        // Neither supplied — the single exported resolver with its
        // deterministic fallback (review C-M4). Never scan for a primary
        // flag inline.
        const primary = selectPrimaryConfirmedPlayerId(mapping);
        if (!primary) {
          return reply.code(409).send(identityNotConfirmedBody());
        }
        targetPlayerId = primary;
      }

      // Refresh mode with no caller-supplied window derives one from the
      // last completed run for THIS player id (review C-M6, C2-H3) — never
      // from the tenant's latest run, which could belong to a different
      // confirmed player and silently skip everything older with no error.
      let effectiveUpdatedAfterSeconds = updatedAfterSeconds;
      if (mode === 'refresh' && effectiveUpdatedAfterSeconds == null) {
        const state = await readTenantIngestionState(database, tenantId);
        effectiveUpdatedAfterSeconds =
          deriveRefreshUpdatedAfterSeconds(state, targetPlayerId) ?? undefined;
      }

      const createResult = await createOrResumeBackfillRun(database, {
        tenantId,
        playerId: targetPlayerId,
        requestedByUid: request.uid,
        mode,
        ...(effectiveUpdatedAfterSeconds != null
          ? { updatedAfterSeconds: effectiveUpdatedAfterSeconds }
          : {}),
      });

      if (createResult.outcome === 'busy') {
        // Answer with the ACTIVE run's identity rather than a silent resume
        // (review C2-H3) — issues no batch.
        return reply.code(409).send(
          backfillBusyBody({
            runId: createResult.runId,
            activePlayerId: createResult.activePlayerId,
            activeMode: createResult.activeMode,
          }),
        );
      }

      // CAP the synchronous batch at TRIGGER_MAX_PAGES_PER_REQUEST regardless
      // of a larger `maxPages` in the body (review C-M7), AND pass
      // TRIGGER_MAX_SYNC_BACKOFF_MS (review C2-A3) — the page cap bounds the
      // WORK, the sleep budget bounds the REQUEST; only the second one
      // actually protects the ~60s Hosting rewrite window. A `backoff-
      // pending` result is returned as a normal 200 batch result with its
      // `retryable` member set — the run is intact and the caller simply
      // advances again via `/advance` or the internal job.
      const cappedMaxPages = Math.min(
        maxPages ?? TRIGGER_MAX_PAGES_PER_REQUEST,
        TRIGGER_MAX_PAGES_PER_REQUEST,
      );
      const batch = await runResearchBackfillBatch(
        database,
        startgg.apiToken,
        tenantId,
        createResult.runId!,
        {
          maxPagesPerInvocation: cappedMaxPages,
          maxSyncBackoffMs: TRIGGER_MAX_SYNC_BACKOFF_MS,
          fetchImpl: startggFetch,
        },
      );

      return reply
        .code(200)
        .send({ runId: createResult.runId!, resumed: createResult.resumed, batch });
    },
  );

  // POST /api/research/tenants/:tenantId/backfill/advance — repeated
  // bounded-batch invocations for a run that already exists (D-06).
  app.post(
    '/research/tenants/:tenantId/backfill/advance',
    {
      schema: {
        params: tenantParamsSchema,
        body: backfillAdvanceBodySchema,
        response: {
          200: researchBackfillBatchResultSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      if (!startgg) {
        return reply.code(503).send(startggUnavailableBody());
      }

      const cappedMaxPages = Math.min(
        request.body.maxPages ?? TRIGGER_MAX_PAGES_PER_REQUEST,
        TRIGGER_MAX_PAGES_PER_REQUEST,
      );
      const batch = await runResearchBackfillBatch(
        app.firebase.database,
        startgg.apiToken,
        request.params.tenantId,
        request.body.runId,
        {
          maxPagesPerInvocation: cappedMaxPages,
          maxSyncBackoffMs: TRIGGER_MAX_SYNC_BACKOFF_MS,
          fetchImpl: startggFetch,
        },
      );
      return reply.code(200).send(batch);
    },
  );

  // GET /api/research/tenants/:tenantId/backfill/status — a bounded
  // single-node read; never a scan.
  app.get(
    '/research/tenants/:tenantId/backfill/status',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: backfillStatusResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      return reply
        .code(200)
        .send(await composeCoverageResponse(app.firebase.database, request.params.tenantId));
    },
  );

  // GET /api/research/tenants/:tenantId/coverage — plan 30-06's panel calls
  // this endpoint.
  app.get(
    '/research/tenants/:tenantId/coverage',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: researchCoverageResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      return reply
        .code(200)
        .send(await composeCoverageResponse(app.firebase.database, request.params.tenantId));
    },
  );

  // ---- supplements --------------------------------------------------------

  // POST /api/research/tenants/:tenantId/supplements — `attributedToUid` is
  // taken from `request.uid` server-side and NEVER from the body.
  app.post(
    '/research/tenants/:tenantId/supplements',
    {
      schema: {
        params: tenantParamsSchema,
        body: supplementPostBodySchema,
        response: {
          200: supplementPostResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await upsertSupplement(app.firebase.database, request.params.tenantId, {
        ...request.body,
        attributedToUid: request.uid,
      });

      if (
        result.outcome === 'rejected-key' ||
        result.outcome === 'rejected-field' ||
        result.outcome === 'rejected-cap'
      ) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `supplement rejected: ${result.outcome}`,
          statusCode: 400,
        });
      }

      return reply.code(200).send(result);
    },
  );

  // DELETE /api/research/tenants/:tenantId/supplements/:targetSetId/:supplementId — idempotent.
  app.delete(
    '/research/tenants/:tenantId/supplements/:targetSetId/:supplementId',
    {
      schema: {
        params: supplementItemParamsSchema,
        response: {
          200: supplementDeleteResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await deleteSupplement(
        app.firebase.database,
        request.params.tenantId,
        request.params.targetSetId,
        request.params.supplementId,
      );
      return reply.code(200).send(result);
    },
  );

  // GET /api/research/tenants/:tenantId/supplements/:targetSetId
  app.get(
    '/research/tenants/:tenantId/supplements/:targetSetId',
    {
      schema: {
        params: supplementSetParamsSchema,
        response: {
          200: supplementListResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const list = await listSupplementsForSet(
        app.firebase.database,
        request.params.tenantId,
        request.params.targetSetId,
      );
      return reply.code(200).send(list);
    },
  );

  // ---- enrichment (Phase 30.2 Plan 10, ENR-06) -----------------------------

  // GET /api/research/tenants/:tenantId/enrichment/review — the admin
  // review queue: every observation `listEnrichmentReviewQueue` selects by
  // attachment ABSENCE (never by the observation's own stored
  // `matchingStatus`, `store.ts`'s own contract), sorted deterministically
  // so the surface is reviewable across sessions — a stable order is what
  // lets an admin resume a review pass without re-scanning items already
  // seen (T-30.2 review queue, plan 10 action).
  app.get(
    '/research/tenants/:tenantId/enrichment/review',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: researchEnrichmentReviewQueueResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const queue = await listEnrichmentReviewQueue(app.firebase.database, request.params.tenantId);
      const sorted = sortEnrichmentReviewQueue(queue);
      return reply.code(200).send({
        observations: sorted,
        counts: countEnrichmentReviewQueue(sorted),
      });
    },
  );

  // POST /api/research/tenants/:tenantId/enrichment/review/:observationId/confirm
  // — the SECOND and only other authorization door onto projection
  // (`store.ts`'s `confirmEnrichmentObservationByAdmin`): the caller names
  // exactly one candidate already recorded on the observation itself; the
  // store refuses (`rejected-candidate`, no write) a target set id outside
  // that recorded list.
  app.post(
    '/research/tenants/:tenantId/enrichment/review/:observationId/confirm',
    {
      schema: {
        params: enrichmentObservationParamsSchema,
        body: researchEnrichmentConfirmRequestSchema,
        response: {
          200: enrichmentConfirmResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await confirmEnrichmentObservationByAdmin(
        app.firebase.database,
        request.params.tenantId,
        request.params.observationId,
        request.body.targetSetId,
        request.uid,
        Date.now(),
      );

      if (result.outcome === 'created' || result.outcome === 'replaced') {
        return reply.code(200).send({ outcome: result.outcome });
      }
      if (result.outcome === 'rejected-candidate') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'targetSetId is not among the observation’s recorded candidates',
          statusCode: 400,
        });
      }
      // 'rejected-key' / 'rejected-not-attachable', or any defensive future
      // member of the store's outcome union this route never intentionally
      // returns — treated as "not found", never a 500.
      return reply.code(404).send({
        error: 'Not Found',
        message: 'observation not found',
        statusCode: 404,
      });
    },
  );

  // DELETE /api/research/tenants/:tenantId/enrichment/attachments/:targetSetId/:observationId
  // — detaches without deleting the observation itself; idempotent, and the
  // observation reappears in the review queue on the very next read
  // (`store.ts`'s `deleteEnrichmentAttachment` doc comment).
  app.delete(
    '/research/tenants/:tenantId/enrichment/attachments/:targetSetId/:observationId',
    {
      schema: {
        params: enrichmentAttachmentParamsSchema,
        response: {
          200: enrichmentDetachResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await deleteEnrichmentAttachment(
        app.firebase.database,
        request.params.tenantId,
        request.params.targetSetId,
        request.params.observationId,
      );
      return reply.code(200).send(result);
    },
  );

  // ---- VOD candidates (30.3 Gate 5) ---------------------------------------

  /** Rebuilds the set's overlay from its stored attachments and re-applies the projection — the one re-projection helper the confirm/dismiss routes share, so a candidate decision takes effect immediately through the ordinary witness discipline (the applier's own priority-5 merge reads the candidate tree). */
  async function reprojectSetAfterCandidateDecision(
    tenantId: string,
    targetSetId: string,
  ): Promise<void> {
    const attachments = await listAttachmentsForSet(app.firebase.database, tenantId, targetSetId);
    const observationsById: Record<
      string,
      NonNullable<Awaited<ReturnType<typeof readEnrichmentObservation>>>
    > = {};
    for (const attachment of attachments) {
      const record = await readEnrichmentObservation(
        app.firebase.database,
        tenantId,
        attachment.observationId,
      );
      if (record) {
        observationsById[attachment.observationId] = record;
      }
    }
    const overlay = buildEnrichmentOverlay({
      targetSetId,
      attachments,
      observations: observationsById,
    });
    await applyEnrichmentProjection(
      app.firebase.database,
      tenantId,
      targetSetId,
      overlay,
      Date.now(),
    );
  }

  // GET /api/research/tenants/:tenantId/enrichment/vod-candidates — every
  // persisted candidate for the tenant (all statuses), deterministically
  // ordered, plus per-status tallies over exactly what the list contains.
  app.get(
    '/research/tenants/:tenantId/enrichment/vod-candidates',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: researchEnrichmentVodCandidateListResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      const candidates = await listVodCandidatesForTenant(
        app.firebase.database,
        request.params.tenantId,
      );
      let proposed = 0;
      let confirmed = 0;
      let dismissed = 0;
      for (const candidate of candidates) {
        if (candidate.status === 'proposed') proposed += 1;
        else if (candidate.status === 'confirmed') confirmed += 1;
        else dismissed += 1;
      }
      return reply.code(200).send({
        candidates,
        counts: { proposed, confirmed, dismissed, total: candidates.length },
      });
    },
  );

  // POST /api/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId/confirm
  // — the explicit human door onto candidate projection: identifiers only,
  // the stored candidate is reloaded and stamped
  // (`confirmVodCandidateByAdmin`), and the set is immediately re-projected
  // so the confirmation takes effect through the ordinary witness
  // discipline — the candidate URL fills ONLY rows no stronger source
  // covers (priorities 1–4 all outrank it).
  app.post(
    '/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId/confirm',
    {
      schema: {
        params: vodCandidateParamsSchema,
        response: {
          200: vodCandidateConfirmResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      const result = await confirmVodCandidateByAdmin(
        app.firebase.database,
        request.params.tenantId,
        request.params.targetSetId,
        request.params.candidateId,
        request.uid,
        Date.now(),
      );
      if (result.outcome === 'confirmed' || result.outcome === 'already-confirmed') {
        await reprojectSetAfterCandidateDecision(
          request.params.tenantId,
          request.params.targetSetId,
        );
        return reply.code(200).send({ outcome: result.outcome });
      }
      return reply.code(404).send({
        error: 'Not Found',
        message: 'candidate not found',
        statusCode: 404,
      });
    },
  );

  // DELETE /api/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId
  // — dismisses a candidate (idempotent) and re-applies the set's
  // projection, so a previously confirmed-and-projected URL is removed
  // through the witness discipline rather than left dangling.
  app.delete(
    '/research/tenants/:tenantId/enrichment/vod-candidates/:targetSetId/:candidateId',
    {
      schema: {
        params: vodCandidateParamsSchema,
        response: {
          200: vodCandidateDismissResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      await dismissVodCandidateByAdmin(
        app.firebase.database,
        request.params.tenantId,
        request.params.targetSetId,
        request.params.candidateId,
        request.uid,
        Date.now(),
      );
      await reprojectSetAfterCandidateDecision(request.params.tenantId, request.params.targetSetId);
      return reply.code(200).send({ ok: true });
    },
  );

  // POST /api/research/tenants/:tenantId/enrichment/vod-candidates/discover
  // — ONE bounded discovery pass (recent-first unmatched sets,
  // VOD_DISCOVERY_MAX_SETS_PER_RUN at most; the bound is echoed on the
  // report). 503 when the YouTube Data API config (or its injected fetch)
  // is absent — discovery is then DISABLED, never approximated by scraping.
  app.post(
    '/research/tenants/:tenantId/enrichment/vod-candidates/discover',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: vodDiscoverResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }
      if (!youtube || !youtubeFetch) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'YouTube candidate discovery is not configured on this server',
          statusCode: 503,
        });
      }
      const report = await runVodCandidateDiscovery(
        app.firebase.database,
        request.params.tenantId,
        { config: youtube, fetchImpl: youtubeFetch },
        Date.now(),
        VOD_DISCOVERY_MAX_SETS_PER_RUN,
      );
      return reply.code(200).send(report);
    },
  );

  // GET /api/research/tenants/:tenantId/enrichment/coverage — the published
  // enrichment snapshot (`research/enrichment/rollup.ts`'s
  // `researchEnrichmentCoverage/{tenantId}` node), `null` when the tenant
  // has no enrichment run yet.
  app.get(
    '/research/tenants/:tenantId/enrichment/coverage',
    {
      schema: {
        params: tenantParamsSchema,
        response: {
          200: researchEnrichmentCoverageResponseSchema.nullable(),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const coverage = await composeEnrichmentCoverageResponse(
        app.firebase.database,
        request.params.tenantId,
      );
      return reply.code(200).send(coverage);
    },
  );
};

/**
 * Sorts the review queue deterministically by matching status, then source
 * page title, then bracket key, then observation id — a stable order is
 * what makes the admin surface reviewable across sessions (plan 10
 * action). `matchingStatus`/`bracketKey` compare on their raw string value;
 * an absent `bracketKey` sorts as the empty string, always first within its
 * matching-status/page group rather than throwing on `undefined`.
 */
function sortEnrichmentReviewQueue<
  T extends {
    matchingStatus: string;
    sourcePageTitle: string;
    bracketKey?: string | null;
    observationId: string;
  },
>(queue: T[]): T[] {
  return [...queue].sort((a, b) => {
    return (
      a.matchingStatus.localeCompare(b.matchingStatus) ||
      a.sourcePageTitle.localeCompare(b.sourcePageTitle) ||
      (a.bracketKey ?? '').localeCompare(b.bracketKey ?? '') ||
      a.observationId.localeCompare(b.observationId)
    );
  });
}

/** Tenant-wide tallies over exactly what the queue itself contains (never the tenant's full coverage counters). */
function countEnrichmentReviewQueue<T extends { matchingStatus: string }>(
  queue: T[],
): { ambiguous: number; conflicting: number; unmatched: number; total: number } {
  let ambiguous = 0;
  let conflicting = 0;
  let unmatched = 0;
  for (const observation of queue) {
    if (observation.matchingStatus === 'ambiguous') {
      ambiguous += 1;
    } else if (observation.matchingStatus === 'conflicting') {
      conflicting += 1;
    } else if (observation.matchingStatus === 'unmatched') {
      unmatched += 1;
    }
  }
  return { ambiguous, conflicting, unmatched, total: queue.length };
}

export default researchTenantsRoutes;
