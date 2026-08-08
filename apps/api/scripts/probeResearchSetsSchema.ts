import { writeFile } from 'node:fs/promises';
import {
  fetchResearchSetsPage,
  fetchResearchSetsProbePage,
  RESEARCH_SETS_PER_PAGE,
  StartggApiError,
  type StartggResearchSet,
} from '../src/startgg/client.js';
import {
  compareEntrantSizeProbe,
  formatResearchProbeReport,
  summarizeResearchSetsProbe,
} from '../src/startgg/researchProbe.js';

/**
 * Phase 30 Plan 02, Task 3 — the live schema smoke probe
 * (`pnpm exec tsx scripts/probeResearchSetsSchema.ts --player-id <id>
 * [--pages <n>] [--per-page <n>] [--updated-after <epochSeconds>]
 * [--probe-entrant-size] [--out <path>]`).
 *
 * Governance boundary (D-18): this script issues READ-ONLY public-data
 * queries through the OFFICIAL start.gg API with the server token, contacts
 * no player, publishes nothing, and is the only file in this phase intended
 * to touch the live API before an owner-run backfill. It is an owner/admin
 * step — see the plan's human-check verify item.
 *
 * Answers 30-RESEARCH.md's Assumption A5 and Open Questions 1-3 before any
 * pipeline is built on unverified field names: this is a thin I/O shell
 * over the tested `researchProbe.ts` folding logic — this file itself is
 * not unit-tested (it has no pure logic left; every branch below is either
 * argv/env I/O or a single provider call).
 */

const MAX_PAGES = 3;
/** Fixed pause between requests so a 3-page probe (plus the optional entrant-size probe) cannot approach the published 80 req/60s limit. */
const INTER_REQUEST_PAUSE_MS = 1100;

interface CliArgs {
  playerId: string;
  pages: number;
  perPage: number;
  updatedAfter?: number;
  probeEntrantSize: boolean;
  outPath?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): CliArgs {
  let playerId: string | undefined;
  let pages = 1;
  let perPage = RESEARCH_SETS_PER_PAGE;
  let updatedAfter: number | undefined;
  let probeEntrantSize = false;
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--player-id') {
      playerId = argv[i + 1];
      i += 1;
    } else if (arg === '--pages') {
      const parsed = Number(argv[i + 1]);
      pages = Number.isFinite(parsed) ? parsed : pages;
      i += 1;
    } else if (arg === '--per-page') {
      const parsed = Number(argv[i + 1]);
      perPage = Number.isFinite(parsed) && parsed > 0 ? parsed : perPage;
      i += 1;
    } else if (arg === '--updated-after') {
      const parsed = Number(argv[i + 1]);
      updatedAfter = Number.isFinite(parsed) ? parsed : undefined;
      i += 1;
    } else if (arg === '--probe-entrant-size') {
      probeEntrantSize = true;
    } else if (arg === '--out') {
      outPath = argv[i + 1];
      i += 1;
    }
  }

  if (playerId === undefined || playerId.length === 0) {
    console.error('--player-id <id> is required');
    process.exit(1);
  }

  return {
    playerId,
    // Hard-capped at 3 regardless of the requested value — the operator
    // cannot raise this from the command line (D-19: bounded, never a
    // provoked stress test).
    pages: Math.min(Math.max(1, pages), MAX_PAGES),
    perPage,
    ...(updatedAfter != null ? { updatedAfter } : {}),
    probeEntrantSize,
    ...(outPath ? { outPath } : {}),
  };
}

async function main(): Promise<void> {
  // Never falls back to an empty token — a probe against an unauthenticated
  // endpoint would fail with a confusing 401, not the schema-divergence
  // signal this script exists to surface.
  const token = process.env.STARTGG_API_TOKEN;
  if (!token) {
    console.error('STARTGG_API_TOKEN is required in the environment');
    process.exit(2);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const fetchedPages: { requestedPerPage: number; sets: StartggResearchSet[] }[] = [];

  try {
    for (let page = 1; page <= args.pages; page += 1) {
      if (page > 1) {
        await sleep(INTER_REQUEST_PAUSE_MS);
      }
      const result = await fetchResearchSetsPage(
        token,
        args.playerId,
        page,
        args.perPage,
        args.updatedAfter != null ? { updatedAfter: args.updatedAfter } : {},
      );
      fetchedPages.push({ requestedPerPage: args.perPage, sets: result.sets });
    }
  } catch (err) {
    // D-19: a rate-limit rejection is RECORDED here and the script exits —
    // it never backs off and retries. No retry loop exists in this file.
    if (err instanceof StartggApiError && err.status === 429) {
      console.error(
        `start.gg rate-limit rejection (status 429). Retry-After header: ${err.retryAfter ?? '(not present)'}`,
      );
      console.error(
        'Recorded per D-19 — this is observed evidence, not a probe failure. Stopping without retry.',
      );
      process.exit(3);
      return;
    }
    // A StartggApiError with no `.status` came from the 2xx-with-GraphQL-
    // errors branch of `gql()` — the exact shape a live schema divergence
    // (30-RESEARCH.md Assumption A5) produces: an unknown field/argument on
    // a request that otherwise received a 2xx response.
    if (err instanceof StartggApiError && err.status === undefined) {
      console.error('GraphQL validation error — a queried field may not exist on the live schema:');
      console.error(err.message);
      console.error(
        'Fallback: remove the offending member from RESEARCH_SETS_QUERY and researchSetsPageSchema, ' +
          'record the divergence in 30-COVERAGE-AUDIT.md, and fall back to the documented secondary ' +
          'signal — displayScore pattern matching for a missing isDisqualified, completedAt plus games ' +
          'presence for a missing state.',
      );
      process.exit(4);
      return;
    }
    console.error('Unexpected start.gg probe failure:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  // The single extra request that answers Open Question 3 (review C2-A1) —
  // counts against the same inter-request pause and the same page cap.
  let entrantSizeComparison = null;
  if (args.probeEntrantSize) {
    await sleep(INTER_REQUEST_PAUSE_MS);
    const firstPageUnfiltered = fetchedPages[0]?.sets ?? [];
    try {
      const probeResult = await fetchResearchSetsProbePage(
        token,
        args.playerId,
        1,
        args.perPage,
        1,
      );
      entrantSizeComparison = compareEntrantSizeProbe(firstPageUnfiltered, probeResult.sets);
    } catch (err) {
      if (err instanceof StartggApiError) {
        // An unknown-argument rejection is the EXPECTED negative outcome —
        // converted to the unavailable verdict, never treated as a probe
        // failure (review C2-A1). Falls through to a normal exit 0 below.
        entrantSizeComparison = compareEntrantSizeProbe(firstPageUnfiltered, null);
      } else {
        throw err;
      }
    }
  }

  const summary = { ...summarizeResearchSetsProbe(fetchedPages), entrantSizeComparison };
  console.log(formatResearchProbeReport(summary));

  if (args.outPath) {
    await writeFile(args.outPath, JSON.stringify(summary, null, 2), 'utf-8');
  }
}

void main();
