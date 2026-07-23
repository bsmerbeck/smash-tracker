import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StageList } from '@smash-tracker/shared';

/** Synthetic "generic" stage sentinels — intentionally have no art (ASSET-01 scope). */
const SENTINEL_IDS = new Set([1000, 1001]);

/**
 * Minimal JPEG dimension reader (no new dependency): scans for a
 * Start-Of-Frame marker (0xFF followed by one of the SOF marker bytes),
 * then reads big-endian height/width immediately after the marker's
 * length + precision bytes.
 */
function readJpegDimensions(buf: Buffer): { width: number; height: number } {
  const SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2; // skip SOI marker (0xFFD8)
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker !== undefined && SOF_MARKERS.has(marker)) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Skip this segment: 2 bytes marker + segment length (big-endian, includes itself).
    const segmentLength = buf.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  throw new Error('No SOF marker found — not a valid JPEG');
}

function realStages() {
  return StageList.filter((s) => !SENTINEL_IDS.has(s.id));
}

describe('stage art coverage', () => {
  it('gives every real stage a non-empty url pointing at an existing committed file', () => {
    const failures: string[] = [];
    for (const stage of realStages()) {
      if (!stage.url || !stage.url.startsWith('/assets/stages/')) {
        failures.push(`id ${stage.id} (${stage.name}): url is "${stage.url}"`);
        continue;
      }
      const filePath = resolve('public', stage.url.replace(/^\//, ''));
      if (!existsSync(filePath)) {
        failures.push(`id ${stage.id} (${stage.name}): missing file at ${filePath}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('covers exactly 117 distinct real stage ids (excluding synthetic sentinels)', () => {
    const distinctIds = new Set(realStages().map((s) => s.id));
    expect(distinctIds.size).toBe(117);
    for (const id of distinctIds) {
      const stage = realStages().find((s) => s.id === id);
      expect(stage?.url).toBeTruthy();
    }
  });

  it('dimension spot-checks: base-game download, DLC sips-resized, and shared-source distinct-id are all 750x421', () => {
    const spotCheckIds = [4, 110, 107];
    for (const id of spotCheckIds) {
      const stage = realStages().find((s) => s.id === id);
      expect(stage, `stage id ${id} should exist`).toBeTruthy();
      const filePath = resolve('public', stage!.url.replace(/^\//, ''));
      const buf = readFileSync(filePath);
      const { width, height } = readJpegDimensions(buf);
      expect({ id, width, height }).toEqual({ id, width: 750, height: 421 });
    }
  });
});
