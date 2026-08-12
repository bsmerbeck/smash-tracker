import { describe, expect, it } from 'vitest';
import {
  createLiquipediaFixtureFetch,
  loadLiquipediaFixture,
  loadLiquipediaFixtureText,
  matchQuery,
} from './loadFixture.js';
import { UnstubbedNetworkAccessError } from '../../test-support/failClosedFetch.js';

interface SupernovaBracketFixture {
  query: {
    pages: Array<{
      title: string;
      revisions: Array<{ revid: number; sha1: string }>;
    }>;
  };
}

describe('loadLiquipediaFixture', () => {
  it('returns the parsed object for a plain .json fixture', () => {
    const siteinfo = loadLiquipediaFixture<{ query: { general: { generator: string } } }>(
      'siteinfo',
    );
    expect(siteinfo.query.general.generator).toBe('MediaWiki 1.43.9');
  });

  it('the same call twice returns deeply equal data', () => {
    const first = loadLiquipediaFixture('siteinfo');
    const second = loadLiquipediaFixture('siteinfo');
    expect(first).toEqual(second);
  });

  it('transparently decompresses a .json.gz asset when no plain .json exists', () => {
    const parsed = loadLiquipediaFixture<{ parse: { title: string; revid: number } }>(
      'parse-sparg0-vods',
    );
    expect(parsed.parse.title).toBe('Sparg0/VODs');
    expect(parsed.parse.revid).toBe(347554);
  });

  it('throws an error naming the missing file for an unknown fixture name, never returns undefined', () => {
    expect(() => loadLiquipediaFixture('does-not-exist')).toThrowError(/does-not-exist/);
  });

  it('exposes the mandatory Supernova regression fixture with revid 535578 as its first revision', () => {
    const supernova = loadLiquipediaFixture<SupernovaBracketFixture>(
      'query-supernova-2026-singles-bracket',
    );
    const revision = supernova.query.pages[0]?.revisions[0];
    expect(revision?.revid).toBe(535578);
  });

  it('loadLiquipediaFixtureText returns raw text that JSON.parse accepts', () => {
    const text = loadLiquipediaFixtureText('query-allpages-izaw');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('createLiquipediaFixtureFetch', () => {
  it('resolves a request whose query string carries the registered discriminator, with a 200 JSON response deep-equal to the fixture', async () => {
    const fixture = loadLiquipediaFixture('siteinfo');
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'query', meta: 'siteinfo' }),
        fixture: 'siteinfo',
      },
    ]);

    const response = await fetchImpl(
      'https://liquipedia.net/smash/api.php?action=query&meta=siteinfo&siprop=general',
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(fixture);
  });

  it('rejects any request whose URL is not the constant Liquipedia API endpoint, naming the offending URL', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      { match: () => true, fixture: 'siteinfo' },
    ]);

    await expect(fetchImpl('https://example.com/not-liquipedia')).rejects.toThrow(
      /example\.com\/not-liquipedia/,
    );
  });

  it('rejects an unregistered request rather than returning an empty body', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'query', meta: 'siteinfo' }),
        fixture: 'siteinfo',
      },
    ]);

    await expect(
      fetchImpl('https://liquipedia.net/smash/api.php?action=parse&page=Nowhere'),
    ).rejects.toThrow(/no registered fixture route matches/);
  });

  it('records every request it served, in order, so a test can assert request counts and ordering', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([
      {
        match: matchQuery({ action: 'query', meta: 'siteinfo' }),
        fixture: 'siteinfo',
      },
      {
        match: matchQuery({ action: 'query', titles: 'IzAw' }),
        fixture: 'query-allpages-izaw',
      },
    ]);

    await fetchImpl('https://liquipedia.net/smash/api.php?action=query&meta=siteinfo');
    await fetchImpl('https://liquipedia.net/smash/api.php?action=query&titles=IzAw');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get('meta')).toBe('siteinfo');
    expect(requests[1]?.searchParams.get('titles')).toBe('IzAw');
  });

  it('honors an optional status and extra headers, so a later plan can drive a 429 through the same harness', async () => {
    const { fetchImpl } = createLiquipediaFixtureFetch([
      {
        match: () => true,
        fixture: 'siteinfo',
        status: 429,
        headers: { 'retry-after': '30' },
      },
    ]);

    const response = await fetchImpl('https://liquipedia.net/smash/api.php?action=query');

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });
});

describe('failClosedFetch (installed globally via vitest.setup.ts)', () => {
  it('a fetch to the REAL Liquipedia API endpoint rejects with UnstubbedNetworkAccessError naming the URL — exactly the case a static outbound-target scan would have permitted', async () => {
    await expect(
      globalThis.fetch('https://liquipedia.net/smash/api.php?action=query'),
    ).rejects.toBeInstanceOf(UnstubbedNetworkAccessError);
    await expect(
      globalThis.fetch('https://liquipedia.net/smash/api.php?action=query'),
    ).rejects.toThrow(/liquipedia\.net\/smash\/api\.php\?action=query/);
  });

  it('any unstubbed global fetch call rejects, never hangs and never returns a silent empty response', async () => {
    await expect(globalThis.fetch('https://example.com/anything')).rejects.toBeInstanceOf(
      UnstubbedNetworkAccessError,
    );
  });
});
