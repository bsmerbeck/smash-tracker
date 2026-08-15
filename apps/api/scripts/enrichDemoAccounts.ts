/**
 * Owner-only operator for the four ordinary demo accounts. The frozen
 * Phase 30.1 research tenants are intentionally out of scope: this script
 * never targets, archives, or changes their lifecycle.
 *
 * 30.2 reliability gate (owner corrective directive, Gate 1): this file is
 * now a THIN COMPOSITION ROOT. All subcommand logic lives in
 * `enrichDemoAccountsCore.ts` (testable against FakeDatabase, zero
 * network); the guaranteed-termination contract lives in
 * `enrichLifecycle.ts` (try/finally-owned Firebase lifecycle, SIGINT/
 * SIGTERM handling, exit within 10s of any terminal result). Every
 * outbound request is bounded by `--request-timeout-ms` (default 30s) and
 * aborted by the stall watchdog / shutdown signal.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { getLiquipediaConfig, loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import {
  LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
  LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS,
  createLiquipediaLimiter,
  type LiquipediaLimiter,
} from '../src/liquipedia/limiter.js';
import { runEnrichmentBatch } from '../src/research/enrichment/run.js';
import { runEnrichmentOperator, type EnrichmentOperatorDeps } from './enrichDemoAccountsCore.js';
import { runWithLifecycle } from './enrichLifecycle.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function createReadOnlyLimiter(): LiquipediaLimiter {
  let lastGeneral = 0;
  let lastParse = 0;
  const waitFor = async (last: number, interval: number): Promise<number> => {
    const remaining = Math.max(0, last + interval - Date.now());
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return Date.now();
  };
  return {
    async acquire(requestClass, remainingWaitBudgetMs) {
      const startedAt = Date.now();
      if (requestClass === 'parse-class') {
        const wait = Math.max(0, lastParse + LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS - Date.now());
        if (wait > remainingWaitBudgetMs) {
          return { granted: false, waitedMs: 0, reason: 'wait-budget-exceeded' };
        }
        lastParse = await waitFor(lastParse, LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS);
      }
      const generalWait = Math.max(
        0,
        lastGeneral + LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS - Date.now(),
      );
      if (Date.now() - startedAt + generalWait > remainingWaitBudgetMs) {
        return { granted: false, waitedMs: Date.now() - startedAt, reason: 'wait-budget-exceeded' };
      }
      lastGeneral = await waitFor(lastGeneral, LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
      return { granted: true, waitedMs: Date.now() - startedAt };
    },
  };
}

/**
 * Wraps the runtime's real fetch with (a) a hard per-request timeout — no
 * request may hang the operator past `timeoutMs` — and (b) the operator's
 * stall/shutdown abort signal, so an interrupted run stops issuing and
 * waiting on network work immediately.
 */
function createBoundedFetch(timeoutMs: number, signal: AbortSignal): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })) as typeof fetch;
}

/** Reads one optional `--name value` pair off argv without disturbing the core's own parser. */
function readOptionalFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
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
    throw new Error('LIQUIPEDIA_CONTACT is required');
  }
  const requestTimeoutRaw = readOptionalFlag(argv, '--request-timeout-ms');
  const requestTimeoutMs =
    requestTimeoutRaw == null ? DEFAULT_REQUEST_TIMEOUT_MS : Number(requestTimeoutRaw);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('--request-timeout-ms must be a positive integer');
  }

  const { app, database } = initFirebase(env);
  const databaseHost = new URL(env.FIREBASE_DATABASE_URL).host;

  return runWithLifecycle({
    run: (signal) => {
      const deps: EnrichmentOperatorDeps = {
        database,
        databaseHost,
        // This owner CLI is the only production composition root permitted
        // to hand the client the runtime's real network implementation —
        // bounded by the per-request timeout and the shutdown/stall signal.
        buildClient: (kind, clientSignal) =>
          createLiquipediaClient({
            config: liquipediaConfig,
            limiter: kind === 'apply' ? createLiquipediaLimiter(database) : createReadOnlyLimiter(),
            fetchImpl: createBoundedFetch(
              requestTimeoutMs,
              AbortSignal.any([signal, clientSignal]),
            ),
          }),
        runBatch: runEnrichmentBatch,
        now: () => Date.now(),
        log: (line) => console.log(line),
        table: (rows) => console.table(rows),
        readFileText: (path) => readFile(path, 'utf8'),
        writeFileText: (path, content) => writeFile(path, content, 'utf8'),
        hashHex: (value) => createHash('sha256').update(value).digest('hex'),
        signal,
      };
      // Strip the entry-level flag pair before handing argv to the core's
      // strict `--name value` parser.
      const coreArgv = argv.filter(
        (arg, index) =>
          arg !== '--request-timeout-ms' && argv[index - 1] !== '--request-timeout-ms',
      );
      return runEnrichmentOperator(coreArgv, deps);
    },
    cleanup: async () => {
      // Take RTDB offline first (stops the persistent connection keeping the
      // event loop alive), then await full app teardown.
      database.goOffline();
      await deleteApp(app);
    },
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  // The failure happened BEFORE the lifecycle wrapper could own termination
  // (env/config/Firebase init) — nothing long-lived exists yet, but arm the
  // same unref'd backstop so this path can never zombie either.
  setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
});
