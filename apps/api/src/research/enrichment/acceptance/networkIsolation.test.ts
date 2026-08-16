import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../../test-support/fakeDatabase.js';
import { UnstubbedNetworkAccessError } from '../../../test-support/failClosedFetch.js';
import {
  buildLiquipediaPageUrl,
  createLiquipediaClient,
  isParseClassPageAllowed,
  LIQUIPEDIA_API_ENDPOINT,
  LIQUIPEDIA_PARSE_CLASS_ALLOWLIST,
  LiquipediaParseNotAllowedError,
} from '../../../liquipedia/client.js';
import { createLiquipediaFixtureFetch } from '../../../liquipedia/__fixtures__/loadFixture.js';
import { createLiquipediaLimiter } from '../../../liquipedia/limiter.js';
import { runMigration } from '../../migration/manifest.js';
import { writeEnrichmentObservation, writeResolutionReceipt } from '../store.js';
import { buildResolutionReceipt, type ResolutionOutcome } from '../resolution.js';
import { stageEnrichmentProgress, publishEnrichmentCoverage } from '../rollup.js';
import { createOrResumeEnrichmentRun } from '../runState.js';

/**
 * Phase 30.2 Plan 12 (ENR-11): the structural guarantee behind every other
 * claim in this phase. If THIS suite can be made to pass while a live
 * request actually happens, none of the other suites in this phase mean
 * anything — and it is the plan-02 GLOBAL fail-closed `fetch` stub
 * (`apps/api/src/test-support/failClosedFetch.ts`, installed through
 * `apps/api/vitest.config.ts`'s `setupFiles`), NOT the static scan below,
 * that makes that impossible. The static scan is defence in depth: it
 * catches a request target that should not exist in SOURCE, while the
 * fail-closed stub catches a request that should not be made at RUNTIME.
 * Neither subsumes the other (cycle-1 review HIGH 4).
 */

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const API_SRC = resolve('src');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// FIRST — the fail-closed lock (the PRIMARY control).
// ---------------------------------------------------------------------------

describe('LOCK 1 (primary control): the global fail-closed fetch stub', () => {
  it('apps/api/vitest.config.ts registers the setup file that installs the stub — deleting the registration would turn this test red', () => {
    const configSource = readFileSync(resolve('vitest.config.ts'), 'utf-8');
    expect(configSource).toMatch(/setupFiles:\s*\[\s*['"]\.\/vitest\.setup\.ts['"]\s*\]/);
  });

  it.each([
    ['an arbitrary third-party URL', 'https://example.com/definitely-not-liquipedia'],
    ['the real Liquipedia API endpoint', LIQUIPEDIA_API_ENDPOINT],
    ['a URL built by buildLiquipediaPageUrl', buildLiquipediaPageUrl('Supernova/2026/Ultimate')],
  ])(
    'calling globalThis.fetch from inside this test rejects with UnstubbedNetworkAccessError for %s — a scan that permits the endpoint constant (it must, since declaring it is the whole point of the scan) would let a test that forgot to inject a fixture fetch reach the live wiki and still pass; the fail-closed stub is what makes that impossible regardless of what the scan permits',
    async (_label, url) => {
      await expect(globalThis.fetch(url)).rejects.toBeInstanceOf(UnstubbedNetworkAccessError);
    },
  );

  it('failClosedFetch.ts exports no restore/disable/allowlist HELPER (function or const) — a lock a caller can switch back off mid-file is not a lock; the error CLASS name is exempt from this scan (its name legitimately contains "unstub")', () => {
    const source = stripComments(
      readFileSync(resolve(API_SRC, 'test-support/failClosedFetch.ts'), 'utf-8'),
    );
    const exportedFunctionOrConstNames = Array.from(
      source.matchAll(/export\s+(?:async\s+function|function|const)\s+(\w+)/g),
    ).map((m) => m[1]!);
    expect(exportedFunctionOrConstNames.length).toBeGreaterThan(0);
    for (const name of exportedFunctionOrConstNames) {
      expect(name.toLowerCase()).not.toMatch(/restore|disable|allow|reset/);
    }
    // Positive control: the module still exports something (the installer) —
    // an empty match set would make the loop above vacuously pass.
    expect(exportedFunctionOrConstNames).toContain('installFailClosedFetch');
  });
});

// ---------------------------------------------------------------------------
// SECOND — DEFENCE IN DEPTH: a static scan over the Liquipedia + enrichment
// directories. Catches a target that should not exist in source; the
// fail-closed stub above catches a request that should not be made at
// runtime. Neither subsumes the other.
// ---------------------------------------------------------------------------

const SCANNED_DIRS = [resolve(API_SRC, 'liquipedia'), resolve(API_SRC, 'research/enrichment')];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      // __fixtures__ holds recorded RESPONSE BYTES (JSON) whose content
      // legitimately quotes source-page URLs and request forms verbatim —
      // it is not source code that ISSUES requests, and its provenance is
      // separately locked by MANIFEST.md + loadFixture.ts's own
      // no-network-access contract. Scanning its .ts LOADER file (not its
      // .json payloads) is still correct and included below.
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

const SCANNED_SOURCE_FILES = SCANNED_DIRS.flatMap((dir) => collectSourceFiles(dir));

/**
 * A URL-AWARE comment stripper — `stripComments`'s naive line-comment regex
 * (`\/\/.*$`) truncates a string literal containing `https://` at the FIRST
 * `//` it finds, which is exactly inside the scheme separator, silently
 * eating every URL this scan exists to find. This variant only strips a
 * `//` line comment when it is NOT immediately preceded by `:` — true for
 * every real line comment in this codebase's style, and false for every
 * `http(s)://` occurrence.
 */
function stripCommentsPreservingUrls(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `https://...` (or `http://...`) literal substring found in comment-stripped source, with its containing line for a useful failure message. */
function findUrlLiterals(source: string): { url: string; line: number }[] {
  const stripped = stripCommentsPreservingUrls(source);
  const results: { url: string; line: number }[] = [];
  const pattern = /https?:\/\/[^\s'"`\\]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const line = stripped.slice(0, match.index).split('\n').length;
    results.push({ url: match[0], line });
  }
  return results;
}

const ALLOWED_URL_PREFIXES = [
  'https://liquipedia.net/smash/api.php',
  'https://liquipedia.net/smash/',
  'https://liquipedia.net/api-terms-of-use',
  'https://creativecommons.org/licenses/by-sa/3.0/',
  'http://creativecommons.org/licenses/by-sa/3.0/us/',
  'https://www.youtube.com',
  'https://youtube.com',
  'https://youtu.be',
  'https://m.youtube.com',
  'https://twitch.tv',
  'https://www.twitch.tv',
  'https://m.twitch.tv',
  // client.ts's User-Agent contact identifier — NOT a request target, never
  // fetched, just an identifying string sent AS A HEADER on every request
  // to the one real endpoint above.
  'https://grandfinals.gg',
  // vodUrl.ts builds (never fetches) a CANONICAL, STORABLE redirect URL from
  // an already-validated, write-time-allowlisted host — see this module's
  // own header (T-30.2-18). The interpolated host is one of the exact
  // hostnames already covered by the youtube/twitch prefixes above.
  'https://${CANONICAL_YOUTUBE_WATCH_HOST}',
  'https://${CANONICAL_TWITCH_HOST}',
  // 30.3 Gate 5: the SECOND declared outbound endpoint — the YouTube Data
  // API search endpoint `vodDiscovery.ts` declares as a named constant
  // (YOUTUBE_SEARCH_ENDPOINT). Declaring it here is exactly what this scan
  // exists for (a target that SHOULD exist in source); the fail-closed
  // fetch stub above remains the primary control that no test can actually
  // reach it, and the module itself has no default-fetch path (its
  // `fetchImpl` is a REQUIRED member, mirroring the Liquipedia client's
  // compile-time gate). Scraping any other YouTube surface stays outside
  // this allowlist and trips the scan.
  'https://www.googleapis.com/youtube/v3/search',
];

describe('LOCK 2 (defence in depth): static scan — the endpoint constant is the only outbound target anywhere in source', () => {
  it('discovers at least one scanned file per directory and fails loudly if a scanned directory does not exist', () => {
    expect(SCANNED_DIRS.length).toBeGreaterThanOrEqual(2);
    for (const dir of SCANNED_DIRS) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    expect(SCANNED_SOURCE_FILES.length).toBeGreaterThan(0);
  });

  it.each(SCANNED_SOURCE_FILES.map((f) => [f.slice(resolve('.').length + 1), f] as const))(
    '%s constructs no request target from a variable host or path — every literal URL substring is a member of the allowlisted, constant prefix set',
    (_relLabel, file) => {
      const source = readFileSync(file, 'utf-8');
      const urls = findUrlLiterals(source);
      for (const { url, line } of urls) {
        const allowed = ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
        expect(allowed, `unexpected URL literal "${url}" at ${file}:${line}`).toBe(true);
      }
    },
  );

  it("FIXTURE: a URL sitting inside a comment does not trip the lock (mirrors telemetrySilence.test.ts's comment-stripping)", () => {
    const fixture = [
      '// https://evil.example.com/not-a-real-call',
      '/* https://also-evil.example.com */',
      "const endpoint = 'https://liquipedia.net/smash/api.php';",
    ].join('\n');
    const urls = findUrlLiterals(fixture);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.url).toContain('liquipedia.net/smash/api.php');
  });
});

// ---------------------------------------------------------------------------
// THIRD — the client has no default-fetch path.
// ---------------------------------------------------------------------------

describe('LOCK 3: the client has no default-fetch path (mirrors the plan-03 compile-time gate at the acceptance level)', () => {
  it('client.ts contains no optional fetchImpl?, no fetchImpl = fetch default, and no globalThis.fetch fallback', () => {
    const source = stripComments(readFileSync(resolve(API_SRC, 'liquipedia/client.ts'), 'utf-8'));
    expect(source).not.toMatch(/fetchImpl\s*\?\s*:/);
    expect(source).not.toMatch(/fetchImpl\s*=\s*fetch\b/);
    expect(source).not.toMatch(/fetchImpl\s*\?\?\s*globalThis\.fetch/);
    expect(source).not.toMatch(/options\.fetchImpl\s*\?\?/);
    // Positive control: the required member is still declared as required.
    expect(source).toMatch(/fetchImpl:\s*typeof fetch;/);
  });
});

// ---------------------------------------------------------------------------
// FOURTH — the parse-class allowlist lock (CONTEXT requires it TESTED).
// ---------------------------------------------------------------------------

describe('LOCK 4: the tested parse-class allowlist', () => {
  it('has exactly one entry', () => {
    expect(LIQUIPEDIA_PARSE_CLASS_ALLOWLIST).toHaveLength(1);
  });

  it.each([
    ['Hungrybox', 'Hungrybox/VODs'],
    ['MkLeo', 'MkLeo/VODs'],
    ['MKLeo', 'MKLeo/VODs'],
    ['Sparg0', 'Sparg0/VODs'],
    ['IzAw', 'IzAw/VODs'],
  ])('accepts the %s demo-player VOD page title', (_label, title) => {
    expect(isParseClassPageAllowed(title)).toBe(true);
  });

  it.each([
    ['a bracket page title', 'Supernova/2026/Ultimate/Singles Bracket'],
    ['a tournament page title', 'Supernova/2026/Ultimate'],
    ['a pools page title', 'Smash Conference United/Ultimate/Singles Pools/A3'],
    ['a template page title', 'Template:Player vod list'],
    ['a title containing a traversal segment', '../../etc/passwd/VODs'],
  ])('rejects %s', (_label, title) => {
    expect(isParseClassPageAllowed(title)).toBe(false);
  });

  it('a parse-class call for a rejected title throws BEFORE the recorded request list gains an entry — no budget spent, no fetch reached', async () => {
    const { fetchImpl, requests } = createLiquipediaFixtureFetch([]);
    const client = createLiquipediaClient({
      config: { contact: 'test@example.com' },
      limiter: createLiquipediaLimiter(asDatabase(new FakeDatabase())),
      fetchImpl,
    });

    await expect(client.getGeneratedVodPage('Supernova/2026/Ultimate')).rejects.toBeInstanceOf(
      LiquipediaParseNotAllowedError,
    );
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIFTH — attribution (including its authorising receipts) survives
// migration.
// ---------------------------------------------------------------------------

describe('LOCK 5: attribution survives migration, including the receipts tree and the pending witness half', () => {
  it('every attribution member is byte-identical at the destination', async () => {
    const database = new FakeDatabase();
    const SOURCE_ID = 'migration-source-tenant';
    const DEST_UID = 'migration-dest-uid';
    const TARGET_SET_ID = 'migration-target-set';
    const MATCH_KEY = `sgg-${TARGET_SET_ID}-g1`;

    await database.ref(`users/${DEST_UID}`).set({ createdAt: 1 });

    const observation: ResearchEnrichmentObservationRecord = {
      observationId: 'migration-obs-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
      sourceRevisionId: 535578,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1000,
      observedAtMs: 1000,
      matchingStatus: 'unmatched',
      games: [{ ordinal: 1, canonicalStageId: 1, rawStage: 'Battlefield' }],
      candidateTargetSetIds: [TARGET_SET_ID],
    };
    await writeEnrichmentObservation(asDatabase(database), SOURCE_ID, observation);

    const outcome: ResolutionOutcome = {
      type: 'matched',
      targetSetId: TARGET_SET_ID,
      confidence: 'high',
      evidence: ['slug-anchor'],
    };
    const receipt = buildResolutionReceipt(observation, outcome, 1500)!;
    await writeResolutionReceipt(asDatabase(database), SOURCE_ID, receipt);
    await database
      .ref(
        `researchEnrichmentAttachments/${SOURCE_ID}/${TARGET_SET_ID}/${observation.observationId}`,
      )
      .set({
        observationId: observation.observationId,
        targetSetId: TARGET_SET_ID,
        attachmentSource: 'resolver',
        attachedAtMs: 1500,
        sourceRevisionId: observation.sourceRevisionId,
        sourceContentHash: observation.sourceContentHash,
        parserVersion: observation.parserVersion,
        receiptId: receipt.receiptId,
      });

    // Projection witness carrying BOTH the committed AND the pending halves.
    await database.ref(`researchEnrichmentProjection/${SOURCE_ID}/${MATCH_KEY}`).set({
      matchKey: MATCH_KEY,
      targetSetId: TARGET_SET_ID,
      projectedStageId: 1,
      projectedStageName: 'Battlefield',
      projectedStageRaw: 'Battlefield',
      stageObservationId: observation.observationId,
      pendingVodUrl: 'https://www.youtube.com/watch?v=pendingMigrationCase',
      pendingVodObservationId: observation.observationId,
      pendingWriteStartedAtMs: 1600,
    });

    const created = await createOrResumeEnrichmentRun(asDatabase(database), SOURCE_ID, 2000);
    await stageEnrichmentProgress(asDatabase(database), {
      tenantId: SOURCE_ID,
      runId: created.runId,
      countsDelta: { matched: 1, stageEnriched: 1 },
      now: 2000,
    });
    await publishEnrichmentCoverage(asDatabase(database), {
      tenantId: SOURCE_ID,
      runId: created.runId,
      now: 2000,
      perSourcePage: {
        [observation.sourcePageTitle]: {
          pageTitle: observation.sourcePageTitle,
          revisionId: observation.sourceRevisionId,
          contentHash: observation.sourceContentHash,
          fetchedAtMs: observation.fetchedAtMs,
          observationCount: 1,
        },
      },
    });

    const manifest = await runMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });
    expect(manifest.ok).toBe(true);
    for (const tree of manifest.trees) {
      expect(tree.match, `tree ${tree.tree} did not migrate byte-identically`).toBe(true);
    }

    // Attribution — observation.
    const destObservation = (
      await database
        .ref(`researchEnrichmentObservations/${DEST_UID}/${observation.observationId}`)
        .get()
    ).val() as ResearchEnrichmentObservationRecord;
    expect(destObservation.sourcePageTitle).toBe(observation.sourcePageTitle);
    expect(destObservation.sourcePageUrl).toBe(observation.sourcePageUrl);
    expect(destObservation.sourceRevisionId).toBe(observation.sourceRevisionId);
    expect(destObservation.sourceContentHash).toBe(observation.sourceContentHash);
    expect(destObservation.parserVersion).toBe(observation.parserVersion);
    expect(destObservation.fetchedAtMs).toBe(observation.fetchedAtMs);
    expect(destObservation.observedAtMs).toBe(observation.observedAtMs);

    // The authorising receipt.
    const destReceipt = (
      await database
        .ref(`researchEnrichmentReceipts/${DEST_UID}/${observation.observationId}`)
        .get()
    ).val();
    expect(destReceipt).toEqual(receipt);

    // Every attachment's receiptId still resolves to a receipt at the
    // destination.
    const destAttachment = (
      await database
        .ref(
          `researchEnrichmentAttachments/${DEST_UID}/${TARGET_SET_ID}/${observation.observationId}`,
        )
        .get()
    ).val() as { receiptId: string };
    expect(destAttachment.receiptId).toBe(receipt.receiptId);
    // Receipts are keyed by observationId (store.ts's own layout), so
    // "resolves to a receipt" means the receipt stored under THIS
    // observation's key still exists AND still carries the id the
    // attachment names.
    const receiptForAttachment = (
      await database
        .ref(`researchEnrichmentReceipts/${DEST_UID}/${observation.observationId}`)
        .get()
    ).val() as { receiptId: string } | null;
    expect(receiptForAttachment).not.toBeNull();
    expect(receiptForAttachment?.receiptId).toBe(destAttachment.receiptId);

    // The pending witness half survives.
    const destWitness = (
      await database.ref(`researchEnrichmentProjection/${DEST_UID}/${MATCH_KEY}`).get()
    ).val() as {
      pendingVodUrl?: string;
      projectedStageId?: number;
    };
    expect(destWitness.pendingVodUrl).toBe('https://www.youtube.com/watch?v=pendingMigrationCase');
    expect(destWitness.projectedStageId).toBe(1);

    // The published coverage snapshot's perSourcePage.sourcePageUrl.
    const destCoverage = (
      await database.ref(`researchEnrichmentCoverage/${DEST_UID}`).get()
    ).val() as {
      perSourcePage?: Record<string, { sourcePageUrl?: string }>;
    };
    expect(destCoverage.perSourcePage?.[observation.sourcePageTitle]?.sourcePageUrl).toBe(
      observation.sourcePageUrl,
    );

    // The descriptor lock (module-load-time invariant) still holds — the
    // migration module imported without throwing is itself proof, and this
    // assertion documents WHY: `manifest.ts`'s own `TREE_DESCRIPTOR_LOCK.ok`
    // export is the live value that invariant produced.
    const { TREE_DESCRIPTOR_LOCK } = await import('../../migration/manifest.js');
    expect(TREE_DESCRIPTOR_LOCK.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SIXTH — the inherited-isolation lock, TESTED rather than assumed.
// ---------------------------------------------------------------------------

const PUBLIC_AND_BEARER_TOKEN_ROUTE_FILES = [
  'routes/publicVodShares.ts',
  'routes/publicReviewDeliveries.ts',
  'routes/shareMeta.ts',
  'routes/shareOgImage.ts',
  'routes/coachNotes.ts',
];

function extractRoutePaths(relativeFile: string): string[] {
  const source = stripComments(readFileSync(resolve(API_SRC, relativeFile), 'utf-8'));
  const pattern = /app\.(get|post|patch|delete)\(\s*'([^']+)'/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    paths.push(match[2]!);
  }
  return paths;
}

const ENRICHMENT_SELF_ROUTE_FRAGMENTS = [
  '/enrichment/review',
  '/enrichment/coverage',
  '/enrichment/attachments',
  'enrichment/attribution',
];

describe('LOCK 6: the inherited-isolation lock is TESTED, not assumed', () => {
  it('none of the routes this phase added creates a public or bearer-token delivery path for a demo subject — the enrichment review, coverage and self-attribution routes are absent from the public/bearer-token route inventories the shipped structural-absence delivery suites enumerate', () => {
    const allPublicAndBearerRoutes = PUBLIC_AND_BEARER_TOKEN_ROUTE_FILES.flatMap(extractRoutePaths);
    expect(allPublicAndBearerRoutes.length).toBeGreaterThan(0);

    for (const fragment of ENRICHMENT_SELF_ROUTE_FRAGMENTS) {
      const offendingRoute = allPublicAndBearerRoutes.find((path) => path.includes(fragment));
      expect(
        offendingRoute,
        `enrichment fragment "${fragment}" unexpectedly appears in a public/bearer-token route: ${offendingRoute}`,
      ).toBeUndefined();
    }
  });

  it('the enrichment routes are registered ONLY under the authenticated admin family (routes/research.ts) and the authenticated self family (routes/users.ts) — never under a public or bearer-token file', () => {
    const researchRoutes = extractRoutePaths('routes/research.ts');
    const usersRoutes = extractRoutePaths('routes/users.ts');
    expect(researchRoutes.some((p) => p.includes('/enrichment/review'))).toBe(true);
    expect(researchRoutes.some((p) => p.includes('/enrichment/coverage'))).toBe(true);
    expect(usersRoutes.some((p) => p.includes('enrichment/attribution'))).toBe(true);
  });

  it('the telemetry-silence scan covers both new directories (apps/api/src/liquipedia and apps/api/src/research/enrichment)', () => {
    const source = readFileSync(
      resolve(API_SRC, 'research/ingestion/telemetrySilence.test.ts'),
      'utf-8',
    );
    expect(source).toMatch(/resolve\(API_SRC,\s*['"]liquipedia['"]\)/);
    expect(source).toMatch(/resolve\(API_SRC,\s*['"]research\/enrichment['"]\)/);
  });
});
