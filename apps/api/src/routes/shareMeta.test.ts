import { describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

// Valid-SHAPE tokens (43-char base64url, matching generateShareToken's
// output): getShareByToken rejects anything outside
// /^[A-Za-z0-9_-]{20,128}$/ before ever reading RTDB, so short/illegal
// tokens would never exercise the lookup paths these tests target.
const TOKEN = 'aValidToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'noSuchToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVOKED_TOKEN = 'revokedToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHARE_ID = 'share-1';

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
</body>
</html>`;

/** A minimal, valid 1x1 PNG (fine as a fake sprite/static-fallback fetch response). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function seedActiveShare(
  database: ReturnType<typeof buildTestApp>['database'],
  overrides: { token?: string; shareId?: string; revokedAt?: number } = {},
) {
  const token = overrides.token ?? TOKEN;
  const shareId = overrides.shareId ?? SHARE_ID;

  database.seed(`shareTokens/${token}`, {
    shareId,
    ownerUid: 'owner-uid',
    permissions: 'view',
    createdAt: 1000,
    ...(overrides.revokedAt !== undefined ? { revokedAt: overrides.revokedAt } : {}),
  });
  database.seed(`shareSnapshots/${shareId}`, {
    uid: 'owner-uid',
    matchId: 'match-1',
    createdAt: 1000,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 3,
    stage: { id: 1, name: 'Battlefield' },
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 2,
    redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
  });

  return { token, shareId };
}

/** Routes every fetch to the right fake body by URL suffix (shell, sprite, static og-image fallback). */
function fetchRouter() {
  return vi.fn().mockImplementation((input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/spa.html')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(FAKE_SHELL),
      } as unknown as Response);
    }
    // Sprites and the static og-image.png fallback are all served as the
    // same tiny fake PNG for this test's purposes.
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        Promise.resolve(
          TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
        ),
    } as unknown as Response);
  });
}

describe('GET /s/:token', () => {
  it('returns 200 HTML with per-token OG meta, no-store, and Referrer-Policy for an active token', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database);

    const response = await app.inject({ method: 'GET', url: `/s/${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.body).toContain('Mario vs Link');
    // og:image/twitter:image are swapped to the generated per-token card
    // (buildTestApp's default webBaseUrl is http://localhost:5173).
    expect(response.body).toContain(
      `<meta property="og:image" content="http://localhost:5173/s/${TOKEN}/og.png">`,
    );
    expect(response.body).toContain(
      `<meta name="twitter:image" content="http://localhost:5173/s/${TOKEN}/og.png">`,
    );
  });

  it('returns 200 with generic non-leaking noindex meta for an unknown/revoked token', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database, {
      token: REVOKED_TOKEN,
      shareId: 'revoked-share',
      revokedAt: 2000,
    });

    const unknownResponse = await app.inject({ method: 'GET', url: `/s/${UNKNOWN_TOKEN}` });
    const revokedResponse = await app.inject({ method: 'GET', url: `/s/${REVOKED_TOKEN}` });

    for (const response of [unknownResponse, revokedResponse]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Shared VOD review');
      expect(response.body).toMatch(/<meta name="robots" content="noindex">/);
      expect(response.body).not.toContain('Mario');
      // The shell's generic static image is left untouched — never a
      // per-token card URL for an unknown/revoked token (VIEW-05).
      expect(response.body).toContain(
        '<meta property="og:image" content="https://grandfinals.gg/og-image.png">',
      );
      expect(response.body).not.toContain('/og.png"');
    }
  });

  it('returns 200 generic HTML (never a 500) for a malformed token with RTDB-illegal path characters', async () => {
    const fetchImpl = fetchRouter();
    const { app } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });

    // `GET /s/og.png` is a plausible bot probe that routes here with
    // token="og.png" — the dot would make firebase-admin's ref() throw if
    // it ever reached an RTDB read (a prod-only 500 without the shape guard).
    for (const url of ['/s/og.png', '/s/foo.bar']) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Shared VOD review');
      expect(response.body).toMatch(/<meta name="robots" content="noindex">/);
      expect(response.body).not.toContain('Mario');
    }
  });
});

describe('GET /s/:token/og.png', () => {
  it('returns 200 image/png with Cache-Control public, max-age=300 for an active token', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database);

    const response = await app.inject({ method: 'GET', url: `/s/${TOKEN}/og.png` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(Buffer.from(response.rawPayload).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('returns 200 image/png (the static fallback) for an unknown token, never 404/500', async () => {
    const fetchImpl = fetchRouter();
    const { app } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });

    const response = await app.inject({ method: 'GET', url: `/s/${UNKNOWN_TOKEN}/og.png` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(Buffer.from(response.rawPayload).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('returns 200 image/png (the static fallback, never a 500) for a malformed token with RTDB-illegal path characters', async () => {
    const fetchImpl = fetchRouter();
    const { app } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });

    const response = await app.inject({ method: 'GET', url: '/s/foo.bar/og.png' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(Buffer.from(response.rawPayload).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});

describe('/s/* rate limiting', () => {
  it('rate-limits GET /s/:token to 60 req/min keyed on the RIGHTMOST X-Forwarded-For entry — rotating a spoofed leftmost entry does NOT mint a fresh bucket', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database);

    // In production Cloud Run APPENDS the real client IP as the rightmost
    // XFF entry; anything left of it is attacker-supplied.
    const FIRST_IP = '1.2.3.4';
    const SECOND_IP = '5.6.7.8';

    let lastStatus = 200;
    for (let i = 0; i < 60; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/s/${TOKEN}`,
        headers: { 'x-forwarded-for': FIRST_IP },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(200);

    const sixtyFirst = await app.inject({
      method: 'GET',
      url: `/s/${TOKEN}`,
      headers: { 'x-forwarded-for': FIRST_IP },
    });
    expect(sixtyFirst.statusCode).toBe(429);

    // Spoof attempt: rotate the LEFT side while the trusted rightmost entry
    // stays FIRST_IP — must land in the SAME (already exhausted) bucket.
    const spoofedLeft = await app.inject({
      method: 'GET',
      url: `/s/${TOKEN}`,
      headers: { 'x-forwarded-for': `6.6.6.6, ${FIRST_IP}` },
    });
    expect(spoofedLeft.statusCode).toBe(429);

    // A genuinely different client (different rightmost entry) gets its own bucket.
    const differentIp = await app.inject({
      method: 'GET',
      url: `/s/${TOKEN}`,
      headers: { 'x-forwarded-for': SECOND_IP },
    });
    expect(differentIp.statusCode).toBe(200);
  });
});
