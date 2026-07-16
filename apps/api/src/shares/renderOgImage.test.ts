import { describe, expect, it, vi } from 'vitest';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { renderOgImage } from './renderOgImage.js';

const WEB_BASE_URL = 'https://grandfinals.gg';

/** A minimal, valid 1x1 PNG (fine as a fake sprite fetch response). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    createdAt: 1000,
    result: 'win',
    fighterId: 1, // Mario
    opponentFighterId: 3, // Link
    stage: { id: 1, name: 'Battlefield' },
    matchDate: new Date('2026-01-15').getTime(),
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 4,
    redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
    ...overrides,
  };
}

function fetchOkPng() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(
        TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
      ),
  } as unknown as Response);
}

function fetchFails() {
  return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
}

describe('renderOgImage', () => {
  it('produces a non-empty 1200x630 PNG for an active snapshot', async () => {
    const fetchImpl = fetchOkPng();
    const snapshot = makeSnapshot();

    const png = await renderOgImage({
      token: 'token-1',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(0);
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    // PNG's IHDR chunk always starts at byte 16 (8-byte signature + 4-byte
    // length + 4-byte "IHDR" type): width is the next 4 bytes, height the 4
    // after that, both big-endian — this reads the raster's actual
    // dimensions without needing a PNG-decoding dependency.
    const width = png!.readUInt32BE(16);
    const height = png!.readUInt32BE(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it('includes the owner display name only when showDisplayName is true, and escapes it', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshotWithName = makeSnapshot({
      redaction: { includedNotes: false, includedTags: false, showDisplayName: true },
      ownerDisplayName: '<script>alert(1)</script>',
    });

    await renderWithMockedSatori({
      token: 'token-with-name',
      snapshot: snapshotWithName,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(satoriMock).toHaveBeenCalledTimes(1);
    const treeArg = satoriMock.mock.calls[0]![0];
    const serialized = JSON.stringify(treeArg);
    expect(serialized).not.toContain('<script>alert(1)</script>');
    expect(serialized).toContain('&lt;script&gt;');

    satoriMock.mockClear();
    const snapshotWithoutFlag = makeSnapshot({
      redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
      ownerDisplayName: 'Should Not Appear',
    });
    await renderWithMockedSatori({
      token: 'token-without-name',
      snapshot: snapshotWithoutFlag,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const serializedWithoutFlag = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serializedWithoutFlag).not.toContain('Should Not Appear');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('still renders a card (sprites degrade) when the sprite fetch fails', async () => {
    const fetchImpl = fetchFails();
    const snapshot = makeSnapshot();

    const png = await renderOgImage({
      token: 'token-sprite-fail',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('returns null (never throws) when the render pipeline fails entirely', async () => {
    vi.resetModules();
    vi.doMock('satori', () => ({
      default: vi.fn().mockRejectedValue(new Error('satori blew up')),
    }));

    const { renderOgImage: renderWithBrokenSatori } = await import('./renderOgImage.js');
    const fetchImpl = fetchOkPng();
    const snapshot = makeSnapshot();

    const png = await renderWithBrokenSatori({
      token: 'token-broken',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).toBeNull();

    vi.doUnmock('satori');
    vi.resetModules();
  });
});
