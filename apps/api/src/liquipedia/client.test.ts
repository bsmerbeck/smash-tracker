import { describe, expect, it } from 'vitest';
import { createLiquipediaFixtureFetch, matchQuery } from './__fixtures__/loadFixture.js';
import type { LiquipediaLimiter } from './limiter.js';
import {
  LIQUIPEDIA_API_ENDPOINT,
  LIQUIPEDIA_MAX_RESPONSE_BYTES,
  LIQUIPEDIA_MAX_TITLES_PER_REQUEST,
  LIQUIPEDIA_PARSE_CLASS_ALLOWLIST,
  LiquipediaApiError,
  LiquipediaParseNotAllowedError,
  LiquipediaResponseTooLargeError,
  buildLiquipediaPageUrl,
  createLiquipediaClient,
  isParseClassPageAllowed,
  resolveLiquipediaRetryDelayMs,
  type CreateLiquipediaClientOptions,
} from './client.js';

const CONTACT = 'https://github.com/bsmerbeck/smash-tracker';

function makeTrackingLimiter(): { limiter: LiquipediaLimiter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    limiter: {
      async acquire(requestClass) {
        calls.push(requestClass);
        return { granted: true, waitedMs: 0 };
      },
    },
  };
}

function withHeaderCapture(fetchImpl: typeof fetch): {
  fetchImpl: typeof fetch;
  capturedHeaders: Headers[];
} {
  const capturedHeaders: Headers[] = [];
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capturedHeaders.push(new Headers(init?.headers ?? {}));
    return fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl: wrapped, capturedHeaders };
}

function baseOptions(
  fetchImpl: typeof fetch,
  limiter: LiquipediaLimiter,
): CreateLiquipediaClientOptions {
  return {
    config: { contact: CONTACT },
    limiter,
    fetchImpl,
  };
}

describe('createLiquipediaClient — construction', () => {
  it('refuses construction without a configured contact identifier, throwing before any request is attempted', () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([]);
    const { limiter, calls } = makeTrackingLimiter();
    expect(() => createLiquipediaClient({ config: { contact: '' }, limiter, fetchImpl })).toThrow(
      /contact identifier/i,
    );
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('cannot be constructed without an explicit fetch implementation (compile-time gate)', () => {
    const { limiter } = makeTrackingLimiter();
    // @ts-expect-error fetchImpl is a REQUIRED member with no default — omitting it
    // is a compile error. If `fetchImpl` ever gained a default, this directive would
    // become an UNUSED `@ts-expect-error` and `tsc --noEmit` would fail the build —
    // that failure IS the proof this test exists to provide.
    const client = createLiquipediaClient({ config: { contact: CONTACT }, limiter });
    expect(client).toBeDefined();
  });
});

describe('createLiquipediaClient — request shape', () => {
  it('every issued request carries a User-Agent naming grandfinals.gg, its version and the configured contact, plus an explicit gzip accept-encoding header', async () => {
    const { fetchImpl: fixtureFetch } = createLiquipediaFixtureFetch([
      { match: matchQuery({ action: 'query', meta: 'siteinfo' }), fixture: 'siteinfo' },
    ]);
    const { fetchImpl, capturedHeaders } = withHeaderCapture(fixtureFetch);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    await client.getSiteInfo();

    expect(capturedHeaders).toHaveLength(1);
    const userAgent = capturedHeaders[0]?.get('user-agent');
    expect(userAgent).toContain('grandfinals.gg');
    expect(userAgent).toContain(CONTACT);
    expect(userAgent).toMatch(/grandfinals\.gg-liquipedia-enrichment\/\d+\.\d+/);
    expect(capturedHeaders[0]?.get('accept-encoding')).toBe('gzip');
  });

  it('every issued request targets exactly the constant API endpoint', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([
      { match: matchQuery({ action: 'query', meta: 'siteinfo' }), fixture: 'siteinfo' },
    ]);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    await client.getSiteInfo();

    expect(requests).toHaveLength(1);
    expect(`${requests[0]!.origin}${requests[0]!.pathname}`).toBe(LIQUIPEDIA_API_ENDPOINT);
  });
});

describe('createLiquipediaClient — headRevisions', () => {
  it('issues one request carrying formatversion 2, redirects enabled, and a revision property list that omits content', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({
          action: 'query',
          titles: 'Hungrybox/VODs|Sparg0/VODs|MkLeo/VODs|IzAw/VODs',
        }),
        fixture: 'query-vodpages-stub-wikitext',
      },
    ]);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    await client.headRevisions(['Hungrybox/VODs', 'Sparg0/VODs', 'MkLeo/VODs', 'IzAw/VODs']);

    expect(requests).toHaveLength(1);
    const url = requests[0]!;
    expect(url.searchParams.get('formatversion')).toBe('2');
    expect(url.searchParams.get('redirects')).toBe('1');
    expect(url.searchParams.get('rvprop')).not.toContain('content');
  });

  it('returns the pages array plus normalized/redirects defaulting to empty arrays when the response omits them, and flags the missing page as a first-class result rather than throwing', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'query', titles: 'Supernova/2026/Ultimate/Singles Bracket' }),
        fixture: 'query-headrevisions-batch',
      },
      {
        match: matchQuery({
          action: 'query',
          titles: 'Hungrybox/VODs|Sparg0/VODs|MkLeo/VODs|IzAw/VODs',
        }),
        fixture: 'query-vodpages-stub-wikitext',
      },
    ]);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    const headRevisionResult = await client.headRevisions([
      'Supernova/2026/Ultimate/Singles Bracket',
    ]);
    expect(headRevisionResult.normalized).toEqual([]);
    expect(headRevisionResult.redirects).toEqual([]);
    expect(headRevisionResult.pages).toHaveLength(1);
    expect(headRevisionResult.pages[0]).toMatchObject({ present: true, revisionId: 535578 });

    const vodPagesResult = await client.headRevisions([
      'Hungrybox/VODs',
      'Sparg0/VODs',
      'MkLeo/VODs',
      'IzAw/VODs',
    ]);
    expect(vodPagesResult.redirects).toEqual([{ from: 'MkLeo', to: 'MKLeo' }]);
    const izawEntry = vodPagesResult.pages.find((page) => page.title === 'IzAw/VODs');
    expect(izawEntry).toEqual({ present: false, title: 'IzAw/VODs' });
    expect((izawEntry as { revisions?: unknown }).revisions).toBeUndefined();
  });

  it('rejects a batch larger than 50 titles before the request is issued', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([]);
    const { limiter, calls } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    const titles = Array.from({ length: LIQUIPEDIA_MAX_TITLES_PER_REQUEST + 1 }, (_, i) => `T${i}`);
    await expect(client.headRevisions(titles)).rejects.toThrow(/50/);
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('createLiquipediaClient — getWikitext', () => {
  it('returns the slot content for the mandatory Supernova fixture and exposes its revision id and sha1', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({
          action: 'query',
          titles: 'Supernova/2026/Ultimate/Singles_Bracket',
        }),
        fixture: 'query-supernova-2026-singles-bracket',
      },
    ]);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    const result = await client.getWikitext(['Supernova/2026/Ultimate/Singles_Bracket']);

    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.present).toBe(true);
    if (page.present) {
      expect(page.revisionId).toBe(535578);
      expect(page.sha1).toBe('54d1f9ba7e2fe97079448f3c04646ed5076fb1e3');
      expect(page.content).toContain('DISPLAYTITLE');
    }
    expect(result.normalized).toEqual([
      {
        fromencoded: false,
        from: 'Supernova/2026/Ultimate/Singles_Bracket',
        to: 'Supernova/2026/Ultimate/Singles Bracket',
      },
    ]);
  });
});

describe('createLiquipediaClient — getGeneratedVodPage', () => {
  it('succeeds for an allowlisted title (default expandtemplates mode)', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'expandtemplates', title: 'Sparg0/VODs' }),
        fixture: 'expandtemplates-sparg0-vods',
      },
    ]);
    const { limiter, calls } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    const result = await client.getGeneratedVodPage('Sparg0/VODs');

    expect(result.mode).toBe('expandtemplates');
    expect(result.content).toContain('vodlink');
    expect(calls).toEqual(['parse-class']);
  });

  it('succeeds for an allowlisted title in the rendered-parse fallback mode', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'parse', page: 'Sparg0/VODs' }),
        fixture: 'parse-sparg0-vods',
      },
    ]);
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    const result = await client.getGeneratedVodPage('Sparg0/VODs', { mode: 'parse' });

    expect(result.mode).toBe('parse');
    expect(result.revisionId).toBe(347554);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('throws a distinct error type for a non-allowlisted title, BEFORE the limiter is consulted and before any fetch occurs', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([]);
    const { limiter, calls } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(fetchImpl, limiter));

    await expect(
      client.getGeneratedVodPage('Supernova/2026/Ultimate/Singles Bracket'),
    ).rejects.toBeInstanceOf(LiquipediaParseNotAllowedError);

    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('createLiquipediaClient — error handling', () => {
  it('a 429 response with a retry-after header produces a retryable error carrying that header value, and the retry delay is finite, non-negative and clamped', async () => {
    const handBuiltFetch: typeof fetch = (async () =>
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { 'retry-after': '5', 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(handBuiltFetch, limiter));

    let caught: unknown;
    try {
      await client.headRevisions(['Sparg0/VODs']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LiquipediaApiError);
    const apiError = caught as LiquipediaApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.retryAfter).toBe('5');

    const delay = resolveLiquipediaRetryDelayMs(apiError, 0);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBe(5000);
  });

  it('rejects a response body larger than the configured maximum with a size error rather than parsing it', async () => {
    const oversizedBody = 'x'.repeat(LIQUIPEDIA_MAX_RESPONSE_BYTES + 10);
    const handBuiltFetch: typeof fetch = (async () =>
      new Response(oversizedBody, { status: 200 })) as unknown as typeof fetch;
    const { limiter } = makeTrackingLimiter();
    const client = createLiquipediaClient(baseOptions(handBuiltFetch, limiter));

    await expect(client.headRevisions(['Sparg0/VODs'])).rejects.toBeInstanceOf(
      LiquipediaResponseTooLargeError,
    );
  });
});

describe('buildLiquipediaPageUrl', () => {
  it('turns a page title into the article URL with spaces replaced by underscores', () => {
    expect(buildLiquipediaPageUrl('Supernova/2026/Ultimate/Singles Bracket')).toBe(
      'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    );
  });
});

describe('LIQUIPEDIA_PARSE_CLASS_ALLOWLIST / isParseClassPageAllowed', () => {
  it("has exactly one entry, matches the four demo players' VOD page titles, and rejects a bracket page, a tournament page, and a traversal-shaped title", () => {
    expect(LIQUIPEDIA_PARSE_CLASS_ALLOWLIST).toHaveLength(1);

    for (const title of ['Hungrybox/VODs', 'MKLeo/VODs', 'MkLeo/VODs', 'Sparg0/VODs']) {
      expect(isParseClassPageAllowed(title)).toBe(true);
    }

    expect(isParseClassPageAllowed('Supernova/2026/Ultimate/Singles Bracket')).toBe(false);
    expect(isParseClassPageAllowed('Supernova/2026/Ultimate')).toBe(false);
    expect(isParseClassPageAllowed('../../etc/passwd/VODs')).toBe(false);
  });
});
