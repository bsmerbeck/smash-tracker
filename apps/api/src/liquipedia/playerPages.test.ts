import { describe, expect, it } from 'vitest';
import type { LiquipediaLimiter } from './limiter.js';
import { createLiquipediaClient, type CreateLiquipediaClientOptions } from './client.js';
import {
  LIQUIPEDIA_INVALID_LABEL_REASON,
  LIQUIPEDIA_VOD_PAGE_MISSING_REASON,
  LIQUIPEDIA_VOD_SUBPAGE_SUFFIX,
  buildVodPageTitle,
  resolvePlayerVodPages,
} from './playerPages.js';

const CONTACT = 'https://github.com/bsmerbeck/smash-tracker';
const LIQUIPEDIA_API_ENDPOINT = 'https://liquipedia.net/smash/api.php';

function makeTrackingLimiter(): LiquipediaLimiter {
  return {
    async acquire() {
      return { granted: true, waitedMs: 0 };
    },
  };
}

/**
 * A hand-built, request-recording `fetch` implementation, mirroring
 * `client.test.ts`'s `handBuiltFetch` convention for cases not covered by
 * the committed named-fixture corpus. Routes purely on the `titles` query
 * param so the test can independently model the TWO real request shapes
 * `resolvePlayerVodPages` issues: the bare-player-label probe (step 1) and
 * the deduped `/VODs`-title probe (step 2). Both response bodies are
 * synthetic but shaped exactly like `MANIFEST.md`'s documented live
 * captures (matching revision ids), never a live request.
 */
function createHandBuiltFetch(routes: Array<{ titles: string; body: unknown }>): {
  fetchImpl: typeof fetch;
  requests: URL[];
} {
  const requests: URL[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === 'string' ? input : (input as URL | Request).toString());
    if (`${url.origin}${url.pathname}` !== LIQUIPEDIA_API_ENDPOINT) {
      throw new Error(`refusing non-Liquipedia URL "${url.toString()}"`);
    }
    requests.push(url);
    const titles = url.searchParams.get('titles') ?? '';
    const route = routes.find((candidate) => candidate.titles === titles);
    if (!route) {
      throw new Error(`createHandBuiltFetch: no registered route for titles="${titles}"`);
    }
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

// ---- synthetic response bodies (revision ids match MANIFEST.md) -----------

const PLAYER_LABEL_PROBE_BODY = {
  batchcomplete: true,
  query: {
    redirects: [{ from: 'MkLeo', to: 'MKLeo' }],
    pages: [
      {
        pageid: 1001,
        ns: 0,
        title: 'Hungrybox',
        revisions: [{ revid: 500001, timestamp: '2024-01-01T00:00:00Z', sha1: 'aaaa', size: 100 }],
      },
      {
        pageid: 1002,
        ns: 0,
        title: 'MKLeo',
        revisions: [{ revid: 500002, timestamp: '2024-01-01T00:00:00Z', sha1: 'bbbb', size: 100 }],
      },
      {
        pageid: 1003,
        ns: 0,
        title: 'Sparg0',
        revisions: [{ revid: 500003, timestamp: '2024-01-01T00:00:00Z', sha1: 'cccc', size: 100 }],
      },
      {
        pageid: 1004,
        ns: 0,
        title: 'IzAw',
        revisions: [{ revid: 500004, timestamp: '2024-01-01T00:00:00Z', sha1: 'dddd', size: 100 }],
      },
    ],
  },
};

const VOD_TITLE_PROBE_BODY = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 51027,
        ns: 0,
        title: 'Hungrybox/VODs',
        revisions: [{ revid: 347488, timestamp: '2022-07-15T20:45:21Z' }],
      },
      {
        pageid: 78964,
        ns: 0,
        title: 'Sparg0/VODs',
        revisions: [{ revid: 347554, timestamp: '2022-07-15T21:07:44Z' }],
      },
      {
        pageid: 52135,
        ns: 0,
        title: 'MKLeo/VODs',
        revisions: [{ revid: 347234, timestamp: '2022-08-14T02:25:59Z' }],
      },
      { ns: 0, title: 'IzAw/VODs', missing: true },
    ],
  },
};

function baseOptions(fetchImpl: typeof fetch): CreateLiquipediaClientOptions {
  return { config: { contact: CONTACT }, limiter: makeTrackingLimiter(), fetchImpl };
}

const FOUR_LABEL_ROUTES = [
  { titles: 'Hungrybox|MkLeo|Sparg0|IzAw', body: PLAYER_LABEL_PROBE_BODY },
  {
    titles: 'Hungrybox/VODs|MKLeo/VODs|Sparg0/VODs|IzAw/VODs',
    body: VOD_TITLE_PROBE_BODY,
  },
];

describe('buildVodPageTitle', () => {
  it('builds <canonicalPlayerTitle>/VODs using the single exported suffix constant', () => {
    expect(buildVodPageTitle('MKLeo')).toBe(`MKLeo${LIQUIPEDIA_VOD_SUBPAGE_SUFFIX}`);
    expect(LIQUIPEDIA_VOD_SUBPAGE_SUFFIX).toBe('/VODs');
  });

  it('rejects a label containing a path separator, before any request could ever be built from the result', () => {
    expect(() => buildVodPageTitle('../../etc/passwd')).toThrow(LIQUIPEDIA_INVALID_LABEL_REASON);
  });

  it('rejects a label with a leading namespace separator', () => {
    expect(() => buildVodPageTitle(':Category')).toThrow(LIQUIPEDIA_INVALID_LABEL_REASON);
  });
});

describe('resolvePlayerVodPages — the four demo players (labels already bear their input casing)', () => {
  it('issues the bare-player-label probe as ONE request, then the deduped VOD-title probe as a SECOND single request (not four)', async () => {
    const { fetchImpl, requests } = createHandBuiltFetch(FOUR_LABEL_ROUTES);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    await resolvePlayerVodPages(client, ['Hungrybox', 'MkLeo', 'Sparg0', 'IzAw']);

    expect(requests).toHaveLength(2);
    const vodTitleRequest = requests[1]!;
    expect(vodTitleRequest.searchParams.get('titles')).toBe(
      'Hungrybox/VODs|MKLeo/VODs|Sparg0/VODs|IzAw/VODs',
    );
  });

  it('resolves a player label that redirects to a differently capitalised canonical title BEFORE constructing the VOD page title', async () => {
    const { fetchImpl } = createHandBuiltFetch(FOUR_LABEL_ROUTES);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    const { resolved } = await resolvePlayerVodPages(client, [
      'Hungrybox',
      'MkLeo',
      'Sparg0',
      'IzAw',
    ]);

    const mkLeoEntry = resolved.find((entry) => entry.label === 'MkLeo');
    expect(mkLeoEntry?.canonicalPlayerTitle).toBe('MKLeo');
    expect(mkLeoEntry?.vodPageTitle).toBe('MKLeo/VODs');
    expect(mkLeoEntry?.present).toBe(true);
    expect(mkLeoEntry?.revisionId).toBe(347234);
  });

  it('carries the canonical page title, the constructed article URL and the revision id for provenance on a present page', async () => {
    const { fetchImpl } = createHandBuiltFetch(FOUR_LABEL_ROUTES);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    const { resolved } = await resolvePlayerVodPages(client, [
      'Hungrybox',
      'MkLeo',
      'Sparg0',
      'IzAw',
    ]);

    const sparg0Entry = resolved.find((entry) => entry.label === 'Sparg0');
    expect(sparg0Entry).toMatchObject({
      canonicalPlayerTitle: 'Sparg0',
      vodPageTitle: 'Sparg0/VODs',
      vodPageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
      revisionId: 347554,
      present: true,
      reason: null,
    });
  });

  it('returns IzAw as a first-class missing result carrying a stated reason, and consults no alternative source for it', async () => {
    const { fetchImpl, requests } = createHandBuiltFetch(FOUR_LABEL_ROUTES);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    const { resolved } = await resolvePlayerVodPages(client, [
      'Hungrybox',
      'MkLeo',
      'Sparg0',
      'IzAw',
    ]);

    const izawEntry = resolved.find((entry) => entry.label === 'IzAw');
    expect(izawEntry?.present).toBe(false);
    expect(izawEntry?.vodPageTitle).toBe('IzAw/VODs');
    expect(izawEntry?.reason).toBe(LIQUIPEDIA_VOD_PAGE_MISSING_REASON);
    expect(izawEntry?.revisionId).toBeNull();

    // No alternative source was consulted: the only two requests made are
    // the player-label probe and the VOD-title probe — no third request for
    // any substitute page (e.g. a bracket page) was ever issued.
    expect(requests).toHaveLength(2);
  });
});

describe('resolvePlayerVodPages — the duplicate-title trap', () => {
  it('two differently capitalised labels resolve to ONE canonical VOD page title, and the deduped report names the merged label', async () => {
    const routes = [
      { titles: 'MkLeo|MKLeo', body: PLAYER_LABEL_PROBE_BODY },
      { titles: 'MKLeo/VODs', body: VOD_TITLE_PROBE_BODY },
    ];
    const { fetchImpl, requests } = createHandBuiltFetch(routes);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    const { resolved, deduped } = await resolvePlayerVodPages(client, ['MkLeo', 'MKLeo']);

    // The fixture-backed request recorder proves the second label added no
    // request: the VOD-title probe carries the title exactly once.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.get('titles')).toBe('MKLeo/VODs');

    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.vodPageTitle === 'MKLeo/VODs')).toBe(true);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toEqual({ label: 'MKLeo', mergedInto: 'MkLeo' });
  });
});

describe('resolvePlayerVodPages — invalid labels', () => {
  it('rejects a label containing a path separator before any request is made for it, while still resolving the other valid labels', async () => {
    const routes = [
      { titles: 'Sparg0', body: PLAYER_LABEL_PROBE_BODY },
      { titles: 'Sparg0/VODs', body: VOD_TITLE_PROBE_BODY },
    ];
    const { fetchImpl, requests } = createHandBuiltFetch(routes);
    const client = createLiquipediaClient(baseOptions(fetchImpl));

    const { resolved } = await resolvePlayerVodPages(client, ['../../etc/passwd', 'Sparg0']);

    const invalidEntry = resolved.find((entry) => entry.label === '../../etc/passwd');
    expect(invalidEntry?.present).toBe(false);
    expect(invalidEntry?.reason).toBe(LIQUIPEDIA_INVALID_LABEL_REASON);

    const sparg0Entry = resolved.find((entry) => entry.label === 'Sparg0');
    expect(sparg0Entry?.present).toBe(true);

    // The invalid label never appears in either request's `titles` param.
    for (const request of requests) {
      expect(request.searchParams.get('titles') ?? '').not.toContain('etc/passwd');
    }
  });
});
