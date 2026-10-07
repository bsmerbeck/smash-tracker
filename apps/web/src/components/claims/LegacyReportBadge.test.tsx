import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/i18n/locales/en.json';
import { LegacyReportBadge } from './LegacyReportBadge';
import { isValidatedRecord, type ProvenanceFields } from './provenance';

const PASSED = { status: 'passed', policyVersion: 1, snapshotId: 'snap-1', claimSchemaVersion: 1 };

/**
 * Plan 39-10 (RPT-10, UI-SPEC E2 partial): every field combination the stored
 * record can arrive in, enumerated explicitly. The badge is ABSENT for exactly
 * one of them — a positive-integer version AND a passed validation block.
 */
const COMBINATIONS: Array<{ name: string; fields: ProvenanceFields; validated: boolean }> = [
  { name: 'no version (neither field — a pre-Phase-39 record)', fields: {}, validated: false },
  {
    name: 'version only (no validation block)',
    fields: { claimSchemaVersion: 1 },
    validated: false,
  },
  { name: 'validation only (no version)', fields: { validation: PASSED }, validated: false },
  {
    name: 'unknown validation status',
    fields: { claimSchemaVersion: 1, validation: { ...PASSED, status: 'pending' } },
    validated: false,
  },
  {
    name: 'null version (RTDB null)',
    fields: { claimSchemaVersion: null, validation: PASSED },
    validated: false,
  },
  {
    name: 'null validation (RTDB null)',
    fields: { claimSchemaVersion: 1, validation: null },
    validated: false,
  },
  {
    name: 'both present and valid',
    fields: { claimSchemaVersion: 1, validation: PASSED },
    validated: true,
  },
  // Beyond the seven: the other half-written shapes the fail-closed rule covers.
  {
    name: 'string version',
    fields: { claimSchemaVersion: '1', validation: PASSED },
    validated: false,
  },
  {
    name: 'validation block with no status',
    fields: { claimSchemaVersion: 1, validation: { policyVersion: 1 } },
    validated: false,
  },
  {
    name: 'fractional version',
    fields: { claimSchemaVersion: 1.5, validation: PASSED },
    validated: false,
  },
];

describe('isValidatedRecord (fail closed)', () => {
  it.each(COMBINATIONS)('$name -> validated: $validated', ({ fields, validated }) => {
    expect(isValidatedRecord(fields)).toBe(validated);
  });

  it('is true for exactly one of the enumerated combinations', () => {
    expect(COMBINATIONS.filter(({ fields }) => isValidatedRecord(fields))).toHaveLength(1);
  });
});

describe('LegacyReportBadge', () => {
  it.each(COMBINATIONS)(
    'row variant, $name -> badge hidden only when validated ($validated)',
    ({ fields, validated }) => {
      render(<LegacyReportBadge variant="row" {...fields} />);
      if (validated) {
        expect(screen.queryByText(en.reports.legacy.badge)).not.toBeInTheDocument();
        expect(document.body.textContent).toBe('');
      } else {
        expect(screen.getByText(en.reports.legacy.badge)).toBeInTheDocument();
      }
    },
  );

  it('row variant renders the badge alone — no explanatory sentence', () => {
    render(<LegacyReportBadge variant="row" />);
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.queryByText(en.reports.legacy.explain)).not.toBeInTheDocument();
  });

  it('card variant renders the badge AND the explanatory sentence for a legacy record, neither for a validated one', () => {
    const { unmount } = render(<LegacyReportBadge variant="card" />);
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.getByText(en.reports.legacy.explain)).toBeInTheDocument();
    unmount();

    render(<LegacyReportBadge variant="card" claimSchemaVersion={1} validation={PASSED} />);
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText(en.reports.legacy.explain)).not.toBeInTheDocument();
  });

  it('the tooltip carries the shipped copy, which states what is UNKNOWN about the record, not that it is wrong', async () => {
    const user = userEvent.setup();
    render(<LegacyReportBadge variant="row" />);
    await user.hover(screen.getByText('Legacy'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(en.reports.legacy.tooltip);
    expect(en.reports.legacy.tooltip).toBe(
      "Generated before this app's report validator existed — its content wasn't machine-checked against your match data.",
    );
    expect(en.reports.legacy.tooltip).not.toMatch(
      /wrong|incorrect|inaccurate|broken|error|invalid/i,
    );
  });

  it('the badge is keyboard-focusable, so the tooltip is reachable without a pointer', () => {
    render(<LegacyReportBadge variant="row" />);
    expect(screen.getByText('Legacy')).toHaveAttribute('tabindex', '0');
  });

  it('uses the informative outline treatment — never destructive, never an icon', () => {
    render(<LegacyReportBadge variant="card" />);
    const badge = screen.getByText('Legacy');
    expect(badge).toHaveAttribute('data-variant', 'outline');
    expect(badge.querySelector('svg')).toBeNull();
  });

  it('source read: no warning treatment and no timestamp-based decision', () => {
    const source = readFileSync(resolve('src/components/claims/LegacyReportBadge.tsx'), 'utf-8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(source).not.toMatch(/destructive|AlertTriangle|AlertCircle|createdAt/);
  });
});
