import { describe, expect, it } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseExportedMatches,
  countFighterOpponentPairs,
  measureEngineComputeP95Ms,
  measureGzipPayloadBytes,
  buildRealDataReadout,
  formatRealDataReadoutLines,
  isSparg0ExportEnvelopeShape,
  loadSparg0ExportEnvelope,
} from './sparg0RealDataReadoutCore.js';

/**
 * Entirely SYNTHETIC fixtures — never content read from a real export file.
 * Fighter/opponent ids and match shapes below are invented for this test.
 */
function syntheticMatch(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    fighter_id: 8,
    opponent_id: 22,
    time: 1_700_000_000_000,
    win: true,
    matchType: 'online-friendly',
    map: { id: 3, name: 'Battlefield' },
    ...overrides,
  };
}

describe('parseExportedMatches', () => {
  it('parses valid raw records and assigns a synthetic per-index id', () => {
    const raw = [syntheticMatch(), syntheticMatch({ opponent_id: 30, win: false })];
    const { matches, skippedCorruptCount } = parseExportedMatches(raw);
    expect(matches).toHaveLength(2);
    expect(skippedCorruptCount).toBe(0);
    expect(matches[0]!.id).toBe('real-0');
    expect(matches[1]!.id).toBe('real-1');
  });

  it('skips a corrupt record without throwing and counts the skip', () => {
    const raw = [syntheticMatch(), { fighter_id: 'not-a-number' }, syntheticMatch()];
    const { matches, skippedCorruptCount } = parseExportedMatches(raw);
    expect(matches).toHaveLength(2);
    expect(skippedCorruptCount).toBe(1);
  });
});

describe('countFighterOpponentPairs', () => {
  it('counts distinct (fighter_id, opponent_id) pairs against the abstention floor', () => {
    const raw = [
      ...Array.from({ length: 3 }, () => syntheticMatch({ fighter_id: 8, opponent_id: 22 })), // clears floor (3)
      ...Array.from({ length: 2 }, () => syntheticMatch({ fighter_id: 8, opponent_id: 30 })), // below floor
      syntheticMatch({ fighter_id: 22, opponent_id: 8 }), // below floor, distinct pair
    ];
    const { matches } = parseExportedMatches(raw);
    const result = countFighterOpponentPairs(matches);
    expect(result.totalFighterOpponentPairs).toBe(3);
    expect(result.pairsClearingFloor).toBe(1);
    expect(result.pairsAbstained).toBe(2);
  });
});

describe('measureEngineComputeP95Ms / measureGzipPayloadBytes', () => {
  it('complete over a small synthetic set without throwing and return positive numbers', () => {
    const raw = Array.from({ length: 20 }, (_, i) =>
      syntheticMatch({ opponent_id: 20 + (i % 5), win: i % 2 === 0 }),
    );
    const { matches } = parseExportedMatches(raw);

    const p95 = measureEngineComputeP95Ms(matches);
    expect(p95).toBeGreaterThanOrEqual(0);

    const gzipBytes = measureGzipPayloadBytes(matches);
    expect(gzipBytes).toBeGreaterThan(0);
  });
});

describe('buildRealDataReadout', () => {
  it('assembles an aggregate-only readout from a synthetic envelope', () => {
    const matches = Array.from({ length: 10 }, (_, i) =>
      syntheticMatch({ opponent_id: 20 + (i % 3), win: i % 2 === 0 }),
    );
    const envelope = {
      matchCount: matches.length,
      matches,
      matchesSha256: 'deadbeef'.repeat(8),
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
    };

    const readout = buildRealDataReadout(envelope);

    expect(readout.matchCountRaw).toBe(10);
    expect(readout.matchCountParsed).toBe(10);
    expect(readout.skippedCorruptCount).toBe(0);
    expect(readout.matchesSha256).toBe(envelope.matchesSha256);
    expect(readout.databaseHost).toBe(envelope.databaseHost);
    expect(readout.engineComputeBudgetId).toBe('engine-recompute-p95-8k');
    expect(readout.engineComputeTargetMs).toBe(100);
    expect(['PASS', 'MISS']).toContain(readout.engineComputeVerdict);
    expect(readout.gzipPayloadBudgetId).toBe('matches-gzip-payload-8k');
    expect(readout.gzipPayloadTargetBytes).toBe(1_500_000);
    expect(['PASS', 'MISS']).toContain(readout.gzipPayloadVerdict);
    expect(readout.totalFighterOpponentPairs).toBeGreaterThan(0);
    expect(readout.pairsClearingFloor + readout.pairsAbstained).toBe(
      readout.totalFighterOpponentPairs,
    );

    // The readout is a plain object of primitives — no `matches` field, no uid field.
    expect(Object.keys(readout)).not.toContain('matches');
    expect(Object.keys(readout)).not.toContain('uid');
  });
});

describe('loadSparg0ExportEnvelope — unit-tested against a synthetic file', () => {
  it('reads and shape-validates a synthetic export file written to a temp path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sparg0-readout-test-'));
    const filePath = path.join(dir, 'synthetic-export.json');
    try {
      const matches = Array.from({ length: 4 }, () => syntheticMatch());
      const envelope = {
        uid: 'synthetic-uid-never-a-real-account', // present in the FILE (mirrors the real envelope shape); never read back out of the loaded object below
        matchCount: matches.length,
        matches,
        matchesSha256: 'feedface'.repeat(8),
        databaseHost: 'synthetic.firebaseio.com',
      };
      await writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');

      const loaded = await loadSparg0ExportEnvelope(filePath);
      expect(loaded.matchCount).toBe(4);
      expect(loaded.matches).toHaveLength(4);
      expect(loaded.matchesSha256).toBe(envelope.matchesSha256);
      expect(loaded.databaseHost).toBe(envelope.databaseHost);

      const readout = buildRealDataReadout(loaded);
      expect(readout.matchCountParsed).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file that does not match the envelope shape', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sparg0-readout-test-'));
    const filePath = path.join(dir, 'not-an-envelope.json');
    try {
      await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf8');
      await expect(loadSparg0ExportEnvelope(filePath)).rejects.toThrow(
        /does not match the sparg0 export envelope shape/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('isSparg0ExportEnvelopeShape rejects non-envelope values', () => {
    expect(isSparg0ExportEnvelopeShape(null)).toBe(false);
    expect(isSparg0ExportEnvelopeShape({})).toBe(false);
    expect(isSparg0ExportEnvelopeShape({ matchCount: 1, matches: [] })).toBe(false);
  });
});

describe('formatRealDataReadoutLines', () => {
  it('produces one SCL-01-REAL line per field, never a nested object', () => {
    const matches = Array.from({ length: 5 }, () => syntheticMatch());
    const readout = buildRealDataReadout({
      matchCount: matches.length,
      matches,
      matchesSha256: 'abc123'.repeat(10),
      databaseHost: 'example.firebaseio.com',
    });
    const lines = formatRealDataReadoutLines(readout);
    expect(lines.length).toBe(Object.keys(readout).length);
    for (const line of lines) {
      expect(line).toMatch(/^SCL-01-REAL [a-zA-Z0-9]+=/);
      expect(line).not.toMatch(/\[object Object\]/);
    }
  });
});
