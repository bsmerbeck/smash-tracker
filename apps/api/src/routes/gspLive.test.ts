import { describe, expect, it, vi } from 'vitest';
import { GSP_LIVE_STALE_MS, GSPTIERS_ENDPOINT } from '../gspLive/service.js';
import { buildTestApp } from '../test-support/testApp.js';

function upstreamOk(body: unknown = { max: 16_368_515, elite: 14_813_136 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function upstreamDown() {
  return vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
}

describe('GET /api/gsp-live', () => {
  it('is public: fetches upstream, stores the reading, and returns it', async () => {
    const fetchImpl = upstreamOk();
    const { app, database } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });
    const before = Date.now();

    // No auth header on purpose — the endpoint exposes no user data.
    const response = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.elite).toBe(14_813_136);
    expect(body.max).toBe(16_368_515);
    expect(body.source).toBe('gsptiers.com');
    expect(body.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      GSPTIERS_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': expect.stringContaining('grandfinals') }),
      }),
    );
    expect(database.dump()).toMatchObject({ gspLive: { elite: 14_813_136 } });
  });

  it('serves a fresh cache without touching upstream', async () => {
    const fetchImpl = upstreamOk();
    const { app, database } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });
    database.seed('gspLive', {
      elite: 14_800_000,
      max: 16_350_000,
      fetchedAt: Date.now() - 60_000,
      source: 'gsptiers.com',
    });

    const response = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(response.statusCode).toBe(200);
    expect(response.json().elite).toBe(14_800_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes a stale cache from upstream', async () => {
    const fetchImpl = upstreamOk();
    const { app, database } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });
    database.seed('gspLive', {
      elite: 14_000_000,
      max: 16_000_000,
      fetchedAt: Date.now() - GSP_LIVE_STALE_MS - 1,
      source: 'gsptiers.com',
    });

    const response = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(response.statusCode).toBe(200);
    expect(response.json().elite).toBe(14_813_136);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves the stale cache when upstream is failing', async () => {
    const fetchImpl = upstreamDown();
    const { app, database } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });
    database.seed('gspLive', {
      elite: 14_000_000,
      max: 16_000_000,
      fetchedAt: Date.now() - GSP_LIVE_STALE_MS - 1,
      source: 'gsptiers.com',
    });

    const response = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(response.statusCode).toBe(200);
    expect(response.json().elite).toBe(14_000_000);
  });

  it('404s when there is no cache and upstream is failing, then backs off upstream retries', async () => {
    const fetchImpl = upstreamDown();
    const { app } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });

    const first = await app.inject({ method: 'GET', url: '/api/gsp-live' });
    const second = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);
    // The instance-local failure backoff means the second request must NOT
    // have re-hit upstream.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an upstream body that fails schema validation without caching it', async () => {
    const fetchImpl = upstreamOk({ max: 'garbage' });
    const { app, database } = buildTestApp({ gspLiveFetch: fetchImpl as unknown as typeof fetch });

    const response = await app.inject({ method: 'GET', url: '/api/gsp-live' });

    expect(response.statusCode).toBe(404);
    expect(database.dump().gspLive).toBeUndefined();
  });
});
