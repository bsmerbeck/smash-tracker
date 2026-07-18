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

function makeSet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    roundLabel: 'Winners Round 3',
    opponentName: 'RivalTag',
    wins: 3,
    losses: 1,
    win: true,
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

  it('includes the owner display name RAW (satori has no HTML context) only when showDisplayName is true', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshotWithName = makeSnapshot({
      redaction: { includedNotes: false, includedTags: false, showDisplayName: true },
      // HTML-special characters are common in gamer tags — they must render
      // verbatim on the card, never as entity forms (review WR-06): satori
      // rasterizes text to vector paths, so there is no injection sink and
      // escaping would print "&amp;"/"&lt;" literally onto the PNG.
      ownerDisplayName: "Fire & Ice <o'Brien>",
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
    expect(serialized).toContain("Shared by Fire & Ice <o'Brien>");
    expect(serialized).not.toContain('&amp;');
    expect(serialized).not.toContain('&lt;');

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

  it('formats the notable-win seed as "(seed N)" when the opponent name is known (07-10 polish fix)', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({
      notableWinOpponentName: 'jarbo v1',
      notableWinOpponentSeed: 4876,
    });

    await renderWithMockedSatori({
      token: 'recap-token-notable-win-named',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    // Previously this rendered "Notable win vs jarbo v1 4876" (a bare
    // trailing number with no label) — now parenthesized and labeled.
    expect(serialized).toContain('Notable win vs jarbo v1 (seed 4876)');
    expect(serialized).not.toContain('jarbo v1 4876');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('formats the notable-win line as "vs seed N" when no opponent name is known', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({
      notableWinOpponentName: undefined,
      notableWinOpponentSeed: 12,
    });

    await renderWithMockedSatori({
      token: 'recap-token-notable-win-seed-only',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).toContain('Notable win vs seed 12');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('passes HTML-special tournament/opponent/owner names to satori RAW — never entity-escaped (review WR-06)', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    // `&` is extremely common in tournament names, `<`/`'` in gamer tags —
    // satori renders text as vector paths (no HTML parsing), so escaping
    // would corrupt the flagship shareable card with literal "&amp;" text.
    const snapshot = makeRecapSnapshot({
      tournamentName: 'Fire & Ice X',
      notableWinOpponentName: '<CG> Marss',
      ownerDisplayName: "o'Brien & co",
    });

    await renderWithMockedSatori({
      token: 'recap-token-raw-text',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).toContain('Fire & Ice X');
    expect(serialized).toContain('Notable win vs <CG> Marss (seed 1)');
    expect(serialized).toContain("Shared by o'Brien & co");
    expect(serialized).not.toContain('&amp;');
    expect(serialized).not.toContain('&lt;');
    expect(serialized).not.toContain('&#');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('renders a non-empty 1200x630 PNG for a "full" recap with more than 5 sets (set-rows column + "+N more sets")', async () => {
    const fetchImpl = fetchOkPng();
    const sets = Array.from({ length: 7 }, (_, i) =>
      makeSet({ roundLabel: `Set ${i + 1}`, opponentName: `Rival${i + 1}` }),
    );
    const snapshot = makeRecapSnapshot({ detail: 'full', sets });

    const png = await renderOgImage({
      token: 'recap-token-full-many-sets',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(png!.readUInt32BE(16)).toBe(1200);
    expect(png!.readUInt32BE(20)).toBe(630);
  });

  it('shows only the LAST 5 sets plus a "+N more sets" row, truncating long round/opponent labels', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const sets = [
      makeSet({ roundLabel: 'Pools Set 1', opponentName: 'EarlyOpponent' }),
      makeSet({ roundLabel: 'Pools Set 2', opponentName: 'EarlyOpponent2' }),
      makeSet({
        roundLabel: 'Winners Semi-Final Extra Long',
        opponentName: 'AVeryLongOpponentTagName',
        win: false,
        wins: 1,
        losses: 3,
      }),
      makeSet({ roundLabel: 'Winners Finals', opponentName: 'Finalist' }),
      makeSet({ roundLabel: 'Grand Finals Reset', opponentName: 'ChampOne' }),
      makeSet({ roundLabel: 'Grand Finals', opponentName: 'ChampTwo' }),
    ];
    const snapshot = makeRecapSnapshot({ detail: 'full', sets });

    await renderWithMockedSatori({
      token: 'recap-token-truncate',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    // Only the last 5 sets render; the 1 earliest set is summarized.
    expect(serialized).toContain('+1 more sets');
    expect(serialized).not.toContain('Pools Set 1');
    // roundLabel truncated to ~18 chars with an ellipsis.
    expect(serialized).toContain('Winners Semi-Fina…');
    expect(serialized).not.toContain('Winners Semi-Final Extra Long');
    // opponentName truncated to ~16 chars with an ellipsis.
    expect(serialized).toContain('AVeryLongOppone…');
    expect(serialized).not.toContain('AVeryLongOpponentTagName');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('renders each set row with its character-matchup sprite pair instead of a W/L letter square (07-10 walkthrough amendment round 2)', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const sets = [
      makeSet({
        roundLabel: 'Winners Finals',
        opponentName: 'Finalist',
        games: [{ fighterId: 1, opponentFighterId: 3, stageName: 'Battlefield', win: true }],
      }),
    ];
    const snapshot = makeRecapSnapshot({ detail: 'full', sets: sets as never });

    await renderWithMockedSatori({
      token: 'recap-token-set-row-sprites',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    // Sprite pair (mine + opponent's) rendered as data-URI <img> nodes.
    expect(serialized).toContain('data:image/png;base64');
    // The old abstract W/L letter square (24x24, borderRadius 4, background
    // #059669/#dc2626) is gone — W/L is now conveyed by the score text color.
    expect(serialized).not.toContain('"width":24,"height":24,"borderRadius":4');
    expect(serialized).not.toContain('"children":"W"');
    expect(serialized).not.toContain('"children":"L"');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('still renders a valid, non-null PNG for a "full" recap with sets when every set-row sprite fetch fails', async () => {
    const fetchImpl = fetchFails();
    const sets = [
      makeSet({
        roundLabel: 'Winners Finals',
        opponentName: 'Finalist',
        games: [{ fighterId: 1, opponentFighterId: 3, stageName: 'Battlefield', win: true }],
      }),
    ];
    const snapshot = makeRecapSnapshot({ detail: 'full', sets: sets as never });

    const png = await renderOgImage({
      token: 'recap-token-set-row-sprite-fail',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('degrades a set row to a text fallback (never a broken image) when the sprite fetch fails', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchFails();
    const sets = [
      makeSet({
        roundLabel: 'Winners Finals',
        opponentName: 'Finalist',
        games: [{ fighterId: 1, opponentFighterId: 3, stageName: 'Battlefield', win: true }],
      }),
    ];
    const snapshot = makeRecapSnapshot({ detail: 'full', sets: sets as never });

    await renderWithMockedSatori({
      token: 'recap-token-set-row-sprite-fail-tree',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).not.toContain('data:image/png;base64');
    // Text fallback uses the fighter name (truncated) in place of the sprite.
    expect(serialized).toContain('Mar');
    expect(serialized).toContain('Lin');

    vi.doUnmock('satori');
    vi.resetModules();
  });

  it('falls back to the character-sprite column for a "full" recap with zero sets (never throws, still a valid PNG)', async () => {
    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({ detail: 'full', sets: [] });

    const png = await renderOgImage({
      token: 'recap-token-full-zero-sets',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('uses the character-sprite column (never a set-rows column) for a "summary" recap, even if sets were somehow present', async () => {
    vi.resetModules();
    const satoriMock = vi.fn().mockResolvedValue('<svg></svg>');
    vi.doMock('satori', () => ({ default: satoriMock }));

    const { renderOgImage: renderWithMockedSatori } = await import('./renderOgImage.js');

    const fetchImpl = fetchOkPng();
    const snapshot = makeRecapSnapshot({ sets: [makeSet()] as never });

    await renderWithMockedSatori({
      token: 'recap-token-summary-ignores-sets',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(satoriMock.mock.calls[0]![0]);
    expect(serialized).not.toContain('more sets');
    expect(serialized).not.toContain('Winners Round 3 vs RivalTag');

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
