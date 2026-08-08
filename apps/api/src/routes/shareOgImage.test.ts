import { describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

// Valid-SHAPE tokens (43-char base64url, matching generateShareToken's
// output) — mirrors shareMeta.test.ts's own token fixtures.
const TOKEN = 'aValidToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'noSuchToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHARE_ID = 'share-1';

/** A minimal, valid 1x1 PNG (fine as a fake sprite/static-fallback fetch response). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function seedActiveShare(
  database: ReturnType<typeof buildTestApp>['database'],
  overrides: { token?: string; shareId?: string; ownerUid?: string } = {},
) {
  const token = overrides.token ?? TOKEN;
  const shareId = overrides.shareId ?? SHARE_ID;
  const ownerUid = overrides.ownerUid ?? 'owner-uid';

  database.seed(`shareTokens/${token}`, {
    shareId,
    ownerUid,
    permissions: 'view',
    createdAt: 1000,
  });
  database.seed(`shareSnapshots/${shareId}`, {
    uid: ownerUid,
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

  return { token, shareId, ownerUid };
}

/** Routes every fetch to a fake sprite/static-fallback response — mirrors shareMeta.test.ts's fetchRouter. */
function fetchRouter() {
  return vi.fn().mockImplementation(() => {
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

/**
 * Phase 29 Plan 06 (RTEN-03, D-05, T-29-06-04): `GET /s/:token/og.png` is a
 * thin caller of `RtdbService.getShareByToken` — no authorization logic of
 * its own. A research-subject token must fall back to the IDENTICAL static
 * PNG an unknown token gets, never a per-token render that would leak the
 * existence of a research workspace. See `shareMeta.test.ts` for this
 * route's full non-RTEN-03 coverage (per-token render, malformed-token
 * fallback, unknown-token fallback) — this file is scoped to the RTEN-03
 * addition only, per this plan's file ownership.
 */
describe('GET /s/:token/og.png — RTEN-03 research-subject refusal', () => {
  it('returns the IDENTICAL static-fallback PNG for a research-subject token as for an unknown token (no oracle)', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database);
    database.seed('clientTenants/owner-uid', { createdAt: 1, kind: 'research' });

    const researchResponse = await app.inject({ method: 'GET', url: `/s/${TOKEN}/og.png` });
    const unknownResponse = await app.inject({ method: 'GET', url: `/s/${UNKNOWN_TOKEN}/og.png` });

    expect(researchResponse.statusCode).toBe(200);
    expect(researchResponse.headers['content-type']).toBe('image/png');
    expect(Buffer.from(researchResponse.rawPayload)).toEqual(
      Buffer.from(unknownResponse.rawPayload),
    );
  });

  it('returns the IDENTICAL static-fallback PNG for a subject whose kind cannot be resolved (fail closed, no oracle)', async () => {
    const fetchImpl = fetchRouter();
    const { app, database } = buildTestApp({ shareFetch: fetchImpl as unknown as typeof fetch });
    seedActiveShare(database, { ownerUid: 'unresolvable-owner' });
    database.seed('clientTenants/unresolvable-owner/kind', 'not-a-real-kind');

    const unresolvableResponse = await app.inject({ method: 'GET', url: `/s/${TOKEN}/og.png` });
    const unknownResponse = await app.inject({ method: 'GET', url: `/s/${UNKNOWN_TOKEN}/og.png` });

    expect(unresolvableResponse.statusCode).toBe(200);
    expect(unresolvableResponse.headers['content-type']).toBe('image/png');
    expect(Buffer.from(unresolvableResponse.rawPayload)).toEqual(
      Buffer.from(unknownResponse.rawPayload),
    );
  });
});
