import { describe, expect, it } from 'vitest';
import { ROSTER_TEMPLATES } from './roster.js';
import type { InsightTemplateId } from '../types.js';

/**
 * The full closed set of ids `InsightTemplateId` declares (`types.ts`) —
 * used to assert every `ROSTER_TEMPLATES` member's `id` is a real,
 * registered member of that union, not a stray string. Mirrors
 * `subject.test.ts`'s own precedent (plan 39.1-03).
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

describe('ROSTER_TEMPLATES (plan 39.1-05 fills this segment)', () => {
  it('is non-empty', () => {
    expect(ROSTER_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('every member id is a known InsightTemplateId', () => {
    for (const template of ROSTER_TEMPLATES) {
      expect(KNOWN_TEMPLATE_IDS).toContain(template.id);
    }
  });

  it('has no duplicate ids', () => {
    const ids = ROSTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes rosterCoreTemplate (Task 1)', () => {
    expect(ROSTER_TEMPLATES.map((t) => t.id)).toContain('rosterCore');
  });

  // Deliberately no exact-length assertion here (Round 2 review disposition
  // C2-L4, mirroring `subject.test.ts`'s own precedent): Task 2 in this SAME
  // plan grows this segment to 4. The absolute final count is asserted once,
  // in `pocketCost.test.ts` — the task that completes the segment.
});
