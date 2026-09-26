import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDIT_PACKS } from '../billing.js';
import { EVENT_CATALOG } from '../events.js';
import { ACTION_SLOT_KEYS, reportJobSchema, storedScoutReportSchema } from '../reports.js';
import { MIN_VIABLE_CLAIMS } from './claims.js';

/**
 * PREP-06 (phase 39 plan 14): the anti-drift test for
 * `records/PREP-06-readout.md`. The record's PRICES table must equal the
 * shipped `CREDIT_PACKS` row for row (D-16 — a price changed in code without
 * the record, or typed into the record from memory, fails here). Its
 * `WHAT A CREDIT BUYS` section must cite D-07, D-20 and D-21 in its OWN body
 * (review C3-H1 — a mention elsewhere in the record cannot satisfy it), and
 * every constant, field and event name it states is bound to source. The
 * record must carry its boundary statement and its reference line, and must
 * contain nothing secret- or identifier-shaped (D-14: counts only).
 *
 * Every checker below returns a list of problems rather than asserting
 * inline, so each one is also proven to FAIL on a deliberately broken copy
 * of the record — an oracle without a demonstrated failing case is not one.
 */

const RECORD_PATH = fileURLToPath(new URL('./records/PREP-06-readout.md', import.meta.url));
const RECORD = readFileSync(RECORD_PATH, 'utf8');

const PRICES_HEADING = '## PRICES';
const CREDIT_BUYS_HEADING = '## WHAT A CREDIT BUYS';
const BOUNDARY_HEADING = '## BOUNDARY';
const DECISION_HEADING = '## DECISION';
const CREDIT_BUYS_DECISION_IDS = ['D-07', 'D-20', 'D-21'] as const;
const VALIDATION_EVENT_NAMES = [
  'report_failed_validation',
  'report_claims_dropped',
  'report_prose_stripped',
] as const;

/** The body under `heading`, up to (not including) the next level-2 heading; `null` when absent. */
function sectionBody(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Data rows of the first markdown table in `body`, cells trimmed and unwrapped from backticks. */
function tableRows(body: string): string[][] {
  const tableLines = body.split('\n').filter((line) => line.trim().startsWith('|'));
  return tableLines
    .slice(2) // header + separator
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim().replace(/^`(.*)`$/, '$1')),
    );
}

function priceProblems(text: string): string[] {
  const body = sectionBody(text, PRICES_HEADING);
  if (body === null) {
    return ['PRICES section is absent'];
  }
  const rows = tableRows(body);
  const problems: string[] = [];
  if (rows.length !== CREDIT_PACKS.length) {
    problems.push(`PRICES has ${rows.length} row(s), CREDIT_PACKS has ${CREDIT_PACKS.length}`);
  }
  CREDIT_PACKS.forEach((pack, index) => {
    const row = rows[index];
    const expected = [pack.id, String(pack.credits), String(pack.amountCents), pack.label];
    if (!row || row.join('|') !== expected.join('|')) {
      problems.push(
        `price row ${index} differs from the shipped constant: record=${JSON.stringify(row ?? null)} CREDIT_PACKS=${JSON.stringify(expected)}`,
      );
    }
  });
  return problems;
}

function creditBuysProblems(text: string): string[] {
  const body = sectionBody(text, CREDIT_BUYS_HEADING);
  if (body === null) {
    return ['WHAT A CREDIT BUYS section is absent'];
  }
  const problems: string[] = [];
  for (const id of CREDIT_BUYS_DECISION_IDS) {
    if (!body.includes(id)) {
      problems.push(`WHAT A CREDIT BUYS does not cite ${id} in its own body`);
    }
  }

  // The per-surface minimums, bound to the exported constant.
  const minimumRows = tableRows(body);
  const expectedMinimums = Object.entries(MIN_VIABLE_CLAIMS).map(([surface, count]) => [
    surface,
    String(count),
  ]);
  if (JSON.stringify(minimumRows) !== JSON.stringify(expectedMinimums)) {
    problems.push(
      `MIN_VIABLE_CLAIMS table differs: record=${JSON.stringify(minimumRows)} source=${JSON.stringify(expectedMinimums)}`,
    );
  }

  // Every validation event the section names exists in EVENT_CATALOG, and it names all three.
  const namedEvents = [...new Set(body.match(/report_[a-z_]+/g) ?? [])];
  for (const name of namedEvents) {
    if (!Object.hasOwn(EVENT_CATALOG, name)) {
      problems.push(`WHAT A CREDIT BUYS names an event absent from EVENT_CATALOG: ${name}`);
    }
  }
  for (const name of VALIDATION_EVENT_NAMES) {
    if (!namedEvents.includes(name)) {
      problems.push(`WHAT A CREDIT BUYS does not name the ${name} event`);
    }
  }

  // Persisted field names, bound to the stored schemas in reports.ts.
  const storedReportFields = ['strippedSectionCount', 'droppedClaimCount', 'validation'];
  for (const field of storedReportFields) {
    if (!body.includes(`\`${field}\``)) {
      problems.push(`WHAT A CREDIT BUYS does not name the stored field ${field}`);
    }
    if (!Object.hasOwn(storedScoutReportSchema.shape, field)) {
      problems.push(`stored report schema has no field ${field}`);
    }
  }
  const jobFields = ['failureReason', 'wasCharged'];
  for (const field of jobFields) {
    if (!body.includes(`\`${field}\``)) {
      problems.push(`WHAT A CREDIT BUYS does not name the job field ${field}`);
    }
    if (!Object.hasOwn(reportJobSchema.shape, field)) {
      problems.push(`reportJobSchema has no field ${field}`);
    }
  }
  for (const slot of ACTION_SLOT_KEYS) {
    if (!body.includes(`\`${slot}\``)) {
      problems.push(`WHAT A CREDIT BUYS does not name the action slot ${slot}`);
    }
  }
  return problems;
}

function boundaryAndReferenceProblems(text: string): string[] {
  const problems: string[] = [];
  const boundary = sectionBody(text, BOUNDARY_HEADING);
  if (boundary === null) {
    problems.push('BOUNDARY section is absent');
  } else {
    for (const phrase of [
      'Counts only',
      'no uid',
      'no correlation id',
      'no event payload',
      'no secret',
    ]) {
      if (!boundary.includes(phrase)) {
        problems.push(`boundary statement lacks "${phrase}"`);
      }
    }
  }
  const reference = text.split('\n').find((line) => line.startsWith('**REFERENCE:**'));
  const referenceParagraph =
    reference === undefined ? '' : text.slice(text.indexOf(reference)).split('\n\n')[0];
  if (!referenceParagraph) {
    problems.push('REFERENCE line is absent');
  } else {
    for (const phrase of [
      '>=98% reconcile',
      '<0.5% duplicates',
      'not a threshold any code enforces',
    ]) {
      if (!referenceParagraph.includes(phrase)) {
        problems.push(`REFERENCE line lacks "${phrase}"`);
      }
    }
  }
  return problems;
}

/**
 * Secret- and identifier-shaped strings a paste could smuggle in. Tuned so
 * ordinary record prose (camelCase field names, file paths, snake_case event
 * names) never matches, and proven below to catch each shape.
 */
function secretShapes(text: string): string[] {
  const found: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ['hex run', /\b[0-9a-fA-F]{32,}\b/],
    ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ['uid field', /(^|[\s{,"'`])uid["'`]?\s*[:=]/im],
    ['stripe key', /\b(sk|rk)_(live|test)_/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['bearer token', /Bearer\s+\S{16,}/],
    ['secret assignment', /INTERNAL_JOBS_SECRET\s*[=:]\s*[^\s<`]/],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) {
      found.push(name);
    }
  }
  // A long random-looking token (a uid, push key or base64 run): >=20 chars,
  // mixed case and at least three digits.
  for (const token of text.split(/[^A-Za-z0-9]+/)) {
    if (
      token.length >= 20 &&
      (token.match(/[A-Z]/g)?.length ?? 0) >= 2 &&
      (token.match(/[a-z]/g)?.length ?? 0) >= 2 &&
      (token.match(/[0-9]/g)?.length ?? 0) >= 3
    ) {
      found.push('random token');
      break;
    }
  }
  return found;
}

describe('PREP-06 record: the price table is bound to CREDIT_PACKS (D-16)', () => {
  it('the PRICES table equals CREDIT_PACKS row for row — same ids, credits, amounts, labels and row count', () => {
    expect(priceProblems(RECORD)).toEqual([]);
  });

  it('FAILS on a price typed into the record differently from the shipped constant', () => {
    const pack = CREDIT_PACKS[0];
    const broken = RECORD.replace(
      new RegExp(`(\\| \`${pack.id}\`\\s*\\|\\s*${pack.credits}\\s*\\|\\s*)${pack.amountCents}`),
      `$1${pack.amountCents + 1}`,
    );
    expect(broken).not.toBe(RECORD);
    expect(priceProblems(broken).join('\n')).toMatch(
      /price row 0 differs from the shipped constant/,
    );
  });

  it('FAILS on a missing row', () => {
    const lastPack = CREDIT_PACKS.at(-1);
    if (!lastPack) {
      throw new Error('CREDIT_PACKS is empty');
    }
    const broken = RECORD.split('\n')
      .filter((line) => !line.startsWith(`| \`${lastPack.id}\``))
      .join('\n');
    expect(priceProblems(broken).join('\n')).toMatch(/PRICES has \d+ row\(s\), CREDIT_PACKS has/);
  });
});

describe("PREP-06 record: WHAT A CREDIT BUYS answers the requirement's second clause (review C3-H1)", () => {
  it('the section exists, cites D-07/D-20/D-21 in its own body, and every value it states is bound to source', () => {
    expect(creditBuysProblems(RECORD)).toEqual([]);
  });

  it('FAILS when the section is absent', () => {
    const broken = RECORD.replace(CREDIT_BUYS_HEADING, '## WHAT CREDITS DO');
    expect(creditBuysProblems(broken)).toEqual(['WHAT A CREDIT BUYS section is absent']);
  });

  it('FAILS when a decision id appears only OUTSIDE the section (the assertion is section-scoped)', () => {
    const body = sectionBody(RECORD, CREDIT_BUYS_HEADING) ?? '';
    const withoutD21 = body.replaceAll('D-21', 'the thin-evidence rule');
    // Keep D-21 in the record — it is already cited in the substrate line above.
    const broken = RECORD.replace(body, withoutD21);
    expect(broken).toContain('D-21');
    expect(creditBuysProblems(broken)).toContain(
      'WHAT A CREDIT BUYS does not cite D-21 in its own body',
    );
  });

  it('FAILS when a minimum viable claim count drifts from MIN_VIABLE_CLAIMS', () => {
    const broken = RECORD.replace(
      /(\| `post_event_synthesis` \|\s*)(\d+)/,
      (_match, prefix: string, count: string) => `${prefix}${Number(count) + 1}`,
    );
    expect(broken).not.toBe(RECORD);
    expect(creditBuysProblems(broken).join('\n')).toMatch(/MIN_VIABLE_CLAIMS table differs/);
  });

  it('FAILS on an event name that is not in EVENT_CATALOG', () => {
    const broken = RECORD.replace('`report_prose_stripped`', '`report_prose_withheld`');
    const problems = creditBuysProblems(broken);
    expect(problems).toContain(
      'WHAT A CREDIT BUYS names an event absent from EVENT_CATALOG: report_prose_withheld',
    );
    expect(problems).toContain('WHAT A CREDIT BUYS does not name the report_prose_stripped event');
  });
});

describe('PREP-06 record: boundary statement, reference line, and the counts-only guard (D-14)', () => {
  it('carries the counts-only boundary statement and the v2.5 reference line', () => {
    expect(boundaryAndReferenceProblems(RECORD)).toEqual([]);
  });

  it('FAILS when the reference line is dropped', () => {
    const broken = RECORD.replace('**REFERENCE:**', '**Reference**');
    expect(boundaryAndReferenceProblems(broken)).toContain('REFERENCE line is absent');
  });

  it('contains no secret- or identifier-shaped string', () => {
    expect(secretShapes(RECORD)).toEqual([]);
  });

  it('the guard catches each shape it claims to (synthetic values, built at runtime)', () => {
    const randomToken = ['aB3cD4', 'eF5gH6', 'iJ7kL8', 'mN9'].join('');
    const samples: Array<[string, string]> = [
      ['hex run', 'f'.repeat(16) + '0'.repeat(16) + 'a'.repeat(8)],
      ['uuid', ['12345678', '9abc', 'def0', '1234', '56789abcdef0'].join('-')],
      ['uid field', 'uid: something'],
      ['stripe key', ['sk', 'live', 'x'].join('_')],
      ['bearer token', `Bearer ${'x'.repeat(20)}`],
      ['secret assignment', ['INTERNAL_JOBS_SECRET', 'hunter2'].join('=')],
      ['random token', `| 2026-09-20 | ${randomToken} |`],
    ];
    for (const [shape, sample] of samples) {
      expect(secretShapes(`${RECORD}\n${sample}\n`)).toContain(shape);
    }
  });

  it('the DECISION section exists', () => {
    expect(sectionBody(RECORD, DECISION_HEADING)).not.toBeNull();
  });
});
