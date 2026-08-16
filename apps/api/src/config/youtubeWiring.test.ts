import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

const ADMIN_UID = 'admin-1';
const ADMIN_TOKEN = 'admin-token';
const RESEARCH_CONFIG = { adminUids: new Set([ADMIN_UID]) };

/**
 * Phase 30.3 Gate 5 (30.3-integration follow-up): the production-wiring gate
 * for the YouTube Data API config, modeled on `researchConfigWiring.test.ts`
 * and `prepPaidWiring.test.ts` so every config-null gate in this file reads
 * alike. Unlike `researchConfig`/`demoAccountConfig`, the YouTube config is
 * never decorated directly onto the app instance — it is threaded straight
 * through to `researchTenantsRoutes`'s own plugin options — so the runtime
 * proof below exercises the actual HTTP route rather than an `app.X`
 * decoration, and the source-level proof covers `apps/api/src/index.ts`'s
 * `getYoutubeConfig(env)` threading exactly like the other two files do.
 */

async function createResearchTenant(
  options: Parameters<typeof buildTestApp>[0] = {},
): Promise<{ app: ReturnType<typeof buildTestApp>['app']; tenantId: string }> {
  const { app, auth } = buildTestApp({ research: RESEARCH_CONFIG, ...options });
  auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/research/tenants',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { label: 'youtube-wiring-test tenant' },
  });
  const tenantId = createResponse.json().tenantId as string;
  return { app, tenantId };
}

describe('YOUTUBE_API_KEY wiring (30.3 config-gated VOD-candidate discovery)', () => {
  it('answers the config-missing 503 when youtube is omitted from buildApp options (default-OFF)', async () => {
    const { app, tenantId } = await createResearchTenant();

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/enrichment/vod-candidates/discover`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('not configured');
  });

  it('answers the config-missing 503 when youtube is explicitly null (omission and explicit null are identical)', async () => {
    const { app, tenantId } = await createResearchTenant({ youtube: null });

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/enrichment/vod-candidates/discover`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('not configured');
  });

  it('proceeds past the config-missing gate (never 503-not-configured) once youtube is supplied to buildApp — app.ts defaults youtubeFetch to the global fetch when the caller omits it', async () => {
    const { app, tenantId } = await createResearchTenant({
      youtube: { apiKey: 'test-key' },
      // youtubeFetch intentionally omitted — proves app.ts's own
      // `options.youtubeFetch ?? fetch` default, mirroring `webBaseUrl`'s
      // own-default convention rather than requiring every caller to pass
      // a fetch override.
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/enrichment/vod-candidates/discover`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    // A freshly-created tenant has no unmatched target sets to consider, so
    // discovery short-circuits to an empty report WITHOUT ever calling
    // fetch (`vodDiscovery.ts`'s `{ consideredSets: 0, targets: [] }` early
    // return) — the meaningful assertion is that the response is no longer
    // the youtube-unconfigured 503.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ consideredSets: 0 });
  });

  it('proceeds past the config-missing gate with an explicit youtubeFetch override (tests never reach the real network)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ items: [] }))) as unknown as typeof fetch;
    const { app, tenantId } = await createResearchTenant({
      youtube: { apiKey: 'test-key' },
      youtubeFetch: fetchImpl,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/research/tenants/${tenantId}/enrichment/vod-candidates/discover`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('index.ts wires YOUTUBE_API_KEY through to buildApp (production-wiring gate)', () => {
  const indexSource = readFileSync(resolve('src/index.ts'), 'utf-8');

  it('discovers a non-trivial index.ts to scan (a silently-empty read would make every case below vacuously pass)', () => {
    expect(indexSource.length).toBeGreaterThan(500);
  });

  it('imports getYoutubeConfig from ./config/env.js', () => {
    expect(indexSource).toMatch(/getYoutubeConfig/);
  });

  it('calls getYoutubeConfig(env)', () => {
    expect(indexSource).toMatch(/getYoutubeConfig\(env\)/);
  });

  it('passes the resulting value into the buildApp({...}) option object under the youtube key', () => {
    const buildAppCallMatch = indexSource.match(/buildApp\(\{[\s\S]*?\}\);/);
    expect(buildAppCallMatch).not.toBeNull();
    const buildAppCall = buildAppCallMatch![0];
    expect(buildAppCall).toMatch(/\byoutube\b/);
  });
});
