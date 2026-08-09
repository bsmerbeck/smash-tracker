import { RESEARCH_ELIGIBILITY_RULES } from '../src/research/ingestion/classification.js';

/**
 * Phase 30 Plan 08, Task 3 (ING-01, review C-M10) — `pnpm exec tsx
 * apps/api/scripts/renderEligibilityTable.ts`.
 *
 * Prints a markdown table of `RESEARCH_ELIGIBILITY_RULES`, in evaluation
 * order, with the columns rule id / classification / signal / description.
 * Takes no arguments, reads no environment variable, and touches no network
 * or database — a pure I/O shell over a constant already exported by
 * `classification.ts`.
 *
 * This is what makes `30-COVERAGE-AUDIT.md` section 2's "generated from the
 * shipped constant" claim true rather than aspirational: the audit pastes
 * this script's output VERBATIM, and Task 5's closure gate diffs the
 * committed section against a fresh run of this script — a rule added
 * later without regenerating the audit fails the phase rather than
 * silently diverging.
 */

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function main(): void {
  const lines: string[] = [];
  lines.push('| Rule ID | Classification | Signal | Description |');
  lines.push('|---|---|---|---|');
  for (const rule of RESEARCH_ELIGIBILITY_RULES) {
    lines.push(
      `| ${escapeTableCell(rule.id)} | ${escapeTableCell(rule.classification)} | ${escapeTableCell(rule.signal)} | ${escapeTableCell(rule.description)} |`,
    );
  }
  console.log(lines.join('\n'));
}

main();
