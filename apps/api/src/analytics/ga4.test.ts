import { describe, expect, it, vi } from 'vitest';
import type { Ga4Config } from '../config/env.js';
import { getGa4Config } from '../config/env.js';
import {
  reviewShared,
  reviewSharedClientId,
  sendMeasurementProtocolEvent,
  sendMeasurementProtocolEventResult,
} from './ga4.js';

const config: Ga4Config = { measurementId: 'G-TEST123', apiSecret: 'shh-secret-value' };

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('sendMeasurementProtocolEvent', () => {
  it('never calls fetch when config is null', async () => {
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    await sendMeasurementProtocolEvent(
      null,
      'client-1',
      'review_shared',
      { kind: 'review' },
      mockFetch,
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs to the MP endpoint with measurement_id, api_secret, client_id, and event name', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const mockFetch = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body);
      return new Response(null, { status: 200 });
    });

    await sendMeasurementProtocolEvent(
      config,
      'client-1',
      'review_shared',
      { kind: 'recap' },
      mockFetch,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain('measurement_id=');
    expect(capturedUrl).toContain('api_secret=');
    const body = JSON.parse(capturedBody);
    expect(body.client_id).toBe('client-1');
    expect(body.events[0].name).toBe('review_shared');
    expect(body.events[0].params).toEqual({ kind: 'recap' });
  });

  it('never rejects when fetch rejects, and never logs the api_secret', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mockFetch = fakeFetch(() => Promise.reject(new Error('network partition')));

    await expect(
      sendMeasurementProtocolEvent(
        config,
        'client-1',
        'review_shared',
        { kind: 'review' },
        mockFetch,
      ),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls.flat().join(' ');
    expect(loggedText).not.toContain(config.apiSecret);

    consoleSpy.mockRestore();
  });
});

describe('sendMeasurementProtocolEventResult', () => {
  it('resolves false and never calls fetch when config is null', async () => {
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await sendMeasurementProtocolEventResult(
      null,
      'client-1',
      'checkout_completed',
      { packId: 'pack5' },
      mockFetch,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves true on a 2xx response', async () => {
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await sendMeasurementProtocolEventResult(
      config,
      'client-1',
      'checkout_completed',
      { packId: 'pack5' },
      mockFetch,
    );

    expect(result).toBe(true);
  });

  it('resolves false (never throws) on a non-ok response', async () => {
    const mockFetch = fakeFetch(() => new Response(null, { status: 500 }));

    const result = await sendMeasurementProtocolEventResult(
      config,
      'client-1',
      'checkout_completed',
      { packId: 'pack5' },
      mockFetch,
    );

    expect(result).toBe(false);
  });

  it('resolves false (never rejects) when fetch rejects, and never logs the api_secret', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mockFetch = fakeFetch(() => Promise.reject(new Error('network partition')));

    const result = await sendMeasurementProtocolEventResult(
      config,
      'client-1',
      'checkout_completed',
      { packId: 'pack5' },
      mockFetch,
    );

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls.flat().join(' ');
    expect(loggedText).not.toContain(config.apiSecret);

    consoleSpy.mockRestore();
  });
});

describe('getGa4Config', () => {
  it('returns null when only GA4_MEASUREMENT_ID is set', () => {
    expect(
      getGa4Config({ GA4_MEASUREMENT_ID: 'G-ABC' } as unknown as Parameters<
        typeof getGa4Config
      >[0]),
    ).toBeNull();
  });

  it('returns null when only GA4_API_SECRET is set', () => {
    expect(
      getGa4Config({ GA4_API_SECRET: 'secret' } as unknown as Parameters<typeof getGa4Config>[0]),
    ).toBeNull();
  });

  it('returns null when neither is set', () => {
    expect(getGa4Config({} as unknown as Parameters<typeof getGa4Config>[0])).toBeNull();
  });

  it('returns a config object when both are set', () => {
    expect(
      getGa4Config({
        GA4_MEASUREMENT_ID: 'G-ABC',
        GA4_API_SECRET: 'secret',
      } as unknown as Parameters<typeof getGa4Config>[0]),
    ).toEqual({ measurementId: 'G-ABC', apiSecret: 'secret' });
  });
});

describe('reviewSharedClientId', () => {
  it('derives a stable, non-raw-uid client id', () => {
    const clientId = reviewSharedClientId('firebase-uid-123');
    expect(clientId).not.toBe('firebase-uid-123');
    expect(clientId).toBe(reviewSharedClientId('firebase-uid-123'));
  });

  it('derives different ids for different uids', () => {
    expect(reviewSharedClientId('uid-a')).not.toBe(reviewSharedClientId('uid-b'));
  });
});

describe('reviewShared', () => {
  it('no-ops when config is null', async () => {
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    await reviewShared(null, 'uid-1', 'review', mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires a review_shared event with the kind param and a hashed client_id', async () => {
    let capturedBody = '';
    const mockFetch = fakeFetch((_url, init) => {
      capturedBody = String(init.body);
      return new Response(null, { status: 200 });
    });

    await reviewShared(config, 'uid-1', 'recap', mockFetch);

    const body = JSON.parse(capturedBody);
    expect(body.client_id).toBe(reviewSharedClientId('uid-1'));
    expect(body.events[0].name).toBe('review_shared');
    expect(body.events[0].params).toEqual({ kind: 'recap' });
  });
});
