import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postCanonicalEvent } from './canonicalEvents';

describe('postCanonicalEvent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let randomUUIDSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    randomUUIDSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-1111-1111-111111111111');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    randomUUIDSpy.mockRestore();
  });

  it('POSTs the correct shape to /api/events', () => {
    const before = Date.now();
    postCanonicalEvent('share_view_loaded', { share_kind: 'review' });
    const after = Date.now();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/events');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.eventId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.eventName).toBe('share_view_loaded');
    expect(body.payload).toEqual({ share_kind: 'review' });
    expect(body.occurredAt).toBeGreaterThanOrEqual(before);
    expect(body.occurredAt).toBeLessThanOrEqual(after);
  });

  it('defaults payload to an empty object when omitted', () => {
    postCanonicalEvent('signup_cta_clicked');

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.payload).toEqual({});
  });

  it('never throws when the underlying fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(() => postCanonicalEvent('share_view_loaded')).not.toThrow();
    // Give the rejected promise's .catch() handler a microtask/macrotask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
