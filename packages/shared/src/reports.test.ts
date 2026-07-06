import { describe, expect, it } from 'vitest';
import { generatedScoutReportSchema, scoutReportRecordSchema } from './reports.js';

/**
 * V7-B.1: `characterStrategy` is a REQUIRED field on freshly-generated
 * reports (`generatedScoutReportSchema`), but reports stored before this
 * change lack it entirely. `scoutReportRecordSchema` must still parse those
 * pre-existing rows — GET /api/reports validates every stored record against
 * it, so a strict schema here would 500 on old data.
 */

const FULL_REPORT = {
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
  headToHead: null,
  watchFor: ['Likes to shine spike off stage.'],
  confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
};

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
});
