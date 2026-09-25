import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import en from '@/i18n/locales/en.json';
import { WithheldProseNote } from './WithheldProseNote';

const VALIDATED = {
  claimSchemaVersion: 1,
  validation: { status: 'passed', policyVersion: 1, snapshotId: 'snap-1', claimSchemaVersion: 1 },
};

/**
 * Plan 39-10 (decision D-20): the withheld-prose disclosure. Renders only for
 * a finite integer `strippedSectionCount` of at least one on a VALIDATED
 * record. Every other count renders no text node at all, and no rendered
 * string may contain `NaN`.
 */
const NOTHING: Array<{ label: string; count: unknown }> = [
  { label: 'absent', count: undefined },
  { label: 'null', count: null },
  { label: '0', count: 0 },
  { label: '-1', count: -1 },
  { label: '1.5', count: 1.5 },
  { label: 'non-numeric string', count: 'three' },
  { label: 'numeric string', count: '2' },
  { label: 'NaN', count: Number.NaN },
];

describe('WithheldProseNote', () => {
  it.each(NOTHING)('$label -> renders nothing (no text node, no NaN)', ({ count }) => {
    const { container } = render(<WithheldProseNote strippedSectionCount={count} {...VALIDATED} />);
    expect(container.textContent).toBe('');
    expect(container.childNodes).toHaveLength(0);
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('1 -> the singular sentence, matched exactly against the shipped copy', () => {
    const { container } = render(<WithheldProseNote strippedSectionCount={1} {...VALIDATED} />);
    expect(container.textContent).toBe(en.reports.withheldProse_one);
    expect(container.textContent).toBe(
      "Commentary for 1 section was withheld because it couldn't be verified against your match data.",
    );
  });

  it('2 -> the plural sentence with the stored count, matched exactly', () => {
    const { container } = render(<WithheldProseNote strippedSectionCount={2} {...VALIDATED} />);
    expect(container.textContent).toBe(en.reports.withheldProse_other.replace('{{count}}', '2'));
    expect(container.textContent).toBe(
      "Commentary for 2 sections was withheld because it couldn't be verified against your match data.",
    );
  });

  it.each([
    { label: 'no claimSchemaVersion (pre-Phase-39 record)', fields: {} },
    { label: 'version but no validation block (half-written)', fields: { claimSchemaVersion: 1 } },
    {
      label: 'null version',
      fields: { claimSchemaVersion: null, validation: VALIDATED.validation },
    },
  ])('a LEGACY record renders nothing even with a positive count: $label', ({ fields }) => {
    const { container } = render(<WithheldProseNote strippedSectionCount={3} {...fields} />);
    expect(container.textContent).toBe('');
    expect(container.childNodes).toHaveLength(0);
  });

  it('register: informative — no apology, no alarm, no money vocabulary (both plural forms)', () => {
    for (const sentence of [en.reports.withheldProse_one, en.reports.withheldProse_other]) {
      expect(sentence).not.toMatch(/sorry|apolog|unfortunately|warning|error|wrong|broken|!/i);
      expect(sentence).not.toMatch(
        /credit|refund|charge|paid|price|pricing|checkout|unlock|upgrade/i,
      );
    }
  });

  it('source read: the legacy exclusion reuses the shared fail-closed isValidatedRecord', () => {
    const source = readFileSync(resolve('src/components/claims/WithheldProseNote.tsx'), 'utf-8');
    expect(source).toMatch(/import \{ isValidatedRecord[^}]*\} from '\.\/provenance'/);
  });
});
