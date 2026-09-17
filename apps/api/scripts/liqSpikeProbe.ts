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
 * most `LIQ_SPIKE_MAX_GENERAL_REQUESTS` `action=query` requests total across
 * the static and discovered target families, never an
 * `action=parse`/`action=expandtemplates` request, and touches no allowlist.
 *
 * Usage, from the repo root:
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/liqSpikeProbe.ts \
 *     --out apps/api/liq-spike-report.json
 *
 * Requires `LIQUIPEDIA_CONTACT` and `FIREBASE_DATABASE_URL` in
 * `apps/api/.env` (both already present for the shipped enrichment CLI) and
 * the owner's local Application Default Credentials. Prints per-family
 * verdicts and the request-budget summary; prints no page content. `--out`
 * MUST match `apps/api/liq-spike-report*.json` AND be confirmed ignored by
 * `git check-ignore -q` — both checked and enforced BEFORE any network
 * request by `assertSafeLiqSpikeOutPath` (`liqSpikeProbeCore.ts`), which
 * returns the resolved absolute path this process writes to, held in
 * `resolvedOutPath` below and never re-resolved a second time (see
 * `outputPathGuard.ts`'s doc comment for the incident this fixes: `pnpm
 * --filter <pkg> exec` sets `cwd` to `apps/api/`, so a second, independent
 * resolution of the documented `--out` value against `process.cwd()`
 * silently targets a different, nonexistent path). Task 3 sanitizes the
 * samples worth keeping into the committed fixture corpus.
 *
 * On ANY failure mid-run (fix 4), this CLI still writes whatever the run
 * had already fetched to `--out` — marked `partial: true` with the error
 * message — before exiting non-zero, so a late failure never discards
 * already-spent request budget along with its evidence.
 */
import { writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { getLiquipediaConfig, loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import { createLiquipediaLimiter } from '../src/liquipedia/limiter.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  LIQ_SPIKE_TARGETS,
  LiqSpikePartialRunError,
  assertSafeLiqSpikeOutPath,
  runLiqSpike,
  type LiqSpikeReport,
} from './liqSpikeProbeCore.js';
import { resolveGitRepoRoot, toRepoRelativePath } from './outputPathGuard.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Reads one optional `--name value` pair off argv. */
function readOptionalFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Wraps the runtime's real fetch with a hard per-request timeout, the
 * operator's shutdown/stall abort signal, AND — the addition this incident
 * requires (fix B) — a `now()` timestamp recorded at the moment THIS
 * function is invoked, i.e. immediately after the limiter has granted the
 * request and `client.ts`'s `issueRequest` is about to dispatch it. This is
 * the only seam available to measure true request-START spacing without
 * modifying `client.ts`/`limiter.ts`: the core (`liqSpikeProbeCore.ts`) only
 * ever sees the higher-level `getWikitext`/`listSubpages` calls, which
 * resolve after the FULL round trip completes, so timing THOSE conflates
 * network latency with the limiter's actual spacing (the owner's first live
 * run showed a meaningless 304ms "spacing" this way, nowhere near the real
 * ~2000ms the limiter enforces).
 */
function createBoundedFetch(
  timeoutMs: number,
  signal: AbortSignal,
  onRequestStart: (startedAtMs: number) => void,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    onRequestStart(Date.now());
    return globalThis.fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  }) as typeof fetch;
}

function printReport(report: LiqSpikeReport, log: (line: string) => void): void {
  for (const page of report.pages) {
    const revisionPart = page.revisionId !== undefined ? `revid=${page.revisionId}` : 'revid=n/a';
    log(
      `[${page.family}] "${page.title}" -> ${page.wikitextVerdict} (${revisionPart}, bytes=${page.byteSize})`,
    );
    // Fix 2: a leak-free structural fingerprint for a page under the size
    // gate, and ALWAYS for a tournament-results/other-entrant-brackets page
    // regardless of size (owner rerun #3, item 4) — so the verdict above is
    // checkable evidence, not another guess. This is the ONLY page-shape
    // detail ever printed — never `rawWikitext` itself, which stays in the
    // gitignored `--out` file.
    if (page.fingerprint) {
      const fp = page.fingerprint;
      const bt = fp.bracketTemplateCounts;
      log(
        `  fingerprint: templates{{=${fp.templateOpenCount} links[[=${fp.internalLinkOpenCount} ` +
          `pipes|=${fp.pipeCount} lines=${fp.lineCount} startsWithRedirect=${fp.startsWithRedirect} ` +
          `firstTemplate=${fp.firstTemplateName ? JSON.stringify(fp.firstTemplateName) : 'n/a'} ` +
          `bracketTemplates={Bracket=${bt.bracketCount} Match=${bt.matchCount} match2=${bt.match2Count} ` +
          `TeamCard=${bt.teamCardCount} PrizePool=${bt.prizePoolCount}} resultsFormat=${page.resultsFormat}`,
      );
    }
  }
  for (const discovery of report.discoveries) {
    // Item 1 (owner rerun #3): EVERY discovered title is printed — public
    // wiki page names, never PII — so the real naming convention is
    // visible even when nothing was accepted.
    log(
      `[${discovery.family}] discovered ${discovery.discoveredCount} subpage(s) under "${discovery.prefix}"` +
        (discovery.discoveredTitles.length > 0
          ? `: ${discovery.discoveredTitles.map((entry) => entry.title).join(', ')}`
          : ''),
    );
    if (discovery.acceptedTitles.length > 0) {
      log(
        `  accepted: ${discovery.acceptedTitles
          .map((title, i) => `"${title}" (reason=${discovery.acceptedReasons[i]})`)
          .join(', ')}`,
      );
    }
  }
  for (const normalization of report.normalizations) {
    log(`[${normalization.family}] normalized "${normalization.from}" -> "${normalization.to}"`);
  }
  for (const redirect of report.redirectsFollowed) {
    log(`[${redirect.family}] redirected "${redirect.from}" -> "${redirect.to}"`);
  }
  for (const outcome of report.familyOutcomes) {
    log(
      `[${outcome.family}] ${outcome.status}` +
        (outcome.reason ? `: ${outcome.reason}` : '') +
        (outcome.sampledTitles.length > 0 ? ` (${outcome.sampledTitles.join(', ')})` : ''),
    );
  }
  log(
    `budget: general=${report.budget.generalRequests}/${report.budget.maxGeneralRequests} ` +
      `parse-class=${report.budget.parseClassRequests} budgetExhausted=${report.budget.budgetExhausted} ` +
      `minObservedGeneralStartSpacingMs=${report.budget.minObservedGeneralStartSpacingMs ?? 'n/a'} ` +
      `minObservedGeneralCompletionSpacingMs=${report.budget.minObservedGeneralCompletionSpacingMs ?? 'n/a'}`,
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

  // WR-03/D-28: refuse an unsafe `--out` before any network request. The
  // RESOLVED ABSOLUTE PATH returned here is the ONLY path this process ever
  // writes to (fix A/WR-05) — never re-resolve `outPath` a second time.
  // `pnpm --filter <pkg> exec` sets `cwd` to `apps/api/`, so a second,
  // independent resolution of this same relative string against
  // `process.cwd()` would silently target a different, nonexistent path —
  // exactly what made the owner's first live run fail with ENOENT after it
  // had already spent its Liquipedia request budget.
  const repoRoot = resolveGitRepoRoot();
  const resolvedOutPath = assertSafeLiqSpikeOutPath({ outPath, repoRoot });
  const generalRequestStartTimestampsMs: number[] = [];

  const { app, database } = initFirebase(env);

  return runWithLifecycle({
    run: async (signal) => {
      const client = createLiquipediaClient({
        config: liquipediaConfig,
        // The REAL RTDB-backed distributed limiter — never a process-local
        // stand-in. A spike run must draw on the SAME shared budget every
        // other Liquipedia consumer draws on (T-36-07-01).
        limiter: createLiquipediaLimiter(database),
        fetchImpl: createBoundedFetch(requestTimeoutMs, signal, (startedAtMs) =>
          generalRequestStartTimestampsMs.push(startedAtMs),
        ),
      });

      let report: LiqSpikeReport;
      try {
        report = await runLiqSpike(
          {
            client,
            now: () => Date.now(),
            log: (line) => console.log(line),
            generalRequestStartTimestampsMs,
          },
          LIQ_SPIKE_TARGETS,
        );
      } catch (error) {
        // Fix 4: on ANY failure — including one that only surfaces after
        // real pages were already fetched — still write whatever evidence
        // `runLiqSpike` gathered before exiting non-zero. The owner must
        // never again lose an entire run's fetched evidence (and spent
        // request budget) to a late failure, the way the first live run's
        // write-path bug did.
        if (error instanceof LiqSpikePartialRunError) {
          printReport(error.partialReport, (line) => console.log(line));
          const partialPayload = {
            ...error.partialReport,
            partial: true,
            error: error.message,
          };
          await writeFile(resolvedOutPath, JSON.stringify(partialPayload, null, 2), 'utf8');
          console.log(
            `[receipt] liq-spike (PARTIAL — run failed): path=${toRepoRelativePath(resolvedOutPath, repoRoot)}`,
          );
        }
        throw error;
      }

      printReport(report, (line) => console.log(line));

      // The SAME resolved absolute path validated above, before any
      // network request — never a second, independent resolution.
      await writeFile(resolvedOutPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[receipt] liq-spike: path=${toRepoRelativePath(resolvedOutPath, repoRoot)}`);
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
