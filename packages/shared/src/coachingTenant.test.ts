import { describe, expect, it } from 'vitest';
import {
  CLIENT_TENANT_ROLES,
  clientHubRowSchema,
  clientMembershipSchema,
  clientTenantRecordSchema,
  coachClientEntrySchema,
  mapDeliveryStateToHubState,
} from './coachingTenant.js';

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
  it('parses with both new fields absent (legal, pre-existing rows)', () => {
    expect(clientHubRowSchema.parse({ clientId: 't1', label: 'A', draftCount: 0 })).toMatchObject({
      clientId: 't1',
      label: 'A',
      draftCount: 0,
    });
  });

  it('parses with claimedAt set and pendingInvitationExpiresAt null', () => {
    expect(
      clientHubRowSchema.parse({
        clientId: 't1',
        label: 'A',
        draftCount: 0,
        claimedAt: 5,
        pendingInvitationExpiresAt: null,
      }),
    ).toMatchObject({ claimedAt: 5, pendingInvitationExpiresAt: null });
  });

  it('parses with pendingInvitationExpiresAt set and claimedAt null', () => {
    expect(
      clientHubRowSchema.parse({
        clientId: 't1',
        label: 'A',
        draftCount: 0,
        claimedAt: null,
        pendingInvitationExpiresAt: 999,
      }),
    ).toMatchObject({ claimedAt: null, pendingInvitationExpiresAt: 999 });
  });

  it('rejects a negative claimedAt', () => {
    expect(
      clientHubRowSchema.safeParse({ clientId: 't1', label: 'A', draftCount: 0, claimedAt: -1 })
        .success,
    ).toBe(false);
  });

  it('rejects a negative pendingInvitationExpiresAt', () => {
    expect(
      clientHubRowSchema.safeParse({
        clientId: 't1',
        label: 'A',
        draftCount: 0,
        pendingInvitationExpiresAt: -1,
      }).success,
    ).toBe(false);
  });
});
