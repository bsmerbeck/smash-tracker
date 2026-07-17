import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { renderOgImage, resetOgImageCachesForTests } from './renderOgImage.js';

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

function makeRecapSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    createdAt: 1000,
    kind: 'recap',
    recapSource: 'startgg',
    tournamentName: 'Genesis X',
    tournamentDate: new Date('2026-01-15').getTime(),
    placement: 3,
    seed: 8,
    numEntrants: 128,
    setRecordWins: 5,
    setRecordLosses: 2,
    notableWinOpponentName: 'Some Player',
    notableWinOpponentSeed: 1,
    characterFighterIds: [1, 3],
    reviewedMomentsCount: 4,
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
  beforeEach(() => {
    // The module-level sprite cache (1h TTL) would otherwise carry the
    // sprites fetched by the first test into the sprite-fetch-FAILURE test
    // below, rendering a normal card instead of the degrade branch
    // (iteration-2 review WR-04). Only the statically-imported module
    // instance needs this — the vi.resetModules() tests get fresh caches.
    resetOgImageCachesForTests();
    // The sprite-degrade and pipeline-failure tests deliberately trigger the
    // log-and-degrade console.error — silence it so test output stays clean
    // (behavior is asserted via the rendered output, not the log).
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    // Both sprite fetches must actually have been attempted (and rejected) —
    // cached sprite data-URIs would short-circuit fetchSpriteDataUri and
    // render a normal card, never reaching the sprite-less degrade branch.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('produces a non-empty 1200x630 PNG for a recap snapshot', async () => {
    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot();

    const png = await renderOgImage({
      token: 'recap-token-1',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(0);
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    const width = png!.readUInt32BE(16);
    const height = png!.readUInt32BE(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it('renders a recap card with reviewedMomentsCount 0 and omits the reviewed-moments node', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({ reviewedMomentsCount: 0 });

    await renderWithMockedSatori({
      token: 'recap-token-zero-moments',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(satoriMock).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).not.toContain('reviewed moment');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('escapes an HTML-special tournament name and owner display name on a recap card', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({
      tournamentName: '<script>alert(1)</script>',
      ownerDisplayName: '<script>alert(2)</script>',
    });

    await renderWithMockedSatori({
      token: 'recap-token-escape',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).not.toContain('<script>alert(1)</script>');
    expect(serialized).not.toContain('<script>alert(2)</script>');
    expect(serialized).toContain('&lt;script&gt;');

    vi.doUnmock('satori');
    vi.resetModules();
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
