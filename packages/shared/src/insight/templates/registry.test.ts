import { describe, expect, it } from 'vitest';
import { INSIGHT_TEMPLATES } from './registry.js';
import { CORE_TEMPLATES } from './core.js';
import { SUBJECT_TEMPLATES } from './subject.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ROSTER_TEMPLATES } from './roster.js';

describe('INSIGHT_TEMPLATES composition (C1-H2 registry contract)', () => {
  it('equals the union of the four segment arrays, in order', () => {
    expect(INSIGHT_TEMPLATES).toEqual([
      ...CORE_TEMPLATES,
      ...SUBJECT_TEMPLATES,
      ...COHORT_TEMPLATES,
      ...ROSTER_TEMPLATES,
    ]);
  });

  it('length equals the sum of the four segment lengths', () => {
    expect(INSIGHT_TEMPLATES.length).toBe(
      CORE_TEMPLATES.length +
        SUBJECT_TEMPLATES.length +
        COHORT_TEMPLATES.length +
        ROSTER_TEMPLATES.length,
    );
  });

  it('every registered template declares windowExpressible as a boolean', () => {
    for (const template of INSIGHT_TEMPLATES) {
      expect(typeof template.windowExpressible).toBe('boolean');
    }
  });

  it('formNowTemplate declares windowExpressible: true', () => {
    const formNow = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow');
    expect(formNow).toBeDefined();
    expect(formNow?.windowExpressible).toBe(true);
  });
});
