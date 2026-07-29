import { describe, expect, it } from 'vitest';
import {
  generatedScoutReportSchema,
  generateReportRequestSchema,
  PREP_BUNDLE_SIZE,
  prepBundleAcceptedResponseSchema,
  prepReportJobsResponseSchema,
  reportJobSchema,
  reportJobStatusSchema,
  scoutReportRecordSchema,
} from './reports.js';

/**
 * V7-B.1: `characterStrategy` is a REQUIRED field on freshly-generated
 * reports (`generatedScoutReportSchema`), but reports stored before this
 * change lack it entirely. `scoutReportRecordSchema` must still parse those
 * pre-existing rows — GET /api/reports validates every stored record against
 * it, so a strict schema here would 500 on old data.
 */

/**
 * The RTDB-stripped stored shape (V9-B): everything a full report carries
 * EXCEPT `headToHead` — RTDB deletes null-valued keys on write, so a record
 * persisted with `headToHead: null` reads back with the field absent.
 * `FULL_REPORT` (the generation shape, where the field is required) composes
 * this base with the explicit null.
 */
const RTDB_STRIPPED_REPORT = {
  overview: 'A fast-falling Fox/Falco player who plays aggressively.',
  gameplan: ['Punish landing lag hard.'],
  characterStrategy: {
    picks: ['Mario'],
    reasoning: 'Game 1: Mario; if they swap to Falco, counter with Pikachu.',
  },
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'They perform best on flat stages.',
  },
  watchFor: ['Likes to shine spike off stage.'],
  confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
};

const FULL_REPORT = { ...RTDB_STRIPPED_REPORT, headToHead: null };

const PRE_B1_REPORT = {
  overview: 'A fast-falling Fox/Falco player who plays aggressively.',
  gameplan: ['Punish landing lag hard.'],
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'They perform best on flat stages.',
  },
  headToHead: null,
  watchFor: ['Likes to shine spike off stage.'],
  confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
};

describe('generatedScoutReportSchema', () => {
  it('requires characterStrategy on a freshly-generated report', () => {
    expect(generatedScoutReportSchema.safeParse(FULL_REPORT).success).toBe(true);
    expect(generatedScoutReportSchema.safeParse(PRE_B1_REPORT).success).toBe(false);
  });
});

describe('scoutReportRecordSchema back-compat', () => {
  it('parses a full V7-B.1 record with characterStrategy', () => {
    const record = {
      id: 'report-1',
      createdAt: 1_700_000_000_000,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: FULL_REPORT,
    };
    const parsed = scoutReportRecordSchema.parse(record);
    expect(parsed.report.characterStrategy).toEqual(FULL_REPORT.characterStrategy);
  });

  it('parses a pre-B.1 stored record that lacks characterStrategy entirely', () => {
    const record = {
      id: 'report-0',
      createdAt: 1_600_000_000_000,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: PRE_B1_REPORT,
    };
    const parsed = scoutReportRecordSchema.parse(record);
    expect(parsed.report.characterStrategy).toBeUndefined();
    // Round-trip: re-serializing and re-parsing (as GET /api/reports does)
    // must not throw and must preserve the absence of characterStrategy.
    const roundTripped = scoutReportRecordSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it('V9-B: parses a stored record whose headToHead was RTDB-stripped (key ABSENT, not null)', () => {
    // RTDB deletes null-valued keys on write, so a record persisted with
    // `headToHead: null` comes back with the field missing entirely.
    // Confirmed against production data — a merely-`.nullable()` stored
    // schema rejects this shape and corrupts the whole record on read.
    const record = {
      id: 'report-2',
      createdAt: 1_700_000_000_000,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
      report: RTDB_STRIPPED_REPORT,
    };
    const parsed = scoutReportRecordSchema.parse(record);
    expect(parsed.report.headToHead).toBeUndefined();
  });

  it('V13: parses a stored record with a combined-source player (both ids present)', () => {
    const record = {
      id: 'report-4',
      createdAt: 1_700_000_000_000,
      model: 'claude-opus-4-8',
      player: {
        source: 'combined',
        id: 1802316,
        userSlug: 'user/07dc2239',
        parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
        gamerTag: 'Pandem1c',
      },
      report: FULL_REPORT,
    };
    const parsed = scoutReportRecordSchema.parse(record);
    expect(parsed.player.source).toBe('combined');
    expect(parsed.player.id).toBe(1802316);
    expect(parsed.player.parryUserId).toBe('019ce9ba-debd-7e11-84a2-77258f52644e');
  });

  it('V9-B: still parses an explicit headToHead: null (records seeded/written before the null-strip fix, read via a null-preserving path)', () => {
    const record = {
      id: 'report-3',
      createdAt: 1_700_000_000_000,
      model: 'claude-opus-4-8',
      player: { id: 1802316, gamerTag: 'Pandem1c' },
      report: FULL_REPORT, // headToHead: null
    };
    expect(scoutReportRecordSchema.safeParse(record).success).toBe(true);
  });

  it('V9-B: the GENERATION schema still requires headToHead to be emitted (nullable, never absent)', () => {
    expect(generatedScoutReportSchema.safeParse(RTDB_STRIPPED_REPORT).success).toBe(false);
    expect(generatedScoutReportSchema.safeParse(FULL_REPORT).success).toBe(true);
  });
});

/**
 * Phase 10 BILL-06: the durable report-job state machine schema + the
 * optional jobId field on the generation request.
 */
describe('reportJobStatusSchema', () => {
  it('enumerates exactly the five report-job states', () => {
    expect(reportJobStatusSchema.options).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'refunded',
    ]);
  });
});

describe('reportJobSchema', () => {
  it('accepts a freshly-queued job', () => {
    const parsed = reportJobSchema.safeParse({
      status: 'queued',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      attempt: 0,
      creditRef: 'job-abc-123',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a succeeded job with a resultRef', () => {
    const parsed = reportJobSchema.safeParse({
      status: 'succeeded',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      attempt: 0,
      creditRef: 'job-abc-123',
      resultRef: 'report-push-key',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const parsed = reportJobSchema.safeParse({
      status: 'in_progress',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      attempt: 0,
      creditRef: 'job-abc-123',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('generateReportRequestSchema jobId (deploy-first optional)', () => {
  it('accepts a request with a jobId', () => {
    const parsed = generateReportRequestSchema.safeParse({
      query: 'user/07dc2239',
      jobId: 'client-generated-uuid',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a request without a jobId (un-updated client never 400s)', () => {
    const parsed = generateReportRequestSchema.safeParse({ query: 'user/07dc2239' });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Phase 27 (RPT-01..04): the backward-compatible request union — legacy
 * report generation stays byte-identical, prep single/bundle requests are
 * validated at the schema layer before any handler code runs.
 */
describe('generateReportRequestSchema — Phase 27 prep-context union', () => {
  it('legacy: {query} parses successfully unchanged', () => {
    expect(generateReportRequestSchema.safeParse({ query: 'user/abc' }).success).toBe(true);
  });

  it('legacy: {} fails — query is required when reason is absent', () => {
    expect(generateReportRequestSchema.safeParse({}).success).toBe(false);
  });

  it('prep_report: entryKey + opponentName parses', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_report',
      entryKey: 'e1',
      opponentName: 'rival',
    });
    expect(result.success).toBe(true);
  });

  it('prep_report: a client-supplied query is rejected (no smuggled provider identity)', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_report',
      entryKey: 'e1',
      opponentName: 'rival',
      query: 'user/abc',
    });
    expect(result.success).toBe(false);
  });

  it('prep_bundle: rejects a 2-opponent selection', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_bundle',
      entryKey: 'e1',
      bundleId: 'b1',
      opponentNames: ['a', 'b'],
    });
    expect(result.success).toBe(false);
  });

  it('prep_bundle: rejects a 4-opponent selection', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_bundle',
      entryKey: 'e1',
      bundleId: 'b1',
      opponentNames: ['a', 'b', 'c', 'd'],
    });
    expect(result.success).toBe(false);
  });

  it('prep_bundle: rejects a duplicate-opponent selection', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_bundle',
      entryKey: 'e1',
      bundleId: 'b1',
      opponentNames: ['a', 'a', 'b'],
    });
    expect(result.success).toBe(false);
  });

  it('prep_bundle: exactly 3 distinct opponents parses', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'prep_bundle',
      entryKey: 'e1',
      bundleId: 'b1',
      opponentNames: ['a', 'b', 'c'],
    });
    expect(result.success).toBe(true);
  });

  it('reportJobSchema still parses with reason absent', () => {
    const parsed = reportJobSchema.safeParse({
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
      attempt: 0,
      creditRef: 'j',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('PREP_BUNDLE_SIZE', () => {
  it('is exactly 3', () => {
    expect(PREP_BUNDLE_SIZE).toBe(3);
  });
});

describe('prepReportJobsResponseSchema', () => {
  it('parses an empty jobs array', () => {
    expect(prepReportJobsResponseSchema.safeParse({ jobs: [] }).success).toBe(true);
  });

  it('parses a mix of in-flight and succeeded job entries', () => {
    const result = prepReportJobsResponseSchema.safeParse({
      jobs: [
        { opponentName: 'rival', jobId: 'b1:1', status: 'queued', updatedAt: 1 },
        {
          opponentName: 'other',
          jobId: 'b1:2',
          status: 'succeeded',
          updatedAt: 2,
          resultRef: 'push-key',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('prepBundleAcceptedResponseSchema', () => {
  it('parses a 3-slot bundle-accepted body', () => {
    const result = prepBundleAcceptedResponseSchema.safeParse({
      bundleId: 'b1',
      jobs: [
        { opponentName: 'a', jobId: 'b1:1', slot: 1 },
        { opponentName: 'b', jobId: 'b1:2', slot: 2 },
        { opponentName: 'c', jobId: 'b1:3', slot: 3 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a slot outside 1..PREP_BUNDLE_SIZE', () => {
    const result = prepBundleAcceptedResponseSchema.safeParse({
      bundleId: 'b1',
      jobs: [{ opponentName: 'a', jobId: 'b1:1', slot: 4 }],
    });
    expect(result.success).toBe(false);
  });
});
