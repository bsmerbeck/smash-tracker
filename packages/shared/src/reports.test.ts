import { describe, expect, it } from 'vitest';
import {
  claimAtomSchema,
  evidenceSnapshotRecordSchema,
  prepReportReasonSchema,
  reportFailureReasonSchema,
  reportValidationSchema,
  storedScoutReportSchema,
  generatedPracticePlanSchema,
  generatedScoutReportSchema,
  generateReportRequestSchema,
  practicePlanResponseSchema,
  PREP_BUNDLE_SIZE,
  prepBundleAcceptedResponseSchema,
  prepReportJobsResponseSchema,
  reportJobSchema,
  reportJobStatusSchema,
  scoutReportRecordSchema,
  storedPracticePlanSchema,
  synthesisJobStatusResponseSchema,
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

  it('a bundleSlotRef-shaped jobId ({bundleId}:{slot}) parses — the prep retry contract survives the illegal-char validation', () => {
    const parsed = generateReportRequestSchema.safeParse({
      reason: 'prep_report',
      entryKey: 'e1',
      opponentName: 'rival',
      jobId: 'bundle-abc:2',
    });
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

  it('prep_report: a jobId with an RTDB-illegal character fails at parse time with path [jobId] (28-review CR-01 item 4 follow-up)', () => {
    for (const jobId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'a\x01b']) {
      const result = generateReportRequestSchema.safeParse({
        reason: 'prep_report',
        entryKey: 'e1',
        opponentName: 'rival',
        jobId,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'jobId')).toBe(true);
      }
    }
  });

  it('prep_bundle: a bundleId with an RTDB-illegal character fails at parse time with path [bundleId] (28-review CR-01 item 4 follow-up)', () => {
    for (const bundleId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'a\x01b']) {
      const result = generateReportRequestSchema.safeParse({
        reason: 'prep_bundle',
        entryKey: 'e1',
        bundleId,
        opponentNames: ['a', 'b', 'c'],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'bundleId')).toBe(true);
      }
    }
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

/**
 * Phase 28 (28-02, REV-03): the `post_event_synthesis` request-union arm.
 * Grounding for a synthesis is the caller's OWN stored annotations,
 * resolved server-side from `entryKey` alone — no opponent/identity field
 * exists on this branch.
 */
describe('generateReportRequestSchema — Phase 28 post_event_synthesis arm', () => {
  it('post_event_synthesis: entryKey alone parses', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
    });
    expect(result.success).toBe(true);
  });

  it('post_event_synthesis: a client-supplied jobId is rejected (CR-01 — synthesis jobIds are always server-minted)', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
      jobId: 'client-generated-uuid',
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')),
    ).toContain('jobId');
  });

  it('post_event_synthesis: missing entryKey fails', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
    });
    expect(result.success).toBe(false);
  });

  it('post_event_synthesis: a client-supplied query is rejected (reason-present-forbids-identity)', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
      query: 'user/abc',
    });
    expect(result.success).toBe(false);
  });

  it('post_event_synthesis: opponentName is rejected (no opponent concept on this arm)', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
      opponentName: 'rival',
    });
    expect(result.success).toBe(false);
  });

  it('post_event_synthesis: bundleId is rejected', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
      bundleId: 'b1',
    });
    expect(result.success).toBe(false);
  });

  it('post_event_synthesis: opponentNames is rejected', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'e1',
      opponentNames: ['a', 'b', 'c'],
    });
    expect(result.success).toBe(false);
  });

  it('post_event_synthesis: a malformed entryKey fails (entryKeyInputSchema)', () => {
    const result = generateReportRequestSchema.safeParse({
      reason: 'post_event_synthesis',
      entryKey: 'a/b',
    });
    expect(result.success).toBe(false);
  });

  it('reportJobSchema parses with reason: post_event_synthesis', () => {
    const parsed = reportJobSchema.safeParse({
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
      attempt: 0,
      creditRef: 'j',
      reason: 'post_event_synthesis',
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

/**
 * Phase 28 (28-02, REV-03): the practice-plan generation/stored schema
 * split, mirroring `storedScoutReportSchema`'s P1-lesson tolerance pattern
 * exactly, plus the two synthesis read contracts.
 */
const FULL_PRACTICE_PLAN = {
  summary: 'Focus on ledge options and neutral spacing this block.',
  focusAreas: [
    {
      title: 'Ledge get-up mixups',
      evidence:
        'Repeatedly rolled in the same direction {{cite:matchId=m1;seconds=42;label=ledge%20roll}}.',
      drills: ['Practice all four get-up options in training mode.'],
    },
  ],
};

describe('generatedPracticePlanSchema', () => {
  it('generation schema is strict: requires summary and at least one focusArea', () => {
    expect(generatedPracticePlanSchema.safeParse(FULL_PRACTICE_PLAN).success).toBe(true);
    expect(
      generatedPracticePlanSchema.safeParse({ ...FULL_PRACTICE_PLAN, focusAreas: [] }).success,
    ).toBe(false);
  });

  it('generation schema rejects a focusArea with empty drills', () => {
    const invalid = {
      ...FULL_PRACTICE_PLAN,
      focusAreas: [{ ...FULL_PRACTICE_PLAN.focusAreas[0], drills: [] }],
    };
    expect(generatedPracticePlanSchema.safeParse(invalid).success).toBe(false);
  });

  it('generation schema rejects a focusArea missing title or evidence', () => {
    const missingTitle = {
      ...FULL_PRACTICE_PLAN,
      focusAreas: [{ evidence: 'e', drills: ['d'] }],
    };
    expect(generatedPracticePlanSchema.safeParse(missingTitle).success).toBe(false);
    const missingEvidence = {
      ...FULL_PRACTICE_PLAN,
      focusAreas: [{ title: 't', drills: ['d'] }],
    };
    expect(generatedPracticePlanSchema.safeParse(missingEvidence).success).toBe(false);
  });
});

describe('storedPracticePlanSchema', () => {
  it('INV-7: stored schema tolerates total array strip', () => {
    const parsed = storedPracticePlanSchema.parse({
      entryKey: 'e1',
      createdAt: 1,
      summary: 's',
    });
    expect(parsed.focusAreas).toEqual([]);

    const withDroppedDrills = storedPracticePlanSchema.parse({
      entryKey: 'e1',
      createdAt: 1,
      summary: 's',
      focusAreas: [{ title: 't', evidence: 'e' }],
    });
    expect(withDroppedDrills.focusAreas[0]?.drills).toEqual([]);
  });

  it('stored schema tolerates explicit nulls on every .nullish() field', () => {
    const parsed = storedPracticePlanSchema.safeParse({
      entryKey: 'e1',
      createdAt: 1,
      summary: 's',
      droppedClaimCount: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('round-trips a full generated plan through the stored shape', () => {
    const record = { entryKey: 'e1', createdAt: 1, ...FULL_PRACTICE_PLAN };
    const parsed = storedPracticePlanSchema.parse(record);
    expect(parsed.focusAreas).toHaveLength(1);
    expect(parsed.focusAreas[0]?.drills).toEqual(FULL_PRACTICE_PLAN.focusAreas[0]?.drills);
  });
});

describe('synthesisJobStatusResponseSchema', () => {
  it('accepts a null job', () => {
    expect(synthesisJobStatusResponseSchema.safeParse({ job: null }).success).toBe(true);
  });

  it('accepts a populated job', () => {
    const result = synthesisJobStatusResponseSchema.safeParse({
      job: { jobId: 'j1', status: 'succeeded', updatedAt: 1, resultRef: 'plan-push-key' },
    });
    expect(result.success).toBe(true);
  });
});

describe('practicePlanResponseSchema', () => {
  it('round-trips a stored plan', () => {
    const stored = storedPracticePlanSchema.parse({
      entryKey: 'e1',
      createdAt: 1,
      ...FULL_PRACTICE_PLAN,
    });
    const result = practicePlanResponseSchema.safeParse({ plan: stored });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-06, D-08/RPT-10): the additive stored contracts.
// ---------------------------------------------------------------------------

const PERSISTED_SAMPLE = {
  rawSampleSize: 12,
  eligibleDenominator: 12,
  knownFieldCoverage: 1,
  dateRange: { firstMs: 1_700_000_000_000, lastMs: 1_700_000_600_000 },
  refreshedAt: 1_700_000_900_000,
  evidencePolicyVersion: 1,
  recencyTreatment: 'unweighted' as const,
  confidenceTier: 'medium' as const,
};

const PERSISTED_CLAIM = {
  id: 'c01',
  predicate: 'stage_record' as const,
  subject: { myFighterId: 1, opponentFighterId: 8, stageId: 3, opponentTag: 'Rival' },
  value: { kind: 'record' as const, wins: 4, losses: 8, games: 12 },
  claimKind: 'fact' as const,
  evidenceIds: ['sr-f1-g8-s3'],
  tier: 'medium' as const,
  policyVersion: 1,
  sample: PERSISTED_SAMPLE,
};

const SNAPSHOT_RECORD = {
  policyVersion: 1,
  claimSchemaVersion: 1,
  refreshedAt: 1_700_000_900_000,
  cohort: {
    online: 0,
    offline: 12,
    unspecified: 0,
    manual: 12,
    startgg: 0,
    parrygg: 0,
    mixedContext: false,
    minorityShare: 0,
    minorityLabel: 'offline',
    majorityLabel: 'offline',
  },
  rows: {
    'sr-f1-g8-s3': {
      predicate: 'stage_record' as const,
      subject: { myFighterId: 1, opponentFighterId: 8, stageId: 3 },
      value: { kind: 'record' as const, wins: 4, losses: 8, games: 12 },
      sample: PERSISTED_SAMPLE,
    },
  },
  matchIdDigest: { count: 12, hash: 'fixture-digest' },
};

/** Returns a deep copy of `value` with the member at `path` deleted — the RTDB-vanished form of that member. */
function without(value: unknown, path: readonly string[]): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  let node = copy;
  for (const segment of path.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  delete node[path[path.length - 1]!];
  return copy;
}

describe('reportJobSchema.failureReason (Phase 39 — never the job-kind `reason`)', () => {
  const BASE_JOB = {
    status: 'refunded',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    attempt: 0,
    creditRef: 'job-abc-123',
  };

  it('round-trips with and without failureReason', () => {
    expect(reportJobSchema.parse(BASE_JOB)).not.toHaveProperty('failureReason');
    for (const failureReason of reportFailureReasonSchema.options) {
      expect(reportJobSchema.parse({ ...BASE_JOB, failureReason }).failureReason).toBe(
        failureReason,
      );
    }
  });

  it('carries the job KIND and the failure CAUSE independently on one record', () => {
    const parsed = reportJobSchema.parse({
      ...BASE_JOB,
      reason: 'prep_report',
      failureReason: 'validation',
    });
    expect(parsed.reason).toBe('prep_report');
    expect(parsed.failureReason).toBe('validation');
  });

  it("the job-kind enum is untouched: 'validation' is not a reason and a failure cause is not a kind", () => {
    expect(prepReportReasonSchema.options).toEqual([
      'prep_report',
      'prep_bundle',
      'post_event_synthesis',
    ]);
    expect(reportJobSchema.safeParse({ ...BASE_JOB, reason: 'validation' }).success).toBe(false);
    expect(reportJobSchema.safeParse({ ...BASE_JOB, failureReason: 'prep_report' }).success).toBe(
      false,
    );
  });
});

describe('storedScoutReportSchema — Phase 39 additive fields (RPT-10: absence means legacy)', () => {
  const CLAIMS_ERA = {
    ...RTDB_STRIPPED_REPORT,
    claimSchemaVersion: 1,
    validation: {
      status: 'passed',
      policyVersion: 1,
      snapshotId: 'a'.repeat(64),
      claimSchemaVersion: 1,
    },
    claims: { c01: PERSISTED_CLAIM },
    sections: {
      overview: { claimIds: ['c01'], connective: 'Stay patient.' },
      gameplan: { connective: '' },
    },
    actions: { action1: { actionId: 'a01', claimId: 'c01' }, action3: { actionId: 'a02' } },
    droppedClaimCount: 1,
    strippedSectionCount: 1,
  };

  it('a stored report with NONE of the new fields still parses (the legacy tolerant read)', () => {
    const parsed = storedScoutReportSchema.parse(RTDB_STRIPPED_REPORT);
    for (const field of [
      'claimSchemaVersion',
      'validation',
      'claims',
      'sections',
      'actions',
      'droppedClaimCount',
      'strippedSectionCount',
    ]) {
      expect(parsed).not.toHaveProperty(field);
    }
  });

  it('a claims-era record parses, with an absent section claimIds list read back as []', () => {
    const parsed = storedScoutReportSchema.parse(CLAIMS_ERA);
    expect(parsed.sections?.gameplan).toEqual({ claimIds: [], connective: '' });
    expect(parsed.actions).toEqual({
      action1: { actionId: 'a01', claimId: 'c01' },
      action3: { actionId: 'a02' },
    });
  });

  it('omitting each new keyed map in turn still parses (C1-H5)', () => {
    for (const field of ['claims', 'sections', 'actions', 'validation', 'claimSchemaVersion']) {
      expect(storedScoutReportSchema.safeParse(without(CLAIMS_ERA, [field])).success).toBe(true);
    }
  });

  it('strippedSectionCount parses present, absent, and as the no-key result of a zero-count conditional spread (C3-M1)', () => {
    const zero = 0;
    const written = {
      ...RTDB_STRIPPED_REPORT,
      ...(zero > 0 ? { strippedSectionCount: zero } : {}),
    };
    expect(written).not.toHaveProperty('strippedSectionCount');
    expect(storedScoutReportSchema.safeParse(written).success).toBe(true);
    expect(storedScoutReportSchema.parse(CLAIMS_ERA).strippedSectionCount).toBe(1);
    expect(
      storedScoutReportSchema.safeParse({ ...RTDB_STRIPPED_REPORT, strippedSectionCount: -1 })
        .success,
    ).toBe(false);
  });

  it('storedPracticePlanSchema carries the same strippedSectionCount and claim maps', () => {
    const plan = {
      entryKey: 'evo-2026-ult',
      createdAt: 1,
      summary: 'Plan.',
      strippedSectionCount: 2,
      claims: { c01: PERSISTED_CLAIM },
    };
    expect(storedPracticePlanSchema.parse(plan).strippedSectionCount).toBe(2);
    expect(
      storedPracticePlanSchema.safeParse(without(plan, ['strippedSectionCount'])).success,
    ).toBe(true);
  });

  it('the validation block requires status passed', () => {
    expect(
      reportValidationSchema.safeParse({
        status: 'failed',
        policyVersion: 1,
        snapshotId: 'x',
        claimSchemaVersion: 1,
      }).success,
    ).toBe(false);
  });
});

describe('claimAtomSchema / evidenceSnapshotRecordSchema — .nullish() at EVERY level that can vanish (C2-H1)', () => {
  it('parses the full shape', () => {
    expect(claimAtomSchema.safeParse(PERSISTED_CLAIM).success).toBe(true);
    expect(evidenceSnapshotRecordSchema.safeParse(SNAPSHOT_RECORD).success).toBe(true);
  });

  it('omitting subject, each subject axis, tier, sample.dateRange and sample.confidenceTier in turn still parses (claim)', () => {
    const paths = [
      ['subject'],
      ['subject', 'myFighterId'],
      ['subject', 'opponentFighterId'],
      ['subject', 'stageId'],
      ['subject', 'opponentTag'],
      ['tier'],
      ['sample', 'dateRange'],
      ['sample', 'confidenceTier'],
    ];
    for (const path of paths) {
      expect(claimAtomSchema.safeParse(without(PERSISTED_CLAIM, path)).success).toBe(true);
    }
  });

  it('an all-null subject read back ABSENT (not null-valued) parses on both a claim and a snapshot row', () => {
    const axisFreeClaim = without(
      { ...PERSISTED_CLAIM, predicate: 'recent_form', evidenceIds: ['rf-all'] },
      ['subject'],
    );
    expect(claimAtomSchema.safeParse(axisFreeClaim).success).toBe(true);
    const axisFreeSnapshot = without(SNAPSHOT_RECORD, ['rows', 'sr-f1-g8-s3', 'subject']);
    expect(evidenceSnapshotRecordSchema.safeParse(axisFreeSnapshot).success).toBe(true);
  });

  it('omitting rows, each row subject axis, the cohort labels, dateRange and confidenceTier in turn still parses (snapshot)', () => {
    const paths = [
      ['rows'],
      ['rows', 'sr-f1-g8-s3', 'subject', 'myFighterId'],
      ['rows', 'sr-f1-g8-s3', 'subject', 'opponentFighterId'],
      ['rows', 'sr-f1-g8-s3', 'subject', 'stageId'],
      ['rows', 'sr-f1-g8-s3', 'sample', 'dateRange'],
      ['rows', 'sr-f1-g8-s3', 'sample', 'confidenceTier'],
      ['cohort', 'minorityLabel'],
      ['cohort', 'majorityLabel'],
    ];
    for (const path of paths) {
      expect(evidenceSnapshotRecordSchema.safeParse(without(SNAPSHOT_RECORD, path)).success).toBe(
        true,
      );
    }
  });

  it('an absent evidenceIds list (RTDB-dropped empty array) reads back as []', () => {
    expect(claimAtomSchema.parse(without(PERSISTED_CLAIM, ['evidenceIds'])).evidenceIds).toEqual(
      [],
    );
  });

  it('FALSIFIER: a member that can NOT vanish is still required (value, sample, predicate)', () => {
    for (const path of [['value'], ['sample'], ['predicate'], ['sample', 'eligibleDenominator']]) {
      expect(claimAtomSchema.safeParse(without(PERSISTED_CLAIM, path)).success).toBe(false);
    }
  });
});
