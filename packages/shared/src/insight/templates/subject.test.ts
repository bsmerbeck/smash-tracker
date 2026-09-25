import { describe, expect, it } from 'vitest';
import { SUBJECT_TEMPLATES } from './subject.js';
import type { InsightTemplateId } from '../types.js';

/**
 * The full closed set of ids `InsightTemplateId` declares (`types.ts`) — used
 * to assert every `SUBJECT_TEMPLATES` member's `id` is a real, registered
 * member of that union, not a stray string. Kept as a literal list (not
 * re-derived from the type itself, which has no runtime representation)
 * mirroring `registry.test.ts`'s own precedent.
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

describe('SUBJECT_TEMPLATES (plan 39.1-03 fills this segment)', () => {
  it('is non-empty', () => {
    expect(SUBJECT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('every member id is a known InsightTemplateId', () => {
    for (const template of SUBJECT_TEMPLATES) {
      expect(KNOWN_TEMPLATE_IDS).toContain(template.id);
    }
  });

  it('has no duplicate ids', () => {
    const ids = SUBJECT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes characterMoversTemplate (Task 1)', () => {
    expect(SUBJECT_TEMPLATES.map((t) => t.id)).toContain('characterMovers');
  });
});
