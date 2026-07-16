import { describe, expect, it, vi } from 'vitest';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { renderShareHtml } from './renderShareHtml.js';

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
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/index-abc123.js"></script>
</body>
</html>`;

function fetchOk(body: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
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

describe('renderShareHtml', () => {
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
    expect(html).not.toContain('SECRET NOTE TEXT');
    expect(html).not.toContain('SECRET TAG');
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

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Mario vs Link — VOD review · grandfinals.gg');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
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

    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
  });
});
