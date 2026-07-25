import { z } from 'zod';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity): the wire contract for
 * a managed-client subject tenant, its separate membership record, and the
 * compact Client Hub row a coach sees when listing their clients.
 *
 * Naming: `Coaching`/`Tenant`/`Client` only — NEVER a bare `Coach*`
 * identifier. Phase 8's existing attribution vocabulary (see match.ts and
 * its sibling notes route) already owns that prefix for an unrelated
 * concept (an anonymous edit-tier share reviewer's attribution). This
 * module's "coach" is an authenticated grandfinals.gg account managing a
 * managed-client tenant — a different actor, a different concept, and must
 * never collide.
 *
 * RTDB layout (TEN-01: coach-independent tenant id, membership kept in
 * separate, swappable records so a future claim/delegation changes
 * membership, never data location):
 *
 * - `clientTenants/{tenantId}`             -> ClientTenantRecord (tenant metadata)
 * - `clientMembers/{tenantId}/{coachUid}`  -> ClientMembership (swappable membership)
 * - `coachClients/{coachUid}/{tenantId}`   -> CoachClientEntry (per-coach index/label)
 *
 * TEN-03 redaction-by-shape: `clientHubRowSchema` is a purpose-built response
 * schema that structurally OMITS coachUid, membership internals, and any
 * client PII beyond the display label — a leak requires adding a field, not
 * forgetting a filter.
 */

/** `clientTenants/{tenantId}` — coach-independent tenant metadata (TEN-01). */
export const clientTenantRecordSchema = z.object({
  /** Epoch ms the tenant was created — server-stamped on create. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms the tenant was archived, or absent/null if active. */
  archivedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 23: the claiming client's uid, or absent/null if unclaimed. Gives
   * an O(1) claimed-vs-managed answer without scanning `clientMembers/{tenantId}`
   * for a role, and is written ONLY inside the winning redemption's single
   * multi-path update (never as a bare null on any other write path that
   * touches `clientTenants`).
   */
  ownerUid: z.string().min(1).nullish(),
  /**
   * Phase 23: epoch ms the tenant was claimed, or absent/null if unclaimed.
   * Same write-site discipline as `ownerUid` above.
   */
  claimedAt: z.number().int().nonnegative().nullish(),
});
export type ClientTenantRecord = z.infer<typeof clientTenantRecordSchema>;

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition): the widened
 * membership role space. `custodian` is the coach-created, pre-claim state
 * (Phase 11 default, the only value any existing stored record holds);
 * `owner` is the client account that redeemed a claim code and now holds
 * logical primary control of the tenant; `delegate` is the issuing coach
 * after the claim, whose access is explicit, revocable, and no longer
 * custodial.
 */
export const CLIENT_TENANT_ROLES = ['custodian', 'owner', 'delegate'] as const;
export type ClientTenantRole = (typeof CLIENT_TENANT_ROLES)[number];

/**
 * `clientMembers/{tenantId}/{coachUid}` — the swappable membership record a
 * claim/delegation mutates. `role` was a literal-of-one ('custodian') at
 * Foundation, deliberately modeled as an enum-of-one so a future role
 * addition wouldn't require a schema migration — Phase 23 is that future:
 * the widening to `CLIENT_TENANT_ROLES` is purely additive, every stored
 * record keeps `role: 'custodian'` until claimed, and no data migration is
 * required.
 */
export const clientMembershipSchema = z.object({
  role: z.enum(CLIENT_TENANT_ROLES),
  /** Epoch ms this membership was established. */
  joinedAt: z.number().int().nonnegative(),
});
export type ClientMembership = z.infer<typeof clientMembershipSchema>;

/**
 * `coachClients/{coachUid}/{tenantId}` — the per-coach index entry driving
 * "my clients" listings. `label` is the coach-chosen display name (1-40
 * chars, trimmed, uniqueness enforced server-side at write time).
 */
export const coachClientEntrySchema = z.object({
  label: z.string().trim().min(1).max(40),
  /** Epoch ms this entry was created — mirrors the tenant's own createdAt. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms this entry was archived, or absent/null if active. */
  archivedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 23: epoch ms the tenant was claimed, or absent/null if unclaimed.
   * Lets Phase 24's Client Hub render claimed status without a second RTDB
   * hop.
   */
  claimedAt: z.number().int().nonnegative().nullish(),
});
export type CoachClientEntry = z.infer<typeof coachClientEntrySchema>;

/** POST /api/coaching/clients request body — creation requires only a display label. */
export const createClientRequestSchema = z.object({
  label: z.string().trim().min(1).max(40),
});
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

/**
 * A single row of the Client Hub listing (TEN-03, TEN-05). Purpose-built by
 * explicit field selection — contains ONLY non-sensitive fields a coach
 * needs to browse/search their client list. Delivery/next-action fields are
 * modeled as nullish now since delivery ships in Phase 12; the shape stays
 * forward-compatible without ever admitting coachUid, membership internals,
 * or client PII beyond the label.
 */
export const clientHubRowSchema = z.object({
  clientId: z.string().min(1),
  label: z.string().min(1),
  /** Epoch ms of the client's most recent activity, or absent/null if none yet. */
  lastActivityAt: z.number().int().nonnegative().nullish(),
  /** Count of draft reviews in progress for this client (Phase 12 delivers review authoring). */
  draftCount: z.number().int().nonnegative(),
  /** Delivery/acknowledgement state for the most recent delivered review — absent until Phase 12 ships delivery. */
  deliveryState: z.enum(['none', 'delivered', 'acknowledged']).nullish(),
  /** Epoch ms the client was archived, or absent/null if active. */
  archivedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 24 (CTRL-03): epoch ms the tenant's ownership flipped to the
   * client, or absent/null while still coach-managed. Projected straight
   * from the coach index entry's own claim-flip field (Phase 23's flip
   * already writes it) — never re-derived from `clientTenants`.
   */
  claimedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 24 (CTRL-03): epoch ms a currently LIVE claim invitation lapses,
   * or absent/null when there is no live one (never issued, expired,
   * revoked, or consumed all collapse to null/absent — no oracle on WHY).
   *
   * Badge contract the web side derives from these two fields (24-CONTEXT.md
   * Area 1, owner revision): a non-null claim-flip timestamp renders
   * Claimed; otherwise a non-null value here renders "Claim code active
   * (expires in Nh)"; otherwise Managed. The copy must NEVER assert a code
   * was sent to or received by anyone — the server only knows a code
   * exists, never that it reached the client. The rejected phrasing for
   * this badge (owner revision) must never appear in this schema's copy.
   */
  pendingInvitationExpiresAt: z.number().int().nonnegative().nullish(),
});
export type ClientHubRow = z.infer<typeof clientHubRowSchema>;

/** GET /api/coaching/clients response. */
export const clientHubListSchema = clientHubRowSchema.array();
export type ClientHubList = z.infer<typeof clientHubListSchema>;

/**
 * Phase 12 (Coach Reviews & Delivery, D-05): review status and delivery
 * status are SEPARATE state machines — this is the delivery one. Review
 * status (`Draft / Published v1..vN / Archived`) lives elsewhere (review
 * status is tracked per-version, not modeled as a shared enum here).
 */
export const REVIEW_DELIVERY_STATES = [
  'not-delivered',
  'delivered',
  'viewed',
  'acknowledged',
  'expired',
  'revoked',
] as const;
export type ReviewDeliveryState = (typeof REVIEW_DELIVERY_STATES)[number];

/**
 * Projects the full 6-state delivery machine (`REVIEW_DELIVERY_STATES`)
 * down onto `clientHubRowSchema.deliveryState`'s 3-value enum (`'none' |
 * 'delivered' | 'acknowledged'`) for the Client Hub row summary (Pitfall 5
 * / D-05): `'acknowledged'` -> `'acknowledged'`; `'delivered'`/`'viewed'`
 * -> `'delivered'`; `'not-delivered'`/`'expired'`/`'revoked'` -> `'none'`.
 * `deliveryState` is deliberately kept at 3 values (never widened) — a
 * dead/expired link and "never delivered" are indistinguishable at
 * Hub-row granularity by design; the full 6-state machine is only ever
 * surfaced on the review's own delivery-detail view, not the Hub listing.
 */
export function mapDeliveryStateToHubState(
  state: ReviewDeliveryState,
): NonNullable<ClientHubRow['deliveryState']> {
  switch (state) {
    case 'acknowledged':
      return 'acknowledged';
    case 'delivered':
    case 'viewed':
      return 'delivered';
    case 'not-delivered':
    case 'expired':
    case 'revoked':
      return 'none';
  }
}
