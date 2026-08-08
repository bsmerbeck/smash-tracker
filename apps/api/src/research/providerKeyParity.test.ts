import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isPathSafeProviderId } from '@smash-tracker/shared';
import { isPathSafeTenantId } from './subjectKind.js';

/**
 * Plan 30-01 Task 3 (review finding C-H1): this file exists because the
 * class of defect it guards against could NOT be caught by unit tests
 * inside either package alone — the shared `isPathSafeProviderId` predicate
 * had no hyphen-bearing true-case in an earlier draft, and the API
 * predicate it claims to mirror (`isPathSafeTenantId`,
 * `apps/api/src/research/subjectKind.ts`) lives in a different package. A
 * cross-package parity assertion is the only place the two definitions
 * meet.
 *
 * `KEY_PROBES` is declared with a recorded baseline length (`MIN_PROBE_COUNT`)
 * so a future edit cannot silently weaken this check by deleting cases.
 */
const MIN_PROBE_COUNT = 12;

interface KeyProbe {
  label: string;
  value: string;
}

const KEY_PROBES: KeyProbe[] = [
  { label: 'a real randomUUID() value generated inside this test', value: randomUUID() },
  {
    label: 'a fixed hyphen-bearing UUID literal',
    value: 'a3f1c9d2-1111-4a2b-9c3d-000000000001',
  },
  { label: 'a numeric provider id', value: '123456789' },
  { label: 'a 200-character safe string', value: 'a'.repeat(200) },
  { label: 'a 201-character string', value: 'a'.repeat(201) },
  { label: 'the empty string', value: '' },
  { label: 'a string containing a space', value: 'foo bar' },
  { label: 'the illegal character .', value: 'foo.bar' },
  { label: 'the illegal character #', value: 'foo#bar' },
  { label: 'the illegal character $', value: 'foo$bar' },
  { label: 'the illegal character [', value: 'foo[bar' },
  { label: 'the illegal character ]', value: 'foo]bar' },
  { label: 'the illegal character /', value: 'foo/bar' },
  {
    label: 'a U+0001 control character',
    value: `foo${String.fromCharCode(0x01)}bar`,
  },
  {
    label: 'a U+007F (DEL) character',
    value: `foo${String.fromCharCode(0x7f)}bar`,
  },
];

describe('the shared provider-key predicate matches the shipped RTDB key predicates', () => {
  it('does not weaken the probe table below its recorded baseline length (anti-vacuous-pass guard)', () => {
    expect(KEY_PROBES.length).toBeGreaterThanOrEqual(MIN_PROBE_COUNT);
  });

  it.each(KEY_PROBES)('agrees with isPathSafeTenantId for $label', ({ label, value }) => {
    expect(
      isPathSafeProviderId(value),
      `isPathSafeProviderId and isPathSafeTenantId disagree on: ${label}`,
    ).toBe(isPathSafeTenantId(value));
  });

  // The case whose failure would have silently no-opped the entire phase
  // (review C-H1): every research tenant id is a UUID
  // (`apps/api/src/coaching/tenants.ts`'s `randomUUID()`), and every
  // ingestion module guards its tenant id with a predicate of this class —
  // a hyphen-rejecting predicate would make every upsert return a
  // rejected-key outcome and the pipeline would process nothing while every
  // module's own tests still passed.
  it('accepts 100 freshly generated randomUUID() values', () => {
    for (let i = 0; i < 100; i++) {
      const value = randomUUID();
      expect(isPathSafeProviderId(value)).toBe(true);
      expect(isPathSafeTenantId(value)).toBe(true);
    }
  });
});
