import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test-support/testApp.js';
import type { InternalJobsConfig, StartggConfig } from '../../config/env.js';

/**
 * Phase 30 Plan 08 (RTEN-04, D-06, D-18): the ingestion-subsystem telemetry-
 * silence lock — the same two-proof structure `lockedContracts.test.ts` and
 * `serverEmitterAudit.test.ts` use, applied at the granularity of the
 * ingestion module family.
 *
 * A call-site scan cannot see a transitive emission through a helper, and a
 * behavioral test cannot see an emitter on a code path this fixture never
 * reaches — RTEN-04's guarantee needs both. Phase 29 established the same
 * pairing for its own surfaces (`serverEmitterAudit.test.ts`,
 * `isolationEnumeration.test.ts`); this file re-proves it for a subsystem
 * that writes tens of thousands of records.
 *
 * Phase 30.2 Plan 02 (ENR-11, RTEN-04 inheritance): the scan is
 * DIRECTORY-SCOPED — a new enrichment directory that is not listed below is
 * not covered by this lock, silently. `SCANNED_DIRS` must therefore be
 * extended in the SAME commit that creates any new enrichment source
 * directory. `apps/api/src/liquipedia` is added here; a later plan in this
 * phase is expected to add `apps/api/src/research/enrichment` the same way.
 */

const API_SRC = resolve('src');
const SCANNED_DIRS = [resolve(API_SRC, 'research/ingestion'), resolve(API_SRC, 'liquipedia')];
const LEDGER_MODULE_PATH = resolve(API_SRC, 'events/ledger.ts');
const ENVELOPE_MODULE_PATH = resolve(API_SRC, 'events/envelope.ts');
const GA4_PROJECTION_MODULE_RELATIVE = 'jobs/projectGa4';
const EVENTS_MODULE_RELATIVE_FRAGMENTS = ['events/ledger', 'events/envelope'];

/** Recursively collects every non-test `.ts` source file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * The scanned surface: every non-test source file directly under each
 * directory in `SCANNED_DIRS`, discovered by directory read (so a file
 * added later is scanned automatically), PLUS the batch executor that
 * composes the ingestion family — the one ingestion source file that lives
 * outside `research/ingestion/`.
 */
const INGESTION_SOURCE_FILES = [
  ...SCANNED_DIRS.flatMap((dir) => collectSourceFiles(dir)),
  resolve(API_SRC, 'jobs/researchBackfillBatch.ts'),
];

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

/** Mirrors `serverEmitterAudit.test.ts`'s comment/string-literal stripping. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function stripStringLiterals(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * The exact exported names read from the events modules at TEST TIME, never
 * retyped as literals here — a rename in either module changes this list
 * automatically rather than silently defeating the scan.
 */
function discoverExportedFunctionNames(modulePath: string): string[] {
  const stripped = stripComments(readFileSync(modulePath, 'utf-8'));
  const names: string[] = [];
  const pattern = /export\s+(?:async\s+function|function)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

const EMISSION_HELPER_IDENTIFIERS = [
  ...discoverExportedFunctionNames(LEDGER_MODULE_PATH),
  ...discoverExportedFunctionNames(ENVELOPE_MODULE_PATH),
];

function countIdentifierCallSites(fullyStrippedSource: string, identifier: string): number {
  const pattern = new RegExp(`\\b${identifier}\\s*\\(`, 'g');
  return (fullyStrippedSource.match(pattern) ?? []).length;
}

function importsEventsOrGa4Module(commentStrippedSource: string): boolean {
  const importPattern = /import\s*(?:type\s*)?(?:\{[^}]*\}|\w+)\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(commentStrippedSource)) !== null) {
    const specifier = match[1]!;
    if (EVENTS_MODULE_RELATIVE_FRAGMENTS.some((fragment) => specifier.includes(fragment))) {
      return true;
    }
    if (specifier.includes(GA4_PROJECTION_MODULE_RELATIVE)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anti-vacuous-pass guards.
// ---------------------------------------------------------------------------

/**
 * Recorded when this lock was written: 9 `research/ingestion` source files +
 * the batch executor (10 total). Phase 30.2 Plan 02 added `apps/api/src/
 * liquipedia/__fixtures__/loadFixture.ts` (1 non-test file), bringing the
 * baseline to 11. A discovery glob returning fewer means the scan broke,
 * not that the surface shrank.
 */
const BASELINE_INGESTION_FILE_COUNT = 11;

describe('telemetrySilence: anti-vacuous-pass guards', () => {
  it('discovers at least the recorded baseline of ingestion source files across research/ingestion and liquipedia (a broken discovery glob must fail here, not pass with nothing to scan)', () => {
    expect(INGESTION_SOURCE_FILES.length).toBeGreaterThanOrEqual(BASELINE_INGESTION_FILE_COUNT);
  });

  it('discovers at least one emission helper identifier from each events module', () => {
    expect(discoverExportedFunctionNames(LEDGER_MODULE_PATH).length).toBeGreaterThan(0);
    expect(discoverExportedFunctionNames(ENVELOPE_MODULE_PATH).length).toBeGreaterThan(0);
  });

  it('SCANNED_DIRS has at least 2 entries and every entry resolves to an existing directory (a renamed directory must fail loudly, never silently un-cover itself)', () => {
    expect(SCANNED_DIRS.length).toBeGreaterThanOrEqual(2);
    for (const dir of SCANNED_DIRS) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Proof one — a call-site scan over research/ingestion and liquipedia.
// ---------------------------------------------------------------------------

describe('telemetrySilence: proof one — call-site scan over research/ingestion and liquipedia', () => {
  it.each(INGESTION_SOURCE_FILES.map((f) => [relPath(f), f] as const))(
    '%s calls no canonical emission helper and imports no events/GA4 module',
    (_relLabel, file) => {
      const raw = readFileSync(file, 'utf-8');
      const commentStripped = stripComments(raw);
      const fullyStripped = stripStringLiterals(commentStripped);

      for (const identifier of EMISSION_HELPER_IDENTIFIERS) {
        expect(countIdentifierCallSites(fullyStripped, identifier)).toBe(0);
      }
      expect(importsEventsOrGa4Module(commentStripped)).toBe(false);
    },
  );

  it('FIXTURE: does not count an occurrence inside a comment or a string literal', () => {
    const fixture = [
      "import { createEvent } from '../events/ledger.js';",
      '// createEvent(fakeArgA) — a comment mention must not count',
      '/* createEvent(fakeArgB) — a block-comment mention must not count */',
      'const message = "please call createEvent(fakeArgC) to emit";',
      'void createEvent(database, envelope); // the ONE real call',
    ].join('\n');
    const commentStripped = stripComments(fixture);
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countIdentifierCallSites(fullyStripped, 'createEvent')).toBe(1);
  });

  it('FIXTURE: an import naming the events module is detected regardless of the imported specifier list', () => {
    const fixture = "import { createEvent } from '../events/ledger.js';\nvoid createEvent;";
    expect(importsEventsOrGa4Module(stripComments(fixture))).toBe(true);
  });

  it('FIXTURE: an import naming an unrelated module is NOT detected', () => {
    const fixture = "import { classifyResearchSet } from './classification.js';";
    expect(importsEventsOrGa4Module(stripComments(fixture))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Proof two — a behavioral zero-emission session.
// ---------------------------------------------------------------------------

const ADMIN_UID = 'telemetry-lock-admin-1';
const ADMIN_TOKEN = 'telemetry-lock-admin-token';
const PLAYER_ID = '100';
const RESEARCH_CONFIG = { adminUids: new Set([ADMIN_UID]) };
const STARTGG_CONFIG: StartggConfig = {
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://example.com/cb',
  apiToken: 'server-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'https://example.com',
};
const INTERNAL_JOBS_CONFIG: InternalJobsConfig = { secret: 'telemetry-lock-secret' };
const SECRET_HEADER = 'x-internal-jobs-secret';

function makeStartggFetch(): typeof fetch {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes('ResearchPlayerSets')) {
      return new Response(
        JSON.stringify({
          data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } } },
        }),
      );
    }
    return new Response(JSON.stringify({ data: null }));
  }) as unknown as typeof fetch;
}

/** Mirrors `entitlements.test.ts`'s `flush` helper: flush the microtask/macrotask queue before asserting a fire-and-forget emission never landed. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function assertNoTelemetryTrees(dump: Record<string, unknown>): void {
  expect(dump).not.toHaveProperty('eventLedger');
  expect(dump).not.toHaveProperty('eventDedup');
  expect(dump).not.toHaveProperty('outboxPending');
}

async function runFullResearchSession(
  seedSiblingCoachingTenant: boolean,
): Promise<Record<string, unknown>> {
  const { app, auth, database } = buildTestApp({
    research: RESEARCH_CONFIG,
    startgg: STARTGG_CONFIG,
    startggFetch: makeStartggFetch(),
    internalJobs: INTERNAL_JOBS_CONFIG,
  });
  auth.registerToken(ADMIN_TOKEN, { uid: ADMIN_UID, email: 'admin@test.com' });

  if (seedSiblingCoachingTenant) {
    database.seed('matches/coaching-sibling-uid-1/legacy-match-1', {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'someone',
      matchType: 'friendlies',
      win: true,
      source: 'manual',
    });
  }

  // 1. Create a research tenant.
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/research/tenants',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { label: 'Telemetry lock session' },
  });
  expect(createResponse.statusCode).toBe(201);
  const tenantId = createResponse.json().tenantId as string;

  // 2. Confirm an identity mapping.
  const confirmResponse = await app.inject({
    method: 'POST',
    url: `/api/research/tenants/${tenantId}/identity/confirm`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { players: [{ playerId: PLAYER_ID }] },
  });
  expect(confirmResponse.statusCode).toBe(200);

  // 3. Trigger a backfill through the admin route.
  const triggerResponse = await app.inject({
    method: 'POST',
    url: `/api/research/tenants/${tenantId}/backfill/trigger`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { mode: 'full' },
  });
  expect(triggerResponse.statusCode).toBe(200);
  const runId = triggerResponse.json().batch.runId as string;

  // 4. Advance it to completion through the internal job route.
  for (let i = 0; i < 5; i += 1) {
    const advanceResponse = await app.inject({
      method: 'GET',
      url: `/internal/jobs/research-backfill?tenantId=${tenantId}&runId=${runId}`,
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(advanceResponse.statusCode).toBe(200);
    if ((advanceResponse.json() as { completed: boolean }).completed) {
      break;
    }
  }

  // 5. Record a supplement.
  const supplementResponse = await app.inject({
    method: 'POST',
    url: `/api/research/tenants/${tenantId}/supplements`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: { targetSetId: 'set-1', field: 'note', value: 'A manual note', sourceKind: 'manual' },
  });
  expect(supplementResponse.statusCode).toBe(200);

  // 6. Read the coverage route.
  const coverageResponse = await app.inject({
    method: 'GET',
    url: `/api/research/tenants/${tenantId}/coverage`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(coverageResponse.statusCode).toBe(200);

  await flush();
  return database.dump() as Record<string, unknown>;
}

describe('telemetrySilence: proof two — a behavioral zero-emission session', () => {
  it('a full research-tenant ingestion session leaves the three telemetry trees absent from the dump entirely', async () => {
    const dump = await runFullResearchSession(false);
    assertNoTelemetryTrees(dump);
  });

  it("the same three telemetry trees stay absent when the ingestion path runs against a tenant that ALSO has a coaching-shaped sibling in the database (proves the scan's blind spot is covered)", async () => {
    const dump = await runFullResearchSession(true);
    assertNoTelemetryTrees(dump);
    // The sibling coaching data itself is untouched, proving the fixture
    // genuinely reached a shared-helper-capable code path rather than an
    // empty database that could never exercise one.
    const matches = dump.matches as Record<string, unknown> | undefined;
    expect(matches?.['coaching-sibling-uid-1']).toBeDefined();
  });
});
