import { describe, expect, it } from 'vitest';
import {
  CLIENT_TENANT_ROLES,
  clientHubRowSchema,
  clientKindResponseSchema,
  clientMembershipSchema,
  clientTenantRecordSchema,
  coachClientEntrySchema,
  mapDeliveryStateToHubState,
} from './coachingTenant.js';

/** Minimal valid base for `clientHubRowSchema.parse`/`safeParse` calls below — every field the schema requires except `kind`, which each test supplies explicitly (the field is required, not defaulted). */
function baseHubRow() {
  return { clientId: 't1', label: 'A', draftCount: 0 };
}

describe('mapDeliveryStateToHubState (D-05 6-state -> 3-value Hub projection)', () => {
  it('maps acknowledged to acknowledged', () => {
    expect(mapDeliveryStateToHubState('acknowledged')).toBe('acknowledged');
  });

  it('maps delivered and viewed to delivered', () => {
    expect(mapDeliveryStateToHubState('delivered')).toBe('delivered');
    expect(mapDeliveryStateToHubState('viewed')).toBe('delivered');
  });

  it('maps not-delivered, expired, and revoked to none', () => {
    expect(mapDeliveryStateToHubState('not-delivered')).toBe('none');
    expect(mapDeliveryStateToHubState('expired')).toBe('none');
    expect(mapDeliveryStateToHubState('revoked')).toBe('none');
  });
});

describe('Phase 23: widened membership role space and claimed-status fields', () => {
  it('accepts role custodian (existing production data stays valid)', () => {
    expect(clientMembershipSchema.safeParse({ role: 'custodian', joinedAt: 1 }).success).toBe(true);
  });

  it('accepts role owner', () => {
    expect(clientMembershipSchema.safeParse({ role: 'owner', joinedAt: 1 }).success).toBe(true);
  });

  it('accepts role delegate', () => {
    expect(clientMembershipSchema.safeParse({ role: 'delegate', joinedAt: 1 }).success).toBe(true);
  });

  it('rejects an unknown role', () => {
    expect(clientMembershipSchema.safeParse({ role: 'admin', joinedAt: 1 }).success).toBe(false);
  });

  it('CLIENT_TENANT_ROLES equals [custodian, owner, delegate]', () => {
    expect(CLIENT_TENANT_ROLES).toEqual(['custodian', 'owner', 'delegate']);
  });

  it('clientTenantRecordSchema parses with ownerUid/claimedAt absent, and with both null', () => {
    expect(clientTenantRecordSchema.safeParse({ createdAt: 1 }).success).toBe(true);
    expect(
      clientTenantRecordSchema.safeParse({ createdAt: 1, ownerUid: null, claimedAt: null }).success,
    ).toBe(true);
  });

  it('coachClientEntrySchema parses with claimedAt absent, and with claimedAt null', () => {
    expect(coachClientEntrySchema.safeParse({ label: 'x', createdAt: 1 }).success).toBe(true);
    expect(
      coachClientEntrySchema.safeParse({ label: 'x', createdAt: 1, claimedAt: null }).success,
    ).toBe(true);
  });
});

describe('Phase 24 (CTRL-03): clientHubRowSchema claim-status widening', () => {
  it('parses with both new fields absent (legal, pre-existing rows) — kind still required', () => {
    expect(clientHubRowSchema.parse({ ...baseHubRow(), kind: 'ordinary' })).toMatchObject({
      clientId: 't1',
      label: 'A',
      draftCount: 0,
      kind: 'ordinary',
    });
  });

  it('parses with claimedAt set and pendingInvitationExpiresAt null', () => {
    expect(
      clientHubRowSchema.parse({
        ...baseHubRow(),
        claimedAt: 5,
        pendingInvitationExpiresAt: null,
        kind: 'ordinary',
      }),
    ).toMatchObject({ claimedAt: 5, pendingInvitationExpiresAt: null });
  });

  it('parses with pendingInvitationExpiresAt set and claimedAt null', () => {
    expect(
      clientHubRowSchema.parse({
        ...baseHubRow(),
        claimedAt: null,
        pendingInvitationExpiresAt: 999,
        kind: 'ordinary',
      }),
    ).toMatchObject({ claimedAt: null, pendingInvitationExpiresAt: 999 });
  });

  it('rejects a negative claimedAt', () => {
    expect(
      clientHubRowSchema.safeParse({ ...baseHubRow(), claimedAt: -1, kind: 'ordinary' }).success,
    ).toBe(false);
  });

  it('rejects a negative pendingInvitationExpiresAt', () => {
    expect(
      clientHubRowSchema.safeParse({
        ...baseHubRow(),
        pendingInvitationExpiresAt: -1,
        kind: 'ordinary',
      }).success,
    ).toBe(false);
  });
});

describe('Phase 29 (Research Tenancy, Isolation & Governance Gate, D-01): clientTenantRecordSchema.kind', () => {
  it('parses with kind absent (no migration, legacy coaching state)', () => {
    expect(clientTenantRecordSchema.safeParse({ createdAt: 1 }).success).toBe(true);
  });

  it('parses with kind explicitly null (RTDB null-stripping tolerance)', () => {
    expect(clientTenantRecordSchema.safeParse({ createdAt: 1, kind: null }).success).toBe(true);
  });

  it('parses with kind set to the research member and round-trips it', () => {
    const parsed = clientTenantRecordSchema.parse({ createdAt: 1, kind: 'research' });
    expect(parsed.kind).toBe('research');
  });

  it('parses with kind set to the coaching member', () => {
    expect(clientTenantRecordSchema.safeParse({ createdAt: 1, kind: 'coaching' }).success).toBe(
      true,
    );
  });

  it('rejects an unrecognized kind value', () => {
    expect(clientTenantRecordSchema.safeParse({ createdAt: 1, kind: 'bogus' }).success).toBe(false);
  });
});

describe('Phase 29 (review finding 29-01 HIGH, cycle-2 C2-HIGH-2): clientHubRowSchema.kind tri-state', () => {
  it('rejects a row that OMITS kind (required, not nullish)', () => {
    expect(clientHubRowSchema.safeParse(baseHubRow()).success).toBe(false);
  });

  it('accepts the ordinary resolution', () => {
    expect(clientHubRowSchema.safeParse({ ...baseHubRow(), kind: 'ordinary' }).success).toBe(true);
  });

  it('accepts the research resolution', () => {
    expect(clientHubRowSchema.safeParse({ ...baseHubRow(), kind: 'research' }).success).toBe(true);
  });

  it('accepts the unresolved resolution', () => {
    expect(clientHubRowSchema.safeParse({ ...baseHubRow(), kind: 'unresolved' }).success).toBe(
      true,
    );
  });

  it('rejects a fourth, arbitrary string', () => {
    expect(clientHubRowSchema.safeParse({ ...baseHubRow(), kind: 'bogus' }).success).toBe(false);
  });
});

describe('Phase 29 (D-07, review consensus finding 6): clientKindResponseSchema', () => {
  it('accepts the ordinary resolution', () => {
    expect(clientKindResponseSchema.safeParse({ kind: 'ordinary' }).success).toBe(true);
  });

  it('accepts the research resolution', () => {
    expect(clientKindResponseSchema.safeParse({ kind: 'research' }).success).toBe(true);
  });

  it('rejects a missing kind', () => {
    expect(clientKindResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an arbitrary string', () => {
    expect(clientKindResponseSchema.safeParse({ kind: 'bogus' }).success).toBe(false);
  });
});
