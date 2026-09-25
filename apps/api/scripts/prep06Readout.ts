/**
 * PREP-06 READOUT — Phase 39 Plan 02 (D-14/D-19,
 * `.planning/phases/39-evidence-grounded-prep-debrief-spine/39-CONTEXT.md`).
 *
 * OWNER-RUN ONLY. Claude never runs this script and never sees
 * `INTERNAL_JOBS_SECRET` — see `docs/prep06-readout-runbook.md` for the
 * owner's instructions. This is a thin composition root: it makes the one
 * network call, hands the response to the PURE `computeReadout`
 * (`prep06ReadoutCore.ts`), and prints the result. All arithmetic lives in
 * that pure module, proven by its own unit tests without a network call.
 *
 * REQUIRES, both read from `process.env` ONLY — never a CLI argument (a
 * flag lands in shell history and in every `ps` listing on the machine):
 *
 *   PREP06_API_BASE_URL    the API origin, e.g. https://grandfinals.gg
 *   INTERNAL_JOBS_SECRET   the shared secret sent as X-Internal-Jobs-Secret
 *
 * Usage, from the repo root:
 *
 *   PREP06_API_BASE_URL=https://grandfinals.gg \
 *   INTERNAL_JOBS_SECRET=<the real secret> \
 *     pnpm --filter @smash-tracker/api exec tsx scripts/prep06Readout.ts --days 7
 *
 * Accepts exactly ONE CLI flag, `--days` — bounded by the route's own
 * documented [1, 14] range (`apps/api/src/routes/internalJobs.ts`'s
 * `funnelReadoutQuerySchema`); never widened here. Defaults to 7.
 *
 * Makes EXACTLY ONE network call:
 * `GET {PREP06_API_BASE_URL}/internal/jobs/funnel-readout?days=N` with the
 * secret sent as the `X-Internal-Jobs-Secret` header. On a non-200 response,
 * prints the HTTP status only — never the response body (which could echo
 * request context back) and never the request headers (which carry the
 * secret).
 *
 * PRINTS ONLY: the window, one row per day (day, method, reconcile%,
 * duplicate%, numerator, denominator), the method mix, and the footnotes —
 * every printed value is composed from `computeReadout`'s return value plus
 * static labels. NEVER prints: a uid, an opponent tag, an event payload, a
 * header value, or a URL with the secret embedded in it.
 */
import type { FunnelReadoutResult } from '../src/jobs/funnelReadout.js';
import { RECONCILED_EVENT_NAMES } from '../src/jobs/reconcile.js';
import { computeReadout, type Readout } from './prep06ReadoutCore.js';

const INTERNAL_JOBS_SECRET_HEADER = 'x-internal-jobs-secret';
const MIN_DAYS = 1;
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;

/** Reads `--days N` off argv; bounded to the route's own [1, 14] range, defaulting to 7. Throws on anything else — never silently clamps or widens. */
function readDaysFlag(argv: string[]): number {
  const index = argv.indexOf('--days');
  if (index < 0) {
    return DEFAULT_DAYS;
  }
  const raw = argv[index + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
    throw new Error(
      `--days must be an integer between ${MIN_DAYS} and ${MAX_DAYS} (got: ${raw ?? 'missing'})`,
    );
  }
  return parsed;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

/** Every printed value comes from `readout` (the pure core's return value) plus static labels — never a raw response-body field. */
function printReadout(readout: Readout, log: (line: string) => void): void {
  log(
    `window: ${readout.window.firstDay}..${readout.window.lastDay} (${readout.window.dayCount} day(s))`,
  );
  log('day       method        reconcile%    duplicate%    numerator   denominator');
  for (const day of readout.days) {
    log(
      `${day.day}  ${day.method.padEnd(12)}  ${formatPercent(day.reconcilePercent).padEnd(12)}  ` +
        `${formatPercent(day.duplicatePercent).padEnd(12)}  ${String(day.numerator).padEnd(10)}  ${day.denominator}`,
    );
    log(`  note: ${day.note}`);
  }
  log(`methodMix: exact=${readout.methodMix.exact} approximate=${readout.methodMix.approximate}`);
  for (const footnote of readout.footnotes) {
    log(`footnote: ${footnote}`);
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const apiBaseUrl = process.env.PREP06_API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error(
      'PREP06_API_BASE_URL is required (the API origin, e.g. https://grandfinals.gg) — export it in your own shell, it is never read from a flag',
    );
  }
  // Read at invocation time from process.env ONLY — never a CLI argument
  // (docs/prep06-readout-runbook.md states the same rule to the owner).
  const secret = process.env.INTERNAL_JOBS_SECRET;
  if (!secret) {
    throw new Error(
      'INTERNAL_JOBS_SECRET is required — export it in your own shell, it is never read from a flag',
    );
  }

  const days = readDaysFlag(process.argv.slice(2));
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/internal/jobs/funnel-readout?days=${days}`;

  const response = await fetch(url, {
    headers: { [INTERNAL_JOBS_SECRET_HEADER]: secret },
  });

  if (!response.ok) {
    // Status only — never the response body or the request headers, either
    // of which could leak request context or the secret into a log.
    console.error(`funnel-readout request failed: HTTP ${response.status}`);
    process.exitCode = 1;
    return;
  }

  const result = (await response.json()) as FunnelReadoutResult;
  const readout = computeReadout(result, RECONCILED_EVENT_NAMES);
  printReadout(readout, (line) => console.log(line));
}

if (process.argv[1] && process.argv[1].endsWith('prep06Readout.ts')) {
  void main().catch((error: unknown) => {
    // Never echo request headers here — the secret must never reach a log.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
