import { describe, expect, it } from 'vitest';
import { COHORT_TEMPLATES } from './cohort.js';
import type { InsightTemplateId } from '../types.js';

/**
 * The full closed set of ids `InsightTemplateId` declares (`types.ts`) —
 * mirrors `subject.test.ts`'s / `registry.test.ts`'s own precedent of a
 * literal list rather than a runtime-derived one (the type itself has no
 * runtime representation).
 */
const KNOWN_TEMPLATE_IDS: readonly InsightTemplateId[] = [
  'formNow',
  'characterMovers',
  'rivalMovers',
  'lastEventRecap',
  'ratingMove',
  'tiltCost',
  'sessionFatigue',
  'settingGap',
  'volumeForm',
  'mixShift',
  'rosterCore',
  'rosterShift',
  'secondaryPayoff',
  'pocketCost',
  'matchupOrPlayer',
  'bestMatchup',
  'worstMatchup',
];

describe('COHORT_TEMPLATES (plan 39.1-04 fills this segment)', () => {
  it('is non-empty', () => {
    expect(COHORT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('every member id is a known InsightTemplateId', () => {
    for (const template of COHORT_TEMPLATES) {
      expect(KNOWN_TEMPLATE_IDS).toContain(template.id);
    }
  });

  it('has no duplicate ids', () => {
    const ids = COHORT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes tiltCostTemplate (Task 1)', () => {
    expect(COHORT_TEMPLATES.map((t) => t.id)).toContain('tiltCost');
  });
});
