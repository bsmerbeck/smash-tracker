import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { renderShareHtml, resetShareHtmlCachesForTests } from './renderShareHtml.js';

const WEB_BASE_URL = 'https://grandfinals.gg';
const TOKEN = 'a-valid-token';

const FAKE_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>grandfinals.gg</title>
<meta property="og:title" content="grandfinals.gg">
<meta name="twitter:title" content="grandfinals.gg">
<meta name="description" content="Static default description">
<meta property="og:description" content="Static default description">
<meta name="twitter:description" content="Static default description">
<link rel="canonical" href="https://grandfinals.gg/">
<meta property="og:url" content="https://grandfinals.gg/">
<meta property="og:image" content="https://grandfinals.gg/og-image.png">
<meta name="twitter:image" content="https://grandfinals.gg/og-image.png">
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/index-abc123.js"></script>
</body>
</html>`;

function fetchOk(body: string, etag?: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) },
  } as unknown as Response);
}

function fetchNotModified() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 304,
    text: () => Promise.resolve(''),
    headers: { get: () => null },
  } as unknown as Response);
}

function fetchRejects() {
  return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
}

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

describe('renderShareHtml', () => {
  beforeEach(() => {
    // The module-level shell cache would otherwise carry the shell fetched
    // by an earlier test into the shell-fetch-FAILURE tests below, silently
    // satisfying them via the cached happy path (iteration-2 review WR-03).
    resetShareHtmlCachesForTests();
    // The shell-fetch-failure tests deliberately trigger the log-and-degrade
    // console.error — silence it so test output stays clean (behavior is
    // asserted via the fallback content, not the log).
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces per-token OG meta from an active snapshot, noindex, and no note/tag text', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeSnapshot({
      timestamps: [{ seconds: 30, note: 'SECRET NOTE TEXT', tags: ['SECRET TAG'] }],
    });

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).toMatch(
      /<meta property="og:title" content="Mario vs Link — VOD review · grandfinals\.gg">/,
    );
    expect(html).toMatch(/<meta name="twitter:title" content="Mario vs Link/);
    expect(html).toMatch(
      /<meta property="og:description" content="4 timestamped moments · Battlefield/,
    );
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    expect(html).toContain(`href="${WEB_BASE_URL}/s/${TOKEN}"`);
    // The generated per-token OG card must replace the shell's static image
    // — this is what makes /s/:token/og.png reachable by crawlers at all.
    expect(html).toContain(
      `<meta property="og:image" content="${WEB_BASE_URL}/s/${TOKEN}/og.png">`,
    );
    expect(html).toContain(
      `<meta name="twitter:image" content="${WEB_BASE_URL}/s/${TOKEN}/og.png">`,
    );
    expect(html).not.toContain('SECRET NOTE TEXT');
    expect(html).not.toContain('SECRET TAG');
  });

  it('omits the stage segment when the stage is the "no selection" sentinel (id 0)', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeSnapshot({ stage: { id: 0, name: 'no selection' } });

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // "4 timestamped moments · 1/15/2026" — no " · no selection" in between.
    expect(html).not.toContain('no selection');
    expect(html).toMatch(/<meta property="og:description" content="4 timestamped moments · 1\//);
  });

  it('escapes the owner display name when showDisplayName is true', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeSnapshot({
      redaction: { includedNotes: false, includedTags: false, showDisplayName: true },
      ownerDisplayName: '<script>alert(1)</script>',
    });

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it("inserts String.replace $-patterns ($&, $`, $', $$) in the display name and token verbatim — never expanded", async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeSnapshot({
      redaction: { includedNotes: false, includedTags: false, showDisplayName: true },
      // `$&`/`$\``/`$'`/`$$` are special in a String.replace replacement
      // STRING — a replacer function must keep them inert.
      ownerDisplayName: "a$&b$`c$'d$$e",
    });

    const html = await renderShareHtml({
      // The HTML route renders even for tokens getShareByToken rejects, so a
      // `$` can reach the canonical/og:url rewrite via the URL param.
      token: 'token$with$dollars',
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // escapeHtml turns the apostrophe into &#39;; every $ must survive
    // literally — `$$` must NOT collapse to `$`, `$&` must NOT expand to the
    // matched text, and `$\``/`$'` must NOT splice in surrounding tag text.
    expect(html).toContain('Shared by a$&amp;b$`c$&#39;d$$e.');
    expect(html).toContain(`href="${WEB_BASE_URL}/s/token$with$dollars"`);
    expect(html).toContain(
      `<meta property="og:url" content="${WEB_BASE_URL}/s/token$with$dollars">`,
    );
  });

  it('produces generic non-leaking meta with noindex for a null (unknown/revoked) snapshot', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);

    const html = await renderShareHtml({
      token: 'unknown-token',
      snapshot: null,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).toContain('Shared VOD review · grandfinals.gg');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    expect(html).not.toContain('Mario');
    expect(html).not.toContain('Link');
    expect(html).not.toContain('Battlefield');
    // The shell's generic static image is kept UNTOUCHED — a per-token card
    // URL would hint the token might be valid (VIEW-05).
    expect(html).toContain(
      '<meta property="og:image" content="https://grandfinals.gg/og-image.png">',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://grandfinals.gg/og-image.png">',
    );
    expect(html).not.toContain('/og.png');
  });

  it('falls back to a hardcoded safe template when the shell fetch rejects', async () => {
    const fetchImpl = fetchRejects();
    const snapshot = makeSnapshot();

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The rejecting fetch must actually have been attempted — a populated
    // shell cache would short-circuit getShell before fetchImpl runs.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Mario vs Link — VOD review · grandfinals.gg');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    // Only the hardcoded fallback template can satisfy these: the fetched
    // shell has a root div + bundle script and no "Reload this page" link.
    expect(html).not.toContain('<div id="root">');
    expect(html).toContain('Reload this page');
    // Even the degraded path can unfurl an image (active snapshot → per-token card).
    expect(html).toContain(
      `<meta property="og:image" content="${WEB_BASE_URL}/s/${TOKEN}/og.png">`,
    );
  });

  it('produces stat-derived OG meta for a recap snapshot, including the placement ordinal', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeRecapSnapshot();

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).toMatch(
      /<meta property="og:title" content="3rd at Genesis X — recap · grandfinals\.gg">/,
    );
    expect(html).toMatch(/<meta property="og:description" content="5–2 set record/);
    expect(html).toContain('seed 8');
    expect(html).toContain('4 reviewed moments');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    expect(html).toContain(
      `<meta property="og:image" content="${WEB_BASE_URL}/s/${TOKEN}/og.png">`,
    );
  });

  it('omits the placement ordinal and the reviewed-moments phrase when absent/zero', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeRecapSnapshot({
      placement: undefined,
      seed: undefined,
      reviewedMomentsCount: 0,
    });

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).toMatch(
      /<meta property="og:title" content="Genesis X — recap · grandfinals\.gg">/,
    );
    expect(html).not.toContain(' at Genesis X');
    expect(html).not.toContain('seed');
    expect(html).not.toContain('reviewed moment');
    expect(html).toMatch(/<meta property="og:description" content="5–2 set record\. Watch/);
  });

  it('escapes an HTML-special tournament name in recap meta', async () => {
    const fetchImpl = fetchOk(FAKE_SHELL);
    const snapshot = makeRecapSnapshot({ tournamentName: '<script>alert(1)</script>' });

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to the hardcoded safe template when the shell fetch returns a non-2xx status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(''),
    } as unknown as Response);

    const html = await renderShareHtml({
      token: TOKEN,
      snapshot: null,
      webBaseUrl: WEB_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The non-2xx fetch must actually have been attempted (no cached shell).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
    // Only the hardcoded fallback template can satisfy these — the cached
    // shell (which also carries this og:image URL) has a root div.
    expect(html).not.toContain('<div id="root">');
    expect(html).toContain('Reload this page');
    // Null snapshot in the degraded path → the generic static image, never
    // a per-token card URL (VIEW-05).
    expect(html).toContain(`<meta property="og:image" content="${WEB_BASE_URL}/og-image.png">`);
  });

  describe('IN-06: ETag conditional revalidation of the shell cache', () => {
    it('sends If-None-Match with the prior ETag and reuses the cached html on a 304', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FAKE_SHELL),
          headers: {
            get: (name: string) => (name.toLowerCase() === 'etag' ? '"v1"' : null),
          },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 304,
          text: () => Promise.resolve(''),
          headers: { get: () => null },
        } as unknown as Response);
      const snapshot = makeSnapshot();
      const args = {
        token: TOKEN,
        snapshot,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      };

      const first = await renderShareHtml(args);
      const second = await renderShareHtml(args);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const secondInit = fetchImpl.mock.calls[1]?.[1] as { headers?: Record<string, string> };
      expect(secondInit?.headers).toEqual({ 'If-None-Match': '"v1"' });
      expect(second).toEqual(first);
    });

    it('IN-06 regression: a fresh 200 on the next request (e.g. after a hosting deploy) is served immediately, not a stale cached bundle reference', async () => {
      const newShell = FAKE_SHELL.replace('index-abc123.js', 'index-def456.js');
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FAKE_SHELL),
          headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? '"v1"' : null) },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(newShell),
          headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? '"v2"' : null) },
        } as unknown as Response);
      const snapshot = makeSnapshot();
      const args = {
        token: TOKEN,
        snapshot,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      };

      const first = await renderShareHtml(args);
      const second = await renderShareHtml(args);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(first).toContain('index-abc123.js');
      expect(second).toContain('index-def456.js');
    });

    it('serves the last-good cached shell (stale-on-error), not the fallback template, when a revalidation fetch rejects', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(FAKE_SHELL),
          headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? '"v1"' : null) },
        } as unknown as Response)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const snapshot = makeSnapshot();
      const args = {
        token: TOKEN,
        snapshot,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      };

      const first = await renderShareHtml(args);
      const second = await renderShareHtml(args);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
      // The real cached shell (has a root div), never the hardcoded fallback.
      expect(second).toContain('<div id="root">');
      expect(second).not.toContain('Reload this page');
    });

    it('a cold-cache non-2xx status still falls back to the hardcoded safe template (no cached entry to serve stale)', async () => {
      const fetchImpl = fetchNotModified(); // 304 with nothing cached — treated as a failure
      const snapshot = makeSnapshot();

      const html = await renderShareHtml({
        token: TOKEN,
        snapshot,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(html).toContain('Reload this page');
    });

    it('works without an ETag header: the next request sends no If-None-Match and simply refetches', async () => {
      const fetchImpl = fetchOk(FAKE_SHELL); // no etag
      const snapshot = makeSnapshot();
      const args = {
        token: TOKEN,
        snapshot,
        webBaseUrl: WEB_BASE_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      };

      await renderShareHtml(args);
      await renderShareHtml(args);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]).toBeUndefined();
      expect(fetchImpl.mock.calls[1]?.[1]).toBeUndefined();
    });
  });
});
