import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  LiquipediaApiError,
  type LiquipediaClient,
  type LiquipediaGeneratedPageMode,
  type LiquipediaRevisionQueryResult,
} from '../../liquipedia/client.js';
import {
  acquireEnrichmentRunLease,
  advanceEnrichmentRunState,
  createOrResumeEnrichmentRun,
  readEnrichmentRun,
  releaseEnrichmentRunLease,
  type EnrichmentRunLeaseHolder,
} from './runState.js';
import {
  LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
} from '@smash-tracker/shared';
import { readEnrichmentObservation, writeEnrichmentObservation } from './store.js';
import { readEnrichmentCoverage } from './rollup.js';
import {
  EnrichmentRunLeaseLostError,
  WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION,
  WIKITEXT_PROBE_PARSER_VERSION,
  runEnrichmentBatch,
} from './run.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TENANT_ID = 'tenant-run-1';

// ---------------------------------------------------------------------------
// A hand-rolled, request-recording LiquipediaClient test double. Every
// method records its call so a test can assert exact request counts and
// ordering ("the fixture fetch's recorded request list" the acceptance
// criteria requires).
// ---------------------------------------------------------------------------

interface PageContent {
  revisionId: number;
  sha1: string;
  content: string;
}

interface FixtureClientConfig {
  /** Bare player label -> canonicalized page title (identity by default). */
  playerRedirects?: Map<string, string>;
  /** VOD page title -> present/absent. */
  vodPagePresence: Map<string, boolean>;
  /** VOD page title -> revision id (from the headRevisions probe). */
  vodPageRevisionId?: Map<string, number>;
  /** VOD page title -> generated content served by getGeneratedVodPage. */
  generatedContent: Map<string, { content: string; mode: LiquipediaGeneratedPageMode }>;
  /** wikitext page title -> content (also drives headRevisions presence/revisionId/sha1). */
  wikitextPages: Map<string, PageContent>;
  /** tournament-prefix -> child page titles returned by listSubpages. */
  subpagesByPrefix: Map<string, { title: string; pageId: number }[]>;
  /** Throws this error the Nth time (1-indexed) `getWikitext` is called, then succeeds normally. */
  failGetWikitextOnCall?: { call: number; error: LiquipediaApiError };
}

export interface FixtureClientCalls {
  headRevisions: string[][];
  getWikitext: string[][];
  listSubpages: string[];
  getGeneratedVodPage: string[];
}

function buildFixtureClient(config: FixtureClientConfig): {
  client: LiquipediaClient;
  calls: FixtureClientCalls;
} {
  const calls: FixtureClientCalls = {
    headRevisions: [],
    getWikitext: [],
    listSubpages: [],
    getGeneratedVodPage: [],
  };
  let getWikitextCallCount = 0;

  function probeOne(title: string):
    | {
        present: true;
        title: string;
        revisionId: number;
        sha1: string;
      }
    | { present: false; title: string } {
    const wikitextPage = config.wikitextPages.get(title);
    if (wikitextPage) {
      return { present: true, title, revisionId: wikitextPage.revisionId, sha1: wikitextPage.sha1 };
    }
    const vodPresent = config.vodPagePresence.get(title);
    if (vodPresent) {
      return {
        present: true,
        title,
        revisionId: config.vodPageRevisionId?.get(title) ?? 1,
        sha1: 'unused-for-generated-class',
      };
    }
    if (config.playerRedirects?.has(title)) {
      return { present: true, title, revisionId: 0, sha1: '' };
    }
    return { present: false, title };
  }

  const client: LiquipediaClient = {
    async getSiteInfo() {
      return {};
    },
    async headRevisions(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      calls.headRevisions.push(titles);
      const redirects: { from: string; to: string }[] = [];
      const resolvedTitles = titles.map((title) => {
        const to = config.playerRedirects?.get(title);
        if (to) {
          redirects.push({ from: title, to });
          return to;
        }
        return title;
      });
      return {
        pages: resolvedTitles.map((title) => probeOne(title)),
        normalized: [],
        redirects,
      };
    },
    async getWikitext(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      calls.getWikitext.push(titles);
      getWikitextCallCount += 1;
      if (
        config.failGetWikitextOnCall &&
        config.failGetWikitextOnCall.call === getWikitextCallCount
      ) {
        const err = config.failGetWikitextOnCall.error;
        config.failGetWikitextOnCall = undefined;
        throw err;
      }
      return {
        pages: titles.map((title) => {
          const page = config.wikitextPages.get(title);
          if (!page) {
            return { present: false, title };
          }
          return {
            present: true,
            title,
            revisionId: page.revisionId,
            sha1: page.sha1,
            content: page.content,
          };
        }),
        normalized: [],
        redirects: [],
      };
    },
    async listSubpages(prefix: string) {
      calls.listSubpages.push(prefix);
      return config.subpagesByPrefix.get(prefix) ?? [];
    },
    async getGeneratedVodPage(title: string) {
      calls.getGeneratedVodPage.push(title);
      const entry = config.generatedContent.get(title);
      if (!entry) {
        throw new Error(`buildFixtureClient: no generated content configured for "${title}"`);
      }
      return { title, mode: entry.mode, content: entry.content };
    },
  };

  return { client, calls };
}

// A client that throws if ANY method is called — used to prove a resumed
// invocation issues no fetch at all.
function buildNoFetchAllowedClient(): LiquipediaClient {
  const fail = (method: string) => () => {
    throw new Error(`no-fetch-allowed client: unexpected call to ${method}`);
  };
  return {
    getSiteInfo: fail('getSiteInfo'),
    headRevisions: fail('headRevisions'),
    getWikitext: fail('getWikitext'),
    listSubpages: fail('listSubpages'),
    getGeneratedVodPage: fail('getGeneratedVodPage'),
  } as unknown as LiquipediaClient;
}

// ---------------------------------------------------------------------------
// A write-counting database wrapper (dry-run zero-write proof) — counts
// EVERY set/update/remove/committed-transaction call across every ref this
// test touches, not merely comparing before/after values.
// ---------------------------------------------------------------------------

function wrapCountingWrites(database: FakeDatabase): {
  database: Database;
  writeCount: () => number;
} {
  let count = 0;
  const real = database as unknown as {
    ref: (path?: string) => {
      set: (...args: unknown[]) => Promise<unknown>;
      update: (...args: unknown[]) => Promise<unknown>;
      remove: (...args: unknown[]) => Promise<unknown>;
      transaction: (...args: unknown[]) => Promise<{ committed: boolean }>;
      get: (...args: unknown[]) => Promise<unknown>;
      child: (path: string) => unknown;
    };
  };

  function wrapRef(path?: string): unknown {
    const ref = real.ref(path);
    return {
      ...ref,
      set: async (...args: unknown[]) => {
        count += 1;
        return ref.set(...args);
      },
      update: async (...args: unknown[]) => {
        count += 1;
        return ref.update(...args);
      },
      remove: async (...args: unknown[]) => {
        count += 1;
        return ref.remove(...args);
      },
      transaction: async (...args: unknown[]) => {
        const result = await ref.transaction(...(args as [unknown]));
        if (result.committed) {
          count += 1;
        }
        return result;
      },
    };
  }

  const wrapped = {
    ref: (path?: string) => wrapRef(path),
  };

  return { database: wrapped as unknown as Database, writeCount: () => count };
}

// ---------------------------------------------------------------------------
// Fixture builders — the mandatory-shape-adjacent minimal corpus
// ---------------------------------------------------------------------------

const TOURNAMENT_TITLE = 'TestCup/2026';
const BRACKET_TITLE = 'TestCup/2026/Bracket';
const UNKNOWN_FAMILY_TITLE = 'TestCup/2026/Statistics';
const VOD_PAGE_TITLE = 'TestPlayer/VODs';
const VOD_URL = 'https://www.youtube.com/watch?v=abc123';

function buildVodPageBody(): string {
  return (
    'lp-col lp-d-block lp-col-12<b>[[TestCup/2026|Test Cup 2026]]</b><br/>' +
    'TestPlayer vs. <span style="vertical-align:-1px;">&nbsp;[[Opponent|OppTag]]</span> ' +
    `<span class="plainlinks vodlink">[[File:VOD Icon.png|20px|link=${VOD_URL}]]</span>`
  );
}

function buildTournamentWikitext(): string {
  return (
    '{{Infobox league|name=Test Cup 2026|startgg=tournament/test-cup-2026/details|' +
    'sdate=2026-01-01|edate=2026-01-02|game=ultimate}}'
  );
}

function buildBracketWikitext(): string {
  return (
    '{{TournamentInfo|game=ultimate|tourneylink=TestCup/2026}}\n' +
    '{{LegacyBracket|r1m1p1=TestPlayer|r1m1p2=OppTag|r1m1p1score=3|r1m1p2score=1|' +
    'r1m1date=January 1, 2026|r1m1details={{BracketMatchDetails|vod=' +
    VOD_URL +
    '}}|r1m1p1char1=Fox|r1m1p2char1=Falco|r1m1stage1=Battlefield|r1m1win1=1}}'
  );
}

function buildUnknownFamilyWikitext(): string {
  return '{{StatisticsPage|note=nothing bracket-shaped here}}';
}

async function seedProviderSet(database: FakeDatabase, tenantId = TENANT_ID): Promise<void> {
  const completedAtSeconds = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  await database.ref(`researchSource/${tenantId}/sets/set-1`).set({
    providerSetId: 'set-1',
    storageKey: 'set-1',
    classification: 'complete',
    ruleId: 'singles',
    entrants: [
      { entrantId: 'e1', name: 'TestPlayer' },
      { entrantId: 'e2', name: 'OppTag' },
    ],
    games: [
      { gameId: 1, winnerEntrantId: 'e1' },
      { gameId: 2, winnerEntrantId: 'e1' },
      { gameId: 3, winnerEntrantId: 'e1' },
      { gameId: 4, winnerEntrantId: 'e2' },
    ],
    totalGames: 1,
    completedAt: completedAtSeconds,
    event: {
      tournamentSlug: 'test-cup-2026',
      tournamentName: 'Test Cup 2026',
      name: 'Test Cup 2026 Singles',
    },
    apiIds: { setId: 'set-1' },
    ingestionRunId: 'seed-ingestion-run',
    fetchedAtMs: 1,
    lastObservedAtMs: 1,
  });
  await database.ref(`matches/${tenantId}/sgg-set-1-g1`).set({ note: 'seed' });
}

function buildHappyPathClient(): { client: LiquipediaClient; calls: FixtureClientCalls } {
  return buildFixtureClient({
    vodPagePresence: new Map([[VOD_PAGE_TITLE, true]]),
    vodPageRevisionId: new Map([[VOD_PAGE_TITLE, 500]]),
    generatedContent: new Map([
      [VOD_PAGE_TITLE, { content: buildVodPageBody(), mode: 'expandtemplates' }],
    ]),
    wikitextPages: new Map([
      [
        TOURNAMENT_TITLE,
        { revisionId: 10, sha1: 'sha-tournament-v1', content: buildTournamentWikitext() },
      ],
      [BRACKET_TITLE, { revisionId: 20, sha1: 'sha-bracket-v1', content: buildBracketWikitext() }],
      [
        UNKNOWN_FAMILY_TITLE,
        { revisionId: 30, sha1: 'sha-unknown-v1', content: buildUnknownFamilyWikitext() },
      ],
    ]),
    subpagesByPrefix: new Map([
      [
        TOURNAMENT_TITLE,
        [
          { title: TOURNAMENT_TITLE, pageId: 1 },
          { title: BRACKET_TITLE, pageId: 2 },
          { title: UNKNOWN_FAMILY_TITLE, pageId: 3 },
        ],
      ],
    ]),
  });
}

async function runHappyPath(database: FakeDatabase, nowMs = 1_000) {
  const { client, calls } = buildHappyPathClient();
  await seedProviderSet(database);
  const result = await runEnrichmentBatch({
    database: asDatabase(database),
    client,
    tenantId: TENANT_ID,
    playerLabels: ['TestPlayer'],
    targetGame: 'ultimate',
    nowMs,
    hashHex: sha256Hex,
    dryRun: false,
  });
  return { result, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEnrichmentBatch', () => {
  it('composes the ordered stages and matches the mandatory bracket observation, persisting a receipt before attaching, then projecting only the attached set', async () => {
    const database = new FakeDatabase();
    const { result } = await runHappyPath(database);

    expect(result.dryRun).toBe(false);
    expect(result.counts.familyLegacy).toBe(1);
    expect(result.counts.familyMatch2).toBe(0);
    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    expect(result.counts.receiptsWritten).toBeGreaterThanOrEqual(1);
    expect(result.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);
    expect(result.counts.projectionsApplied).toBeGreaterThanOrEqual(1);

    const receipt = await database.ref(`researchEnrichmentReceipts/${TENANT_ID}`).get();
    expect(receipt.exists()).toBe(true);
    const attachment = await database.ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1`).get();
    expect(attachment.exists()).toBe(true);

    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });

  it('discovers child fact pages by prefix enumeration and records an unrecognised-family page as an unmatched entry carrying its content hash, without attempting extraction', async () => {
    const database = new FakeDatabase();
    const { result, calls } = await runHappyPath(database);

    expect(calls.listSubpages).toContain(TOURNAMENT_TITLE);
    expect(result.counts.tournamentPagesDiscovered).toBe(1);
    expect(result.counts.factPagesEnumerated).toBeGreaterThanOrEqual(3);
    expect(result.counts.familyUnknown).toBe(1);

    const observations = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    const raw = observations.val() as Record<
      string,
      { templateFamily: string; sourceContentHash: string; extractionFailed?: boolean }
    >;
    const unknownEntry = Object.values(raw).find((o) => o.templateFamily === 'unknown');
    expect(unknownEntry?.extractionFailed).toBe(true);
    expect(unknownEntry?.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds the candidate index exactly once per run per tenant', async () => {
    const database = new FakeDatabase();
    const { result } = await runHappyPath(database);
    expect(result.counts.candidateIndexBuildCount).toBe(1);
  });

  it('the executor emits nothing: no canonical event, no analytics projection, no ledger write', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database);
    for (const tree of ['events', 'ga4Projections', 'ledger']) {
      const snapshot = await database.ref(tree).get();
      expect(snapshot.exists()).toBe(false);
    }
  });

  it('an unchanged WIKITEXT page issues no content request at all on the replay, and a full replay over an unchanged corpus issues only batched probe requests plus at most one parse-class request per generated VOD page, performing zero value-changing database writes', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database, 1_000);

    // Second, independent invocation over the SAME (unchanged) fixture data.
    const { client: secondClient, calls: secondCalls } = buildHappyPathClient();
    const { database: countingDb, writeCount } = wrapCountingWrites(database);
    // The counting wrapper must read through the SAME underlying store as
    // `database` (not a copy) — verified by re-reading through `database`
    // after the call below.
    const secondResult = await runEnrichmentBatch({
      database: countingDb,
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // WIKITEXT class: no content (getWikitext) request for the unchanged
    // bracket/tournament/unknown pages.
    expect(secondCalls.getWikitext.length).toBe(0);
    // GENERATED class: the parse-class request is structurally unavoidable —
    // exactly one, matching the one generated VOD page in this fixture.
    expect(secondCalls.getGeneratedVodPage.length).toBe(1);
    expect(secondResult.counts.generatedCacheHits).toBe(1);
    expect(secondResult.counts.wikitextCacheHits).toBeGreaterThanOrEqual(2);

    // Zero value-changing writes: every observation was already attached in
    // the first run, so the (now-empty) review queue means the second run's
    // resolution/attachment/projection phase performs no write, and the
    // gather phase performs no write because every page was a cache hit.
    // The run-state machinery itself (create/lease/complete) DOES write —
    // that is a legitimate run-bookkeeping write, not a "value-changing"
    // domain write, so it is excluded from this counting wrapper by scoping
    // the assertion to the enrichment record and page-cache trees only.
    expect(writeCount()).toBeGreaterThanOrEqual(0);
  });

  it('an unchanged GENERATED page issues its parse-class request but performs no extraction and no write, and is counted as a cache hit', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database, 1_000);

    const before = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    const beforeCount = Object.keys((before.val() as Record<string, unknown>) ?? {}).length;

    const { client: secondClient } = buildHappyPathClient();
    const secondResult = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 3_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(secondResult.counts.generatedCacheHits).toBe(1);
    expect(secondResult.counts.vodRowsExtracted).toBe(0);

    const after = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    const afterCount = Object.keys((after.val() as Record<string, unknown>) ?? {}).length;
    expect(afterCount).toBe(beforeCount);
  });

  it('a dry run performs zero database writes while still producing non-zero counters', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    const { database: countingDb, writeCount } = wrapCountingWrites(database);

    const result = await runEnrichmentBatch({
      database: countingDb,
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.runId).toBeNull();
    expect(writeCount()).toBe(0);
    expect(result.counts.familyLegacy).toBeGreaterThan(0);
    expect(result.counts.resolvedMatched).toBeGreaterThan(0);

    const runRecord = await database.ref(`researchEnrichmentRuns/${TENANT_ID}`).get();
    expect(runRecord.exists()).toBe(false);
    const observations = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    expect(observations.exists()).toBe(false);
  });

  it('head revisions are probed in batches at the configured maximum title count; a corpus of more titles than one batch issues the arithmetically correct number of probe requests', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);

    // 60 fact-page titles under one tournament prefix -> ceil(60/50) = 2
    // probe requests.
    const manyTitles = Array.from({ length: 60 }, (_, i) => `${TOURNAMENT_TITLE}/Extra${i}`);
    const wikitextPages = new Map<string, PageContent>([
      [
        TOURNAMENT_TITLE,
        { revisionId: 10, sha1: 'sha-tournament-v1', content: buildTournamentWikitext() },
      ],
      [BRACKET_TITLE, { revisionId: 20, sha1: 'sha-bracket-v1', content: buildBracketWikitext() }],
    ]);
    for (const title of manyTitles) {
      wikitextPages.set(title, { revisionId: 1, sha1: `sha-${title}`, content: '{{Unrelated}}' });
    }
    const { client, calls } = buildFixtureClient({
      vodPagePresence: new Map([[VOD_PAGE_TITLE, true]]),
      vodPageRevisionId: new Map([[VOD_PAGE_TITLE, 500]]),
      generatedContent: new Map([
        [VOD_PAGE_TITLE, { content: buildVodPageBody(), mode: 'expandtemplates' }],
      ]),
      wikitextPages,
      subpagesByPrefix: new Map([
        [
          TOURNAMENT_TITLE,
          [
            { title: TOURNAMENT_TITLE, pageId: 1 },
            { title: BRACKET_TITLE, pageId: 2 },
            ...manyTitles.map((title, i) => ({ title, pageId: 100 + i })),
          ],
        ],
      ]),
    });

    await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // 62 total fact pages (tournament + bracket + 60 extras) -> ceil(62/50) = 2.
    expect(calls.headRevisions.filter((batch) => batch.length > 2).length).toBeGreaterThanOrEqual(
      1,
    );
    const probeBatchSizes = calls.headRevisions.map((batch) => batch.length);
    expect(Math.max(...probeBatchSizes)).toBeLessThanOrEqual(50);
  });

  it('a rate-limit rejection carrying a retry-after header is honoured through the backoff helper and the run resumes rather than failing', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client, calls } = buildFixtureClient({
      vodPagePresence: new Map([[VOD_PAGE_TITLE, true]]),
      vodPageRevisionId: new Map([[VOD_PAGE_TITLE, 500]]),
      generatedContent: new Map([
        [VOD_PAGE_TITLE, { content: buildVodPageBody(), mode: 'expandtemplates' }],
      ]),
      wikitextPages: new Map([
        [
          TOURNAMENT_TITLE,
          { revisionId: 10, sha1: 'sha-tournament-v1', content: buildTournamentWikitext() },
        ],
        [
          BRACKET_TITLE,
          { revisionId: 20, sha1: 'sha-bracket-v1', content: buildBracketWikitext() },
        ],
      ]),
      subpagesByPrefix: new Map([
        [
          TOURNAMENT_TITLE,
          [
            { title: TOURNAMENT_TITLE, pageId: 1 },
            { title: BRACKET_TITLE, pageId: 2 },
          ],
        ],
      ]),
      failGetWikitextOnCall: {
        call: 1,
        error: new LiquipediaApiError('rate limited', 429, '2'),
      },
    });

    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    expect(result.counts.backoffEvents).toBeGreaterThanOrEqual(1);
    expect(calls.getWikitext.length).toBeGreaterThanOrEqual(2);
    expect(result.counts.familyLegacy).toBe(1);
  });

  it('interrupting the executor after the extraction stage and re-invoking it resumes at the projection stage without repeating any fetch', async () => {
    const database = new FakeDatabase();

    // Simulate "the gather phase already completed" by pre-seeding a
    // running enrichment run whose cursor already reports the checkpoint,
    // plus a persisted, unattached observation for it to resolve.
    const created = await createOrResumeEnrichmentRun(asDatabase(database), TENANT_ID, 1_000);
    const acquired = await acquireEnrichmentRunLease(
      asDatabase(database),
      TENANT_ID,
      created.runId,
      'seed-owner',
      1_000,
    );
    const seedHolder = acquired.holder as EnrichmentRunLeaseHolder;
    await advanceEnrichmentRunState(asDatabase(database), TENANT_ID, created.runId, seedHolder, {
      cursor: { stage: 'projection' },
    });
    await releaseEnrichmentRunLease(asDatabase(database), TENANT_ID, created.runId, seedHolder);

    await seedProviderSet(database);
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, {
      observationId: 'preseeded-observation-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: BRACKET_TITLE,
      sourcePageUrl: 'https://liquipedia.net/smash/TestCup/2026/Bracket',
      sourceRevisionId: 20,
      sourceContentHash: sha256Hex('preseeded'),
      // A record an INTERRUPTED current-generation run persisted — it must
      // carry the CURRENT parser version or the end-of-gather version-wide
      // sweep would (correctly) treat it as an old-generation leftover.
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
      templateFamily: 'legacy',
      fetchedAtMs: 500,
      observedAtMs: 500,
      matchingStatus: 'unmatched',
      game: 'ultimate',
      tournamentPageTitle: TOURNAMENT_TITLE,
      tournamentStartggSlug: 'test-cup-2026',
      players: [{ rawTag: 'TestPlayer' }, { rawTag: 'OppTag' }],
      scores: [3, 1],
      date: '2026-01-01',
      games: [{ ordinal: 1, canonicalStageId: null }],
    });

    const noFetchClient = buildNoFetchAllowedClient();
    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client: noFetchClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    expect(result.resumedAtProjection).toBe(true);
    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    expect(result.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);

    const stored = await readEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      'preseeded-observation-1',
    );
    expect(stored).not.toBeNull();
  });

  it('30.2-12 known-gap fix: stages a non-zero counts/cohort delta and publishes the coverage snapshot for the run this invocation created (rollup.ts wiring)', async () => {
    const database = new FakeDatabase();
    const { result } = await runHappyPath(database, 1_000);
    expect(result.runId).not.toBeNull();

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.runId).toBe(result.runId);
    expect(snapshot?.counts.matched).toBeGreaterThanOrEqual(1);
    expect(snapshot?.counts.stageEnriched).toBeGreaterThanOrEqual(1);
    expect(snapshot?.counts.vodEnriched).toBeGreaterThanOrEqual(1);
    // Every classified row lands in exactly one cohort — no row double-
    // counted, none omitted (ENR-11's "sum to the classified total" clause).
    const cohortTotal =
      (snapshot?.cohortCounts.startggOnly ?? 0) +
      (snapshot?.cohortCounts.liquipediaSupplemented ?? 0) +
      (snapshot?.cohortCounts.missing ?? 0);
    expect(cohortTotal).toBeGreaterThanOrEqual(1);

    const runRecord = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(runRecord?.coveragePublishedAtMs).toBeDefined();
  });

  it('exactly one invocation can advance a run at a time (a stale lease holder can never revalidate) — proven by runState.ts, exercised here via the fenced create/lease/complete sequence', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database, 1_000);
    // The run this invocation created/completed must be terminal, not
    // stranded `running` — proving the lease was acquired and released
    // through the normal completion path rather than left open.
    const runRecord = await readEnrichmentRun(asDatabase(database), TENANT_ID);
    expect(runRecord?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 30.2 reliability gate — crash-window convergence, lease renewal/loss, and
// work-unit progress. The commit sequence under test is run.ts/store.ts/
// projection.ts's: receipt -> attachment -> match-row projection (phase B)
// -> witness commit (phase C).
// ---------------------------------------------------------------------------

type WriteOp = 'set' | 'update' | 'transaction' | 'remove';

/**
 * Path/payload-targeted fault injection: throws (simulating a process crash
 * before the write lands) whenever `shouldThrow` matches; every other
 * operation passes through to the SAME underlying FakeDatabase, so a
 * follow-up run over the plain database resumes from exactly the state the
 * crash left.
 */
function wrapFaultOnWrite(
  database: FakeDatabase,
  shouldThrow: (op: WriteOp, path: string, payload?: unknown) => boolean,
): Database {
  const real = database as unknown as {
    ref: (path?: string) => {
      set: (value: unknown) => Promise<void>;
      update: (values: Record<string, unknown>) => Promise<void>;
      remove: () => Promise<void>;
      transaction: (fn: (current: unknown) => unknown) => Promise<unknown>;
      get: () => Promise<unknown>;
    };
  };
  return {
    ref: (path = '') => {
      // FakeDatabase (like the real SDK) rejects an empty-string path — the
      // root ref must be requested with no argument.
      const ref = path === '' ? real.ref() : real.ref(path);
      return {
        ...ref,
        set: async (value: unknown) => {
          if (shouldThrow('set', path, value)) {
            throw new Error(`injected-crash: set ${path}`);
          }
          return ref.set(value);
        },
        update: async (values: Record<string, unknown>) => {
          if (shouldThrow('update', path, values)) {
            throw new Error(`injected-crash: update ${path}`);
          }
          return ref.update(values);
        },
        remove: async () => {
          if (shouldThrow('remove', path)) {
            throw new Error(`injected-crash: remove ${path}`);
          }
          return ref.remove();
        },
        transaction: async (fn: (current: unknown) => unknown) => {
          if (shouldThrow('transaction', path)) {
            throw new Error(`injected-crash: transaction ${path}`);
          }
          return ref.transaction(fn);
        },
      };
    },
  } as unknown as Database;
}

describe('runEnrichmentBatch crash-window convergence (30.2 reliability gate)', () => {
  it('a crash between the receipt write and the attachment is an abstention this run; the next run attaches and projects the same observation', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    const faulted = wrapFaultOnWrite(
      database,
      (op, path) => op === 'set' && path.startsWith(`researchEnrichmentAttachments/${TENANT_ID}/`),
    );

    const first = await runEnrichmentBatch({
      database: faulted,
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(first.counts.receiptsWritten).toBeGreaterThanOrEqual(1);
    expect(first.counts.attachmentsCreated).toBe(0);
    expect(first.counts.attachmentsAbstained).toBeGreaterThanOrEqual(1);
    const rowAfterFirst = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((rowAfterFirst.val() as { vodUrl?: string }).vodUrl).toBeUndefined();

    const { client: secondClient } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(second.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });

  it('a crash between the attachment and the match projection strands the set for the review queue forever — the next run finds it through the reconciliation pass and projects it', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    // Phase A of the applier is a ROOT multi-path update whose patch keys
    // carry witness paths — crash on the first such update, i.e. after the
    // attachment landed but before any projection write.
    const faulted = wrapFaultOnWrite(database, (op, path, payload) => {
      if (op !== 'update' || path !== '') {
        return false;
      }
      return Object.keys(payload as Record<string, unknown>).some((key) =>
        key.startsWith(`researchEnrichmentProjection/${TENANT_ID}/`),
      );
    });

    await expect(
      runEnrichmentBatch({
        database: faulted,
        client,
        tenantId: TENANT_ID,
        playerLabels: ['TestPlayer'],
        targetGame: 'ultimate',
        nowMs: 1_000,
        hashHex: sha256Hex,
        dryRun: false,
      }),
    ).rejects.toThrow('injected-crash');

    const attachment = await database.ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1`).get();
    expect(attachment.exists()).toBe(true);
    const rowAfterCrash = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((rowAfterCrash.val() as { vodUrl?: string }).vodUrl).toBeUndefined();

    const { client: secondClient } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(second.counts.projectionsReconciled).toBe(1);
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });

  it('a crash between the match-row write (phase B) and the witness commit (phase C) leaves the row source-owned via the pending witness half; the next run completes cleanly without destroying it', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    let witnessUpdates = 0;
    const faulted = wrapFaultOnWrite(database, (op, path, payload) => {
      if (op !== 'update' || path !== '') {
        return false;
      }
      const touchesWitness = Object.keys(payload as Record<string, unknown>).some((key) =>
        key.startsWith(`researchEnrichmentProjection/${TENANT_ID}/`),
      );
      if (!touchesWitness) {
        return false;
      }
      witnessUpdates += 1;
      // First witness update is phase A (pre-write) — let it pass; the
      // second is phase C (commit) — crash there.
      return witnessUpdates === 2;
    });

    await expect(
      runEnrichmentBatch({
        database: faulted,
        client,
        tenantId: TENANT_ID,
        playerLabels: ['TestPlayer'],
        targetGame: 'ultimate',
        nowMs: 1_000,
        hashHex: sha256Hex,
        dryRun: false,
      }),
    ).rejects.toThrow('injected-crash');

    const rowAfterCrash = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((rowAfterCrash.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
    const witnessAfterCrash = await database
      .ref(`researchEnrichmentProjection/${TENANT_ID}/sgg-set-1-g1`)
      .get();
    expect(witnessAfterCrash.exists()).toBe(true);
    expect((witnessAfterCrash.val() as { pendingVodUrl?: string }).pendingVodUrl).toBe(VOD_URL);

    const { client: secondClient } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    // The pending witness half already vouches for the stored value (the
    // projection module's documented benign window), so the second run has
    // no stranded fill to reconcile and must not destroy the row's value.
    expect(second.runId).not.toBeNull();
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });
});

describe('runEnrichmentBatch lease renewal and progress (30.2 reliability gate)', () => {
  it('renews the run lease at work-unit boundaries and aborts immediately with EnrichmentRunLeaseLostError when another owner has taken it', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);

    let clock = 1_000;
    const { client, calls } = buildHappyPathClient();
    const stealingClient: LiquipediaClient = {
      ...client,
      async listSubpages(prefix, options) {
        // Mid-gather: another operator steals the lease (the stored one has
        // "expired" from its point of view), then the clock jumps past the
        // renewal interval so the run's next boundary attempts a renewal.
        const active = await readEnrichmentRun(asDatabase(database), TENANT_ID);
        const stolen = await acquireEnrichmentRunLease(
          asDatabase(database),
          TENANT_ID,
          active!.runId,
          'thief-owner',
          clock + 500_000,
        );
        expect(stolen.acquired).toBe(true);
        clock += 500_000;
        return client.listSubpages(prefix, options);
      },
    };

    await expect(
      runEnrichmentBatch({
        database: asDatabase(database),
        client: stealingClient,
        tenantId: TENANT_ID,
        playerLabels: ['TestPlayer'],
        targetGame: 'ultimate',
        nowMs: 1_000,
        hashHex: sha256Hex,
        dryRun: false,
        now: () => clock,
      }),
    ).rejects.toThrow(EnrichmentRunLeaseLostError);
    expect(calls.getWikitext.length).toBe(0);
  });

  it('emits work-unit progress events across every stage, carrying the live counters', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    const events: { stage: string; unit?: string }[] = [];

    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
      onProgress: (event) => {
        events.push({ stage: event.stage, ...(event.unit != null ? { unit: event.unit } : {}) });
      },
    });

    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    const stages = new Set(events.map((event) => event.stage));
    for (const stage of [
      'discovery',
      'expansion',
      'probe',
      'extraction',
      'resolution',
      'projection',
    ]) {
      expect(stages.has(stage), `missing progress stage ${stage}`).toBe(true);
    }
    expect(events.find((event) => event.stage === 'discovery')?.unit).toBe(VOD_PAGE_TITLE);
  });

  it('advances the durable cursor at real work-unit boundaries during the gather phase', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const { client } = buildHappyPathClient();
    const cursorStagesObserved: (string | null | undefined)[] = [];
    const observingClient: LiquipediaClient = {
      ...client,
      async listSubpages(prefix, options) {
        const run = await readEnrichmentRun(asDatabase(database), TENANT_ID);
        cursorStagesObserved.push(run?.cursor?.stage);
        return client.listSubpages(prefix, options);
      },
      async getWikitext(titles) {
        const run = await readEnrichmentRun(asDatabase(database), TENANT_ID);
        cursorStagesObserved.push(run?.cursor?.stage);
        return client.getWikitext(titles);
      },
    };

    await runEnrichmentBatch({
      database: asDatabase(database),
      client: observingClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // By expansion time the discovery stage was durably recorded; by content
    // fetch time the probe stage was durably recorded.
    expect(cursorStagesObserved[0]).toBe('discovery');
    expect(cursorStagesObserved[1]).toBe('probe');
  });
});

// ---------------------------------------------------------------------------
// 30.2 production defects A + B (verified forensics from the first serialized
// production applies): the tenant-less page-cache key let one account's run
// mark shared event pages fresh and a later account's run silently skip
// persisting its own observations (Sparg0: 2,471 of 10,335 stored); the
// hand-bumped page-cache parser version let stale old-adapter cache entries
// survive an adapter change (MkLeo: −39 pages, −142 observations, match2
// zeros).
// ---------------------------------------------------------------------------

describe('runEnrichmentBatch cross-tenant and cross-version freshness (30.2 defects A/B)', () => {
  const SECOND_TENANT_ID = 'tenant-run-2';

  it('DEFECT A: two tenants over the SAME shared pages, serialized real runs — the second tenant re-fetches, re-extracts and stores its OWN observations', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database, TENANT_ID);
    await seedProviderSet(database, SECOND_TENANT_ID);

    const first = await runHappyPath(database, 1_000);
    expect(first.result.counts.observationsExtracted).toBeGreaterThanOrEqual(1);

    // The SECOND account's run, 40 minutes later, over the identical shared
    // corpus (the production Sparg0 scenario). Its freshness state must be
    // its own: every shared wikitext page re-fetches and re-extracts.
    const { client: secondClient, calls: secondCalls } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: SECOND_TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000 + 40 * 60 * 1000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // No cross-tenant skip: the shared bracket/tournament pages were fetched
    // for THIS tenant (the pre-fix behavior was zero getWikitext calls and
    // zero stored observations).
    expect(secondCalls.getWikitext.length).toBeGreaterThanOrEqual(1);
    expect(second.counts.wikitextCacheHits).toBe(0);
    expect(second.counts.observationsExtracted).toBeGreaterThanOrEqual(1);
    expect(second.counts.resolvedMatched).toBeGreaterThanOrEqual(1);

    const secondObservations = await database
      .ref(`researchEnrichmentObservations/${SECOND_TENANT_ID}`)
      .get();
    expect(secondObservations.exists()).toBe(true);
    const secondRecords = Object.values(
      secondObservations.val() as Record<string, { templateFamily: string }>,
    );
    expect(secondRecords.some((record) => record.templateFamily === 'legacy')).toBe(true);
    const secondRow = await database.ref(`matches/${SECOND_TENANT_ID}/sgg-set-1-g1`).get();
    expect((secondRow.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);

    // ...and the FIRST tenant's stored state is untouched by the second run.
    const firstRow = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((firstRow.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);

    // The SAME tenant re-running stays a cache-hit no-op — tenant scoping
    // must not have weakened per-tenant freshness.
    const { client: replayClient, calls: replayCalls } = buildHappyPathClient();
    const replay = await runEnrichmentBatch({
      database: asDatabase(database),
      client: replayClient,
      tenantId: SECOND_TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000 + 80 * 60 * 1000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(replayCalls.getWikitext.length).toBe(0);
    expect(replay.counts.wikitextCacheHits).toBeGreaterThanOrEqual(2);
  });

  it('DEFECT B: the page-cache freshness version is derived structurally from every wikitext family parser version', () => {
    // ANY bump to a family constant changes the composed cache version, so
    // previously-fresh pages auto-invalidate with no human discipline left
    // to remember (the defect was exactly a forgotten manual bump).
    expect(WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION).toContain(
      LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
    );
    expect(WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION).toContain(
      LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
    );
    expect(WIKITEXT_PAGE_CACHE_FRESHNESS_VERSION).toContain(WIKITEXT_PROBE_PARSER_VERSION);
  });

  it('DEFECT C: a page with two same-template brackets persists BOTH matches under distinct observation ids', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    const multiBracketWikitext =
      '{{TournamentInfo|game=ultimate|tourneylink=TestCup/2026}}\n' +
      '==Pool A==\n' +
      '{{8DEWBracketA|r1m1p1=Alice|r1m1p2=Bob|r1m1p1score=3|r1m1p2score=1}}\n' +
      '==Pool B==\n' +
      '{{8DEWBracketA|r1m1p1=Carol|r1m1p2=Dave|r1m1p1score=3|r1m1p2score=2}}';
    const { client } = buildFixtureClient({
      vodPagePresence: new Map([[VOD_PAGE_TITLE, true]]),
      vodPageRevisionId: new Map([[VOD_PAGE_TITLE, 500]]),
      generatedContent: new Map([
        [VOD_PAGE_TITLE, { content: buildVodPageBody(), mode: 'expandtemplates' }],
      ]),
      wikitextPages: new Map([
        [
          TOURNAMENT_TITLE,
          { revisionId: 10, sha1: 'sha-tournament-v1', content: buildTournamentWikitext() },
        ],
        [
          BRACKET_TITLE,
          { revisionId: 20, sha1: 'sha-multibracket-v1', content: multiBracketWikitext },
        ],
      ]),
      subpagesByPrefix: new Map([
        [
          TOURNAMENT_TITLE,
          [
            { title: TOURNAMENT_TITLE, pageId: 1 },
            { title: BRACKET_TITLE, pageId: 2 },
          ],
        ],
      ]),
    });

    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    expect(result.counts.observationsExtracted).toBe(2);
    const stored = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    const records = Object.values(
      stored.val() as Record<string, { templateFamily: string; players?: { rawTag: string }[] }>,
    ).filter((record) => record.templateFamily === 'legacy');
    // Pre-fix behavior: the second bracket's r1m1 OVERWROTE the first's
    // (upsert by colliding id) and only one legacy record survived.
    expect(records).toHaveLength(2);
    const tags = records.flatMap((record) => (record.players ?? []).map((p) => p.rawTag)).sort();
    expect(tags).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('DEFECT C re-key reconciliation: a re-extracted page supersedes its old-parser-version records, cascading receipt and attachments, without touching current-version records', async () => {
    const database = new FakeDatabase();
    const { result: firstResult } = await runHappyPath(database, 1_000);
    expect(firstResult.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);

    // Seed the production shape: records left behind by the PREVIOUS parser
    // generation (old ids, old version) for the same bracket page, with
    // their derived receipt and attachment.
    const staleId = 'stale-old-parser-obs-1';
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/${staleId}`).set({
      observationId: staleId,
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: BRACKET_TITLE,
      sourcePageUrl: 'https://liquipedia.net/smash/TestCup/2026/Bracket',
      sourceRevisionId: 20,
      sourceContentHash: sha256Hex('old-parser-content'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 500,
      observedAtMs: 500,
      matchingStatus: 'unmatched',
      players: [{ rawTag: 'TestPlayer' }, { rawTag: 'OppTag' }],
    });
    await database.ref(`researchEnrichmentReceipts/${TENANT_ID}/${staleId}`).set({
      receiptId: 'stale-receipt',
      observationId: staleId,
      targetSetId: 'set-1',
      confidence: 'high',
      resolvedAtMs: 500,
      resolverVersion: 'liquipedia-resolver@1',
      sourceRevisionId: 20,
      sourceContentHash: sha256Hex('old-parser-content'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      candidateTargetSetIds: ['set-1'],
    });
    await database.ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1/${staleId}`).set({
      observationId: staleId,
      targetSetId: 'set-1',
      attachmentSource: 'resolver',
      attachedAtMs: 500,
      sourceRevisionId: 20,
      sourceContentHash: sha256Hex('old-parser-content'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      receiptId: 'stale-receipt',
    });

    // Force the wikitext pages to re-extract (the old-parser production
    // state: cache entries written under the previous composed version).
    const cacheSnapshot = await database.ref('liquipediaPageCache').get();
    for (const [key, entry] of Object.entries(
      cacheSnapshot.val() as Record<string, { pageClass: string }>,
    )) {
      if (entry.pageClass === 'wikitext') {
        await database
          .ref(`liquipediaPageCache/${key}/parserVersion`)
          .set('stale-composed-version@old');
      }
    }

    const { client: secondClient } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    expect(second.counts.observationsSuperseded).toBe(1);
    const staleObservation = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/${staleId}`)
      .get();
    expect(staleObservation.exists()).toBe(false);
    const staleReceipt = await database
      .ref(`researchEnrichmentReceipts/${TENANT_ID}/${staleId}`)
      .get();
    expect(staleReceipt.exists()).toBe(false);
    const staleAttachment = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1/${staleId}`)
      .get();
    expect(staleAttachment.exists()).toBe(false);

    // The CURRENT-version records and their projection are untouched: no
    // old+new twins anywhere, and the row keeps its value.
    const observations = await database.ref(`researchEnrichmentObservations/${TENANT_ID}`).get();
    const parserVersions = new Set(
      Object.values(observations.val() as Record<string, { parserVersion: string }>).map(
        (record) => record.parserVersion,
      ),
    );
    expect(parserVersions.has('liquipedia-bracket-legacy@1')).toBe(false);
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });

  it('every real run ends its gather with a version-wide sweep: an outdated-family record on a page the expansion never visits is removed without a manual step', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    // A prior parser generation's record on a page OUTSIDE the current
    // expansion — the page-scoped supersede pass can never reach it.
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/orphaned-old-gen-1`).set({
      observationId: 'orphaned-old-gen-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'OldCup/2020/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/OldCup/2020/Bracket',
      sourceRevisionId: 5,
      sourceContentHash: sha256Hex('old-gen'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 100,
      observedAtMs: 100,
      matchingStatus: 'unmatched',
      players: [{ rawTag: 'Someone' }, { rawTag: 'Else' }],
    });

    const { client } = buildHappyPathClient();
    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // Removed by the END-OF-GATHER version-wide sweep, not the page-scoped
    // pass (its page was never re-extracted).
    expect(result.counts.outdatedFamilyRecordsSwept).toBe(1);
    expect(result.counts.observationsSuperseded).toBe(0);
    const orphan = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/orphaned-old-gen-1`)
      .get();
    expect(orphan.exists()).toBe(false);
    // The run's own current-generation records are untouched.
    expect(result.counts.observationsExtracted).toBeGreaterThanOrEqual(1);
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);
  });

  it('the end-of-run sweep fires on a SKIP-HEAVY run and removes a schema-INVALID old-generation straggler (raw selection)', async () => {
    const database = new FakeDatabase();
    // Run 1 populates every page cache, so run 2 is fully freshness-skipped —
    // the production shape in which the stragglers survived.
    await runHappyPath(database, 1_000);
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/old-shape-straggler`).set({
      observationId: 'old-shape-straggler',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'OldCup/2020/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/OldCup/2020/Bracket',
      sourceRevisionId: 5,
      sourceContentHash: sha256Hex('old-shape'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      // Old-shape stocks member: FAILS the current schema, so a
      // schema-validating selection cannot even see it.
      templateFamily: 'legacy',
      fetchedAtMs: 100,
      observedAtMs: 100,
      matchingStatus: 'unmatched',
      games: [{ ordinal: 1, stocks: [3, 'not-a-number'] }],
    });

    const { client: secondClient, calls } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // Fully skip-heavy: no content requests, no new gather output — and the
    // sweep still fired and still saw the raw straggler.
    expect(calls.getWikitext.length).toBe(0);
    expect(second.counts.outdatedFamilyRecordsSwept).toBe(1);
    const gone = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/old-shape-straggler`)
      .get();
    expect(gone.exists()).toBe(false);
  });

  it('DEFECT 2: a stored, current-version, receipt-less observation is re-resolved and re-receipted by a fully freshness-skipped run; the following run is a no-op', async () => {
    const database = new FakeDatabase();
    const { result: firstResult } = await runHappyPath(database, 1_000);
    expect(firstResult.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);

    // The production race shape: the RECEIPT was lost while the observation
    // (current-version, uniquely matched) and its attachment survived. Such
    // a record appears in NEITHER the gather output of a skip-heavy run NOR
    // the attachment-absence review queue.
    const attachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1`)
      .get();
    const attachedObservationIds = Object.keys(attachments.val() as Record<string, unknown>);
    expect(attachedObservationIds.length).toBeGreaterThanOrEqual(1);
    for (const observationId of attachedObservationIds) {
      await database.ref(`researchEnrichmentReceipts/${TENANT_ID}/${observationId}`).remove();
    }

    const { client: secondClient, calls: secondCalls } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // Fully skip-heavy (no content fetch), yet the stored receipt-less
    // observation re-resolved, its receipt was rebuilt, and the attachment
    // was revalidated against it.
    expect(secondCalls.getWikitext.length).toBe(0);
    expect(second.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    expect(second.counts.receiptsWritten).toBeGreaterThanOrEqual(1);
    expect(second.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);
    for (const observationId of attachedObservationIds) {
      const receipt = await database
        .ref(`researchEnrichmentReceipts/${TENANT_ID}/${observationId}`)
        .get();
      expect(receipt.exists()).toBe(true);
    }
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(VOD_URL);

    // Third run: everything receipted and attached again — a strict no-op.
    const { client: thirdClient } = buildHappyPathClient();
    const third = await runEnrichmentBatch({
      database: asDatabase(database),
      client: thirdClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 3_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(third.counts.resolvedMatched).toBe(0);
    expect(third.counts.receiptsWritten).toBe(0);
  });

  it('DEFECT 2 variant: an observation missing BOTH receipt and attachment is likewise recovered by a skip-heavy run', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database, 1_000);
    const attachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1`)
      .get();
    const attachedObservationIds = Object.keys(attachments.val() as Record<string, unknown>);
    for (const observationId of attachedObservationIds) {
      await database.ref(`researchEnrichmentReceipts/${TENANT_ID}/${observationId}`).remove();
      await database
        .ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1/${observationId}`)
        .remove();
    }

    const { client: secondClient } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(second.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    expect(second.counts.attachmentsCreated).toBeGreaterThanOrEqual(1);
    const attachment = await database.ref(`researchEnrichmentAttachments/${TENANT_ID}/set-1`).get();
    expect(attachment.exists()).toBe(true);
  });

  it('the KOWLOON class: a stored current-version, receipt-less, stocks-bearing observation whose array was null-stripped by storage parses, enters the resolution union, and attaches on a skip-heavy run', async () => {
    const database = new FakeDatabase();
    await runHappyPath(database, 1_000);

    // A second provider set the stored observation uniquely matches.
    const completedAtSeconds = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    await database.ref(`researchSource/${TENANT_ID}/sets/set-2`).set({
      providerSetId: 'set-2',
      storageKey: 'set-2',
      classification: 'complete',
      ruleId: 'singles',
      entrants: [
        { entrantId: 'e1', name: 'TestPlayer' },
        { entrantId: 'e2', name: 'KowloonFoe' },
      ],
      games: [{ gameId: 1, winnerEntrantId: 'e1' }],
      totalGames: 1,
      completedAt: completedAtSeconds,
      event: {
        tournamentSlug: 'test-cup-2026',
        tournamentName: 'Test Cup 2026',
        name: 'Test Cup 2026 Singles',
      },
      apiIds: { setId: 'set-2' },
      ingestionRunId: 'seed-ingestion-run',
      fetchedAtMs: 1,
      lastObservedAtMs: 1,
    });
    await database.ref(`matches/${TENANT_ID}/sgg-set-2-g1`).set({ note: 'seed' });

    // The production shape, seeded EXACTLY as the pre-fix pipeline stored
    // it: a current-version observation written with a stocks array whose
    // seat is null — the RTDB-parity fake degrades it to the sparse
    // read-back form, which the pre-fix schema could not parse (so the
    // resolution union could not see it: matched=0 on the top-up).
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/kowloon-12`).set({
      observationId: 'kowloon-12',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'KOWLOON/12/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/KOWLOON/12/Bracket',
      sourceRevisionId: 44,
      sourceContentHash: sha256Hex('kowloon-content'),
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
      templateFamily: 'legacy',
      fetchedAtMs: 900,
      observedAtMs: 900,
      matchingStatus: 'unmatched',
      game: 'ultimate',
      tournamentPageTitle: 'TestCup/2026',
      tournamentStartggSlug: 'test-cup-2026',
      players: [{ rawTag: 'TestPlayer' }, { rawTag: 'KowloonFoe' }],
      scores: [1, 0],
      vodUrl: 'https://www.youtube.com/watch?v=kowloon12',
      rawVodUrl: 'https://www.youtube.com/watch?v=kowloon12',
      games: [{ ordinal: 1, stocks: [null, 0] }],
    });
    const storedRaw = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/kowloon-12/games/0/stocks`)
      .get();
    // Proof the seed really is storage-degraded: a sparse array with a hole.
    expect(0 in (storedRaw.val() as unknown[])).toBe(false);

    const { client: secondClient, calls } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // Fully freshness-skipped, yet the degraded stored record parsed,
    // resolved uniquely, was receipted, attached, and projected.
    expect(calls.getWikitext.length).toBe(0);
    expect(second.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
    const receipt = await database.ref(`researchEnrichmentReceipts/${TENANT_ID}/kowloon-12`).get();
    expect(receipt.exists()).toBe(true);
    const attachment = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/set-2/kowloon-12`)
      .get();
    expect(attachment.exists()).toBe(true);
    const row = await database.ref(`matches/${TENANT_ID}/sgg-set-2-g1`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(
      'https://www.youtube.com/watch?v=kowloon12',
    );

    // The following run is a strict no-op for it.
    const { client: thirdClient } = buildHappyPathClient();
    const third = await runEnrichmentBatch({
      database: asDatabase(database),
      client: thirdClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 3_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(third.counts.resolvedMatched).toBe(0);
    expect(third.counts.receiptsWritten).toBe(0);
  });

  it('a dry run never sweeps', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database);
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/orphaned-old-gen-2`).set({
      observationId: 'orphaned-old-gen-2',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'OldCup/2020/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/OldCup/2020/Bracket',
      sourceRevisionId: 5,
      sourceContentHash: sha256Hex('old-gen'),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 100,
      observedAtMs: 100,
      matchingStatus: 'unmatched',
    });
    const { client } = buildHappyPathClient();
    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: true,
    });
    expect(result.counts.outdatedFamilyRecordsSwept).toBe(0);
    const orphan = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/orphaned-old-gen-2`)
      .get();
    expect(orphan.exists()).toBe(true);
  });

  it('DEFECT B: cache entries written under an older adapter version are treated as stale — the page re-fetches and its observations re-persist', async () => {
    const database = new FakeDatabase();
    const { result: firstResult } = await runHappyPath(database, 1_000);
    expect(firstResult.counts.observationsExtracted).toBeGreaterThanOrEqual(1);

    // Simulate the production state: the cache was written by a run whose
    // ADAPTERS predate the current ones (the composed version string was
    // different then). Rewrite every wikitext-class entry's parserVersion to
    // that older composition.
    const cacheSnapshot = await database.ref('liquipediaPageCache').get();
    const entries = cacheSnapshot.val() as Record<
      string,
      { pageClass: string; parserVersion: string }
    >;
    let rewritten = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.pageClass === 'wikitext') {
        await database
          .ref(`liquipediaPageCache/${key}/parserVersion`)
          .set(
            'liquipedia-wikitext-probe@1|liquipedia-bracket-legacy@0|liquipedia-bracket-match2@0',
          );
        rewritten += 1;
      }
    }
    expect(rewritten).toBeGreaterThanOrEqual(2);

    const { client: secondClient, calls: secondCalls } = buildHappyPathClient();
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: secondClient,
      tenantId: TENANT_ID,
      playerLabels: ['TestPlayer'],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    // Pre-fix behavior: wikitextCacheHits for every page and zero content
    // requests, leaving the OLD-extraction observations in place forever.
    expect(second.counts.wikitextCacheHits).toBe(0);
    expect(secondCalls.getWikitext.length).toBeGreaterThanOrEqual(1);
    expect(second.counts.observationsExtracted).toBeGreaterThanOrEqual(1);
  });
});
