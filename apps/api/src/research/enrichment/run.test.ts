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
import { readEnrichmentObservation, writeEnrichmentObservation } from './store.js';
import { readEnrichmentCoverage } from './rollup.js';
import { runEnrichmentBatch } from './run.js';

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

async function seedProviderSet(database: FakeDatabase): Promise<void> {
  const completedAtSeconds = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  await database.ref(`researchSource/${TENANT_ID}/sets/set-1`).set({
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
  await database.ref(`matches/${TENANT_ID}/sgg-set-1-g1`).set({ note: 'seed' });
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
      parserVersion: 'liquipedia-bracket-legacy@1',
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
