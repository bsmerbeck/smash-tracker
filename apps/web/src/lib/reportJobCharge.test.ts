import { describe, expect, it } from 'vitest';
import { failedJobBadgeCopy, resolveReportJobCharge } from './reportJobCharge';

/**
 * Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25): refund wording on
 * the paid cards must be TRUE for the viewer. The job's own `wasCharged` (the
 * spend fact persisted at spend time) decides whenever it is present; only a
 * job without it (an older record) falls back to 39-10's viewer rule — a
 * loaded credits read that says `freeAccess === false`. Neither known ⇒
 * unknown, and unknown never produces refund wording.
 */
describe('resolveReportJobCharge', () => {
  it.each([
    // The record decides whenever it carries the fact — including when the
    // viewer's CURRENT free-access status says the opposite (status changed
    // after the job ran).
    { wasCharged: true, freeAccess: false, expected: 'charged' },
    { wasCharged: true, freeAccess: true, expected: 'charged' },
    { wasCharged: true, freeAccess: undefined, expected: 'charged' },
    { wasCharged: false, freeAccess: false, expected: 'notCharged' },
    { wasCharged: false, freeAccess: true, expected: 'notCharged' },
    { wasCharged: false, freeAccess: undefined, expected: 'notCharged' },
    // Older records: 39-10's rule (every spend site sets spent = !freeAccess).
    { wasCharged: undefined, freeAccess: false, expected: 'charged' },
    { wasCharged: undefined, freeAccess: true, expected: 'notCharged' },
    { wasCharged: undefined, freeAccess: undefined, expected: 'unknown' },
  ] as const)(
    'wasCharged $wasCharged, freeAccess $freeAccess → $expected',
    ({ wasCharged, freeAccess, expected }) => {
      expect(resolveReportJobCharge({ wasCharged, freeAccess })).toBe(expected);
    },
  );
});

describe('failedJobBadgeCopy', () => {
  it.each([
    { status: 'failed', charge: 'charged', expected: 'pendingRefund' },
    { status: 'refunded', charge: 'charged', expected: 'refunded' },
    { status: 'failed', charge: 'notCharged', expected: 'noCharge' },
    { status: 'refunded', charge: 'notCharged', expected: 'noCharge' },
    { status: 'failed', charge: 'unknown', expected: 'chargeUnknown' },
    { status: 'refunded', charge: 'unknown', expected: 'chargeUnknown' },
  ] as const)('$status + $charge → $expected', ({ status, charge, expected }) => {
    expect(failedJobBadgeCopy(status, charge)).toBe(expected);
  });

  it('refund wording ("pendingRefund" / "refunded") is reachable ONLY from a charged job', () => {
    for (const status of ['failed', 'refunded'] as const) {
      for (const charge of ['notCharged', 'unknown'] as const) {
        expect(['pendingRefund', 'refunded']).not.toContain(failedJobBadgeCopy(status, charge));
      }
    }
  });
});
