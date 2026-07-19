import { describe, expect, it } from 'vitest';
import { mapDeliveryStateToHubState } from './coachingTenant.js';

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
