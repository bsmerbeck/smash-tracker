import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { loadLiquipediaFixture } from './__fixtures__/loadFixture.js';
import {
  LIQUIPEDIA_PAGE_CACHE_PATH,
  isLiquipediaPageFresh,
  readLiquipediaPageCache,
  writeLiquipediaPageCache,
  type LiquipediaPageCacheRecord,
} from './revisionCache.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

interface HeadRevisionsFixture {
  query: {
    pages: Array<{
      pageid: number;
      title: string;
      revisions: Array<{ revid: number; sha1: string }>;
    }>;
  };
}

const PARSER_VERSION = 'liquipedia-bracket-legacy@1';

function wikitextRecord(
  overrides: Partial<LiquipediaPageCacheRecord> = {},
): LiquipediaPageCacheRecord {
  return {
    pageId: '66550',
    title: 'Supernova/2026/Ultimate/Singles Bracket',
    pageClass: 'wikitext',
    parserVersion: PARSER_VERSION,
    fetchedAtMs: 1_767_225_600_000,
    revisionId: 535578,
    sha1: '54d1f9ba7e2fe97079448f3c04646ed5076fb1e3',
    ...overrides,
  };
}

function generatedRecord(
  overrides: Partial<LiquipediaPageCacheRecord> = {},
): LiquipediaPageCacheRecord {
  return {
    pageId: '51089',
    title: 'Sparg0/VODs',
    pageClass: 'generated',
    parserVersion: 'liquipedia-vodlist@1',
    fetchedAtMs: 1_767_225_600_000,
    revisionId: 347554,
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('isLiquipediaPageFresh — wikitext pages', () => {
  it('is fresh when the stored revision id, sha1, and parser version all match the probe, and the caller performs no content fetch', () => {
    const cached = wikitextRecord();
    const fresh = isLiquipediaPageFresh(
      cached,
      {
        pageClass: 'wikitext',
        revisionId: 535578,
        sha1: '54d1f9ba7e2fe97079448f3c04646ed5076fb1e3',
      },
      PARSER_VERSION,
    );
    expect(fresh).toBe(true);
  });

  it('is stale when sha1 differs while the revision id matches — sha1 is a second, independent equality check', () => {
    const cached = wikitextRecord();
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'wikitext', revisionId: 535578, sha1: 'DIFFERENT-SHA1' },
      PARSER_VERSION,
    );
    expect(fresh).toBe(false);
  });

  it('is stale when the stored parser version differs, even when revision id and sha1 match', () => {
    const cached = wikitextRecord();
    const fresh = isLiquipediaPageFresh(
      cached,
      {
        pageClass: 'wikitext',
        revisionId: 535578,
        sha1: '54d1f9ba7e2fe97079448f3c04646ed5076fb1e3',
      },
      'liquipedia-bracket-legacy@2',
    );
    expect(fresh).toBe(false);
  });

  it('drives the plan-02 query-headrevisions-batch.json fixture through isLiquipediaPageFresh and asserts the fresh result', () => {
    const fixture = loadLiquipediaFixture<HeadRevisionsFixture>('query-headrevisions-batch');
    const page = fixture.query.pages[0]!;
    const revision = page.revisions[0]!;

    const cached = wikitextRecord({
      pageId: String(page.pageid),
      title: page.title,
      revisionId: revision.revid,
      sha1: revision.sha1,
    });

    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'wikitext', revisionId: revision.revid, sha1: revision.sha1 },
      PARSER_VERSION,
    );
    expect(fresh).toBe(true);
  });
});

describe('isLiquipediaPageFresh — generated pages', () => {
  it('is fresh only when content hash AND parser version match; a matching revision id alone never makes it fresh', () => {
    const cached = generatedRecord();

    // Matching content hash and parser version, revisionId also equal.
    expect(
      isLiquipediaPageFresh(
        cached,
        { pageClass: 'generated', revisionId: 347554, contentHash: 'abc123' },
        'liquipedia-vodlist@1',
      ),
    ).toBe(true);

    // Matching revisionId ONLY — content hash differs — must be stale.
    expect(
      isLiquipediaPageFresh(
        cached,
        { pageClass: 'generated', revisionId: 347554, contentHash: 'DIFFERENT-HASH' },
        'liquipedia-vodlist@1',
      ),
    ).toBe(false);
  });

  it('a generated page with an equal revision id but a differing content hash is stale', () => {
    const cached = generatedRecord({ revisionId: 999, contentHash: 'stable-hash' });
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'generated', revisionId: 999, contentHash: 'a-new-hash' },
      cached.parserVersion,
    );
    expect(fresh).toBe(false);
  });

  it('is stale when the parser version differs, even when content hash matches', () => {
    const cached = generatedRecord();
    const fresh = isLiquipediaPageFresh(
      cached,
      { pageClass: 'generated', contentHash: 'abc123' },
      'liquipedia-vodlist@2',
    );
    expect(fresh).toBe(false);
  });
});

describe('readLiquipediaPageCache', () => {
  it('returns a first-class absent result (null), never a throw, for a page id that was never written', async () => {
    const database = new FakeDatabase();
    const result = await readLiquipediaPageCache(asDatabase(database), 'never-written');
    expect(result).toBeNull();
  });

  it('returns the absent result and writes nothing for an unsafe page-id key, rather than throwing at ref construction', async () => {
    const database = new FakeDatabase();
    const unsafeId = 'has/a/slash';

    const readResult = await readLiquipediaPageCache(asDatabase(database), unsafeId);
    expect(readResult).toBeNull();

    await writeLiquipediaPageCache(asDatabase(database), wikitextRecord({ pageId: unsafeId }));
    const dump = database.dump() as Record<string, unknown>;
    expect(dump[LIQUIPEDIA_PAGE_CACHE_PATH]).toBeUndefined();
  });
});

describe('writeLiquipediaPageCache / readLiquipediaPageCache round-trip', () => {
  it('a write followed by a read round-trips every stored member', async () => {
    const database = new FakeDatabase();
    const record = wikitextRecord({
      byteSize: 19364,
      observationCount: 8,
      lastFreshCheckAtMs: 1_767_225_601_000,
    });

    await writeLiquipediaPageCache(asDatabase(database), record);
    const readBack = await readLiquipediaPageCache(asDatabase(database), record.pageId);

    expect(readBack).toEqual(record);
  });

  it('absent optional members are absent on read rather than null', async () => {
    const database = new FakeDatabase();
    const record = generatedRecord({
      byteSize: undefined,
      observationCount: undefined,
      lastFreshCheckAtMs: undefined,
    });

    await writeLiquipediaPageCache(asDatabase(database), record);
    const readBack = await readLiquipediaPageCache(asDatabase(database), record.pageId);

    expect(readBack).not.toBeNull();
    expect(readBack!.byteSize).toBeUndefined();
    expect(readBack!.observationCount).toBeUndefined();
    expect(readBack!.lastFreshCheckAtMs).toBeUndefined();
    expect('byteSize' in readBack!).toBe(false);
  });

  it('stores under LIQUIPEDIA_PAGE_CACHE_PATH/{pageId}', async () => {
    const database = new FakeDatabase();
    const record = wikitextRecord();
    await writeLiquipediaPageCache(asDatabase(database), record);

    const snapshot = await database.ref(`${LIQUIPEDIA_PAGE_CACHE_PATH}/${record.pageId}`).get();
    expect(snapshot.exists()).toBe(true);
  });
});
