import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import de from '@/i18n/locales/de.json';
import pt from '@/i18n/locales/pt.json';
import ja from '@/i18n/locales/ja.json';
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

/**
 * The two non-refund badges ship in all six locales on BOTH paid cards, each
 * a complete sentence/word of its own, and neither carries refund vocabulary
 * in its language (the words the v2.5 refund badges use).
 */
describe('non-refund failure badges — six locales (post-plan fix 39-10)', () => {
  const LOCALES = { en, es, fr, de, pt, ja } as const;
  const REFUND_WORD: Record<keyof typeof LOCALES, RegExp> = {
    en: /refund/i,
    es: /reembols/i,
    fr: /rembours/i,
    de: /erstatt/i,
    pt: /reembols/i,
    ja: /返金|返却/,
  };

  it.each(Object.keys(LOCALES) as Array<keyof typeof LOCALES>)(
    '%s: failedNoCharge / failedChargeUnknown are present, non-empty, distinct, and refund-free on both cards',
    (code) => {
      const bundle = LOCALES[code] as unknown as Record<
        string,
        { jobStatus: Record<string, string> }
      >;
      for (const ns of ['prepPaid', 'postEventPaid']) {
        const status = bundle[ns]!.jobStatus;
        const noCharge = status.failedNoCharge;
        const unknown = status.failedChargeUnknown;
        expect(typeof noCharge === 'string' && noCharge.length > 0).toBe(true);
        expect(typeof unknown === 'string' && unknown.length > 0).toBe(true);
        expect(noCharge).not.toBe(unknown);
        expect(noCharge).not.toMatch(REFUND_WORD[code]);
        expect(unknown).not.toMatch(REFUND_WORD[code]);
        // The refund badges this replaces DO carry the word — the regex is live.
        expect(status.refunded).toMatch(REFUND_WORD[code]);
        expect(noCharge).not.toContain('{{');
      }
    },
  );
});
