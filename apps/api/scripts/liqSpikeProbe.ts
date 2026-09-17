/**
 * Phase 36 Plan 07 (LIQ-01): the thin CLI composition root for the
 * Liquipedia research spike core (`liqSpikeProbeCore.ts`). This is the ONLY
 * place in this phase permitted to hand the Liquipedia client a real network
 * fetch and the REAL RTDB-backed distributed limiter — a spike run against a
 * process-local limiter would not be evidence about the SHARED request
 * budget every other Liquipedia consumer (the shipped enrichment CLI) also
 * draws from (T-36-07-01).
 *
 * OWNER-RUN ONLY (D-22/D-23; see the phase's Task 2 checkpoint). Issues at
 * most twelve `action=query` requests total across the three bounded target
 * families, never an `action=parse`/`action=expandtemplates` request, and
 * touches no allowlist.
 *
 * Usage, from the repo root:
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/liqSpikeProbe.ts \
 *     --out apps/api/liq-spike-report.json
 *
 * Requires `LIQUIPEDIA_CONTACT` and `FIREBASE_DATABASE_URL` in
 * `apps/api/.env` (both already present for the shipped enrichment CLI) and
 * the owner's local Application Default Credentials. Prints per-family
 * verdicts and the request-budget summary; prints no page content. The
 * report file itself is gitignored (`apps/api/liq-spike-report*.json`) —
 * Task 3 sanitizes the samples worth keeping into the committed fixture
 * corpus.
 */
import { writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { getLiquipediaConfig, loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import { createLiquipediaLimiter } from '../src/liquipedia/limiter.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import { LIQ_SPIKE_TARGETS, runLiqSpike, type LiqSpikeReport } from './liqSpikeProbeCore.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Reads one optional `--name value` pair off argv. */
function readOptionalFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Wraps the runtime's real fetch with a hard per-request timeout and the
 * operator's shutdown/stall abort signal. Mirrors `enrichDemoAccounts.ts`'s
 * `createBoundedFetch` exactly.
 */
function createBoundedFetch(timeoutMs: number, signal: AbortSignal): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })) as typeof fetch;
}

function printReport(report: LiqSpikeReport, log: (line: string) => void): void {
  for (const page of report.pages) {
    const revisionPart = page.revisionId !== undefined ? `revid=${page.revisionId}` : 'revid=n/a';
    log(
      `[${page.family}] "${page.title}" -> ${page.wikitextVerdict} (${revisionPart}, bytes=${page.byteSize})`,
    );
  }
  for (const discovery of report.discoveries) {
    log(
      `[${discovery.family}] discovered ${discovery.discoveredCount} subpage(s) under "${discovery.prefix}"`,
    );
  }
  log(
    `budget: general=${report.budget.generalRequests} parse-class=${report.budget.parseClassRequests} ` +
      `minObservedGeneralSpacingMs=${report.budget.minObservedGeneralSpacingMs ?? 'n/a'}`,
  );
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const argv = process.argv.slice(2);
  const env = loadEnv();
  const liquipediaConfig = getLiquipediaConfig(env);
  if (!liquipediaConfig) {
    throw new Error('LIQUIPEDIA_CONTACT is required to run the LIQ-01 spike');
  }

  const requestTimeoutRaw = readOptionalFlag(argv, '--request-timeout-ms');
  const requestTimeoutMs =
    requestTimeoutRaw == null ? DEFAULT_REQUEST_TIMEOUT_MS : Number(requestTimeoutRaw);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('--request-timeout-ms must be a positive integer');
  }

  const outPath = readOptionalFlag(argv, '--out');
  if (!outPath) {
    throw new Error('--out <path> is required');
  }

  const { app, database } = initFirebase(env);

  return runWithLifecycle({
    run: async (signal) => {
      const client = createLiquipediaClient({
        config: liquipediaConfig,
        // The REAL RTDB-backed distributed limiter — never a process-local
        // stand-in. A spike run must draw on the SAME shared budget every
        // other Liquipedia consumer draws on (T-36-07-01).
        limiter: createLiquipediaLimiter(database),
        fetchImpl: createBoundedFetch(requestTimeoutMs, signal),
      });

      const report = await runLiqSpike(
        { client, now: () => Date.now(), log: (line) => console.log(line) },
        LIQ_SPIKE_TARGETS,
      );

      printReport(report, (line) => console.log(line));
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[receipt] liq-spike: path=${outPath}`);
      return 0;
    },
    cleanup: async () => {
      // Take RTDB offline first (stops the persistent connection keeping the
      // event loop alive), then await full app teardown.
      database.goOffline();
      await deleteApp(app);
    },
  });
}

// Guarded so `liqSpikeProbeCore.ts`'s exports can be imported by tests
// without triggering a real run.
if (process.argv[1]?.endsWith('liqSpikeProbe.ts')) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
  });
}
