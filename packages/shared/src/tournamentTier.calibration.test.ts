import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIER_ESTIMATE_LADDER, resolveTournamentTier } from './tournamentTier.js';
import {
  TIER_CALIBRATION_CONTROL_ROWS,
  TIER_CALIBRATION_FIXTURE,
  findOverRatedEvents,
  findUnderRatedEvents,
  skippedCalibrationRows,
} from './tournamentTier.calibration.js';
import { deriveEventKind } from './tournamentTier.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every ladder threshold halved — a deliberately wrong ladder the oracle must catch. */
const HALVED_LADDER = TIER_ESTIMATE_LADDER.map((rung) => ({
  ...rung,
  minEntrants: Math.floor(rung.minEntrants / 2),
}));

function controlRow(id: string) {
  const row = TIER_CALIBRATION_CONTROL_ROWS.find((r) => r.id === id);
  if (!row) {
    throw new Error(`calibration control row not found: ${id}`);
  }
  return row;
}

/** Owner-probe rows cite a dated start.gg probe and event slug instead of a committed file. */
function isOwnerProbeRow(row: { evidence: string }): boolean {
  return row.evidence.startsWith('owner start.gg probe ');
}

describe('D-01 calibration oracle — acceptance: the ladder never over-rates an externally-tiered event', () => {
  it('(a) the real ladder over-rates no ACTIVE fixture row', () => {
    expect(findOverRatedEvents(TIER_CALIBRATION_FIXTURE)).toEqual([]);
  });

  it('(b) anti-vacuous: at least 2 file-backed ACTIVE rows, each entrant count read back from its committed evidence bytes', () => {
    const active = TIER_CALIBRATION_FIXTURE.filter((row) => row.status === 'active');
    const fileBacked = active.filter((row) => !isOwnerProbeRow(row));
    expect(fileBacked.length).toBeGreaterThanOrEqual(2);
    for (const row of fileBacked) {
      expect(row.numEntrants).not.toBeNull();
      const bytes = readFileSync(join(REPO_ROOT, row.evidence), 'utf8');
      const count = row.numEntrants as number;
      const plain = String(count);
      const withComma = count.toLocaleString('en-US');
      expect(bytes).toMatch(new RegExp(`player_number=(${plain}|${withComma})\\b`));
    }
  });

  it('(b2) every ACTIVE owner-probe row has a positive integer count and cites the probe date and an event slug', () => {
    const probed = TIER_CALIBRATION_FIXTURE.filter(isOwnerProbeRow);
    expect(probed.map((row) => row.id).sort()).toEqual(
      ['getonmylevel-2026', 'momocon-2026', 'sfactor-x3'].sort(),
    );
    for (const row of probed) {
      expect(row.status).toBe('active');
      expect(Number.isInteger(row.numEntrants)).toBe(true);
      expect(row.numEntrants as number).toBeGreaterThan(0);
      expect(row.setting).toBe('offline');
      expect(row.evidence).toMatch(
        /probe 2026-09-30: tournament\/[a-z0-9-]+\/event\/[a-z0-9-]+ numEntrants /,
      );
      expect(row.evidence).toContain(`numEntrants ${row.numEntrants} `);
    }
  });

  it('never gives an awaiting row an invented count, and every row label is a main event', () => {
    for (const row of TIER_CALIBRATION_FIXTURE) {
      if (row.status === 'awaiting-owner-probe') {
        expect(row.numEntrants).toBeNull();
      }
      expect(deriveEventKind(row.eventLabel)).toBe('main');
    }
    for (const row of TIER_CALIBRATION_CONTROL_ROWS) {
      expect(row.recordedSource).toBe('synthetic-control');
      expect(deriveEventKind(row.eventLabel)).toBe('main');
    }
  });
});

describe('D-01 calibration oracle — proven failing direction', () => {
  it('(c) a halved ladder over-rates a control row while the real ladder does not', () => {
    expect(findOverRatedEvents(TIER_CALIBRATION_CONTROL_ROWS, TIER_ESTIMATE_LADDER)).toEqual([]);
    const overRated = findOverRatedEvents(TIER_CALIBRATION_CONTROL_ROWS, HALVED_LADDER);
    expect(overRated.length).toBeGreaterThan(0);
    expect(overRated.map((row) => row.id)).toContain('control-minor-300-offline');
  });

  it('(d) the online control row resolves unknown under BOTH ladders and is never rated', () => {
    const row = controlRow('control-regional-8000-online');
    for (const ladder of [TIER_ESTIMATE_LADDER, HALVED_LADDER]) {
      const resolution = resolveTournamentTier({
        entry: { eventName: row.eventLabel, numEntrants: row.numEntrants, isOnline: true },
        ladder,
      });
      expect(resolution).toMatchObject({ tier: 'unknown', reason: 'online' });
      expect(findOverRatedEvents([row], ladder)).toEqual([]);
      expect(findUnderRatedEvents([row], ladder)).toEqual([]);
    }
  });

  it('(e) recorded supermajor at 600 offline is UNDER-rated, never over-rated (the designed S Factor direction)', () => {
    const row = controlRow('control-supermajor-600-offline');
    expect(findUnderRatedEvents([row]).map((r) => r.id)).toEqual([row.id]);
    expect(findOverRatedEvents([row])).toEqual([]);
  });
});

describe('D-01 calibration oracle — skipped rows', () => {
  it('(f) no fixture row is awaiting the owner probe any more — the oracle skips nothing', () => {
    expect(skippedCalibrationRows(TIER_CALIBRATION_FIXTURE)).toEqual([]);
  });

  it('(g) the owner-probed rows resolve per the real ladder: S Factor X3 exact, GOML and MomoCon under-rated one rung, none over-rated', () => {
    const byId = (id: string) => TIER_CALIBRATION_FIXTURE.filter((row) => row.id === id);
    // S Factor X3 (1325 >= 1024) reaches its recorded supermajor: neither over- nor under-rated.
    expect(findOverRatedEvents(byId('sfactor-x3'))).toEqual([]);
    expect(findUnderRatedEvents(byId('sfactor-x3'))).toEqual([]);
    // GOML (512 -> major vs recorded supermajor) and MomoCon (453 -> minor vs recorded major).
    expect(
      findUnderRatedEvents(TIER_CALIBRATION_FIXTURE)
        .map((row) => row.id)
        .sort(),
    ).toEqual(['getonmylevel-2026', 'momocon-2026']);
    expect(findOverRatedEvents(TIER_CALIBRATION_FIXTURE)).toEqual([]);
  });

  it('reports the active row ids it evaluated', () => {
    const active = TIER_CALIBRATION_FIXTURE.filter((row) => row.status === 'active').map(
      (row) => row.id,
    );
    expect(active.sort()).toEqual(
      [
        'getonmylevel-2026',
        'momocon-2026',
        'sfactor-x3',
        'ssc-2019-ultimate',
        'supernova-2026-ultimate',
      ].sort(),
    );
  });
});
