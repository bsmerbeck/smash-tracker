/**
 * Phase 39 Plan 02 (PREP-06, D-19 in `.planning/phases/39-evidence-grounded-prep-debrief-spine/39-CONTEXT.md`):
 * the PURE computation behind the PREP-06 soak readout. No network, no
 * `process.env`, no RTDB import anywhere in this module — every input is a
 * value already returned by `runFunnelReadout` (`apps/api/src/jobs/funnelReadout.ts`).
 * That purity is what lets the owner-run entry point (`prep06Readout.ts`)
 * stay a thin composition root, and what lets this module's own test suite
 * prove the arithmetic without a network call or the owner's secret.
 *
 * Reports BOTH numbers, each labelled with its own denominator (D-19):
 *
 * - EXACT: when a day carries a persisted `reconcileSummary`
 *   (`reconcile.ts`'s additive `reconcileSummaries/{day}` write) WITH its
 *   `reconciledUnits` field, the denominator is the units that run actually
 *   reconciled plus its phantom and duplicate exceptions — never the
 *   outbox-pending rows its `checked` also counts (code review API-WR-06).
 * - APPROXIMATE: when a day has no usable persisted summary (an older shard,
 *   a day served by an API revision that predates the writer, or a summary
 *   written before `reconciledUnits` existed), the
 *   denominator is `eventCounts` restricted to `RECONCILED_EVENT_NAMES` —
 *   which works against production exactly as deployed today, and is a
 *   genuine approximation because `eventCounts` counts raw ledger rows while
 *   `checked` counts correlation-id-grouped units (39-RESEARCH.md Common
 *   Pitfalls §3).
 *
 * HONESTY RULES (code review API-WR-05/06): only a persisted summary can
 * prove a day had zero exceptions, so an approximate day with no exception
 * rows reads `n/a` ("no reconcile evidence"), never 100%; the partial
 * CURRENT UTC day (the nightly reconcile covers yesterday) is labelled and
 * carries no percentage; and no numerator is ever negative.
 *
 * A window is NEVER blended into one percentage across the two methods —
 * `computeReadout` reports `methodMix` and leaves every `DayMetric` labelled
 * by its own method; nothing here sums an exact day and an approximate day
 * into one aggregate percentage.
 */
import { z } from 'zod';
import type { FunnelReadoutDay, FunnelReadoutResult } from '../src/jobs/funnelReadout.js';
import { RECONCILE_EXCEPTION_KINDS } from '../src/jobs/reconcile.js';

// C1-M7: derived from the IMPORTED tuple by position, never retyped as a
// fresh string literal — a second hand-copied `'duplicate_event'` here is
// exactly the drift class the export exists to prevent.
const [, , DUPLICATE_EVENT_KIND] = RECONCILE_EXCEPTION_KINDS;

export type ReconcileMethod = 'exact' | 'approximate';

export interface DayMetric {
  day: string;
  reconcilePercent: number | null;
  duplicatePercent: number | null;
  method: ReconcileMethod;
  numerator: number;
  denominator: number;
  note: string;
}

export interface ReadoutWindow {
  firstDay: string;
  lastDay: string;
  dayCount: number;
}

export interface ReadoutMethodMix {
  exact: number;
  approximate: number;
}

export interface Readout {
  days: DayMetric[];
  window: ReadoutWindow;
  methodMix: ReadoutMethodMix;
  footnotes: string[];
}

/** The UTC `yyyymmdd` day key of `epochMs` — the same shape `dayShardKey` (events/ledger.ts) produces, inlined so this module stays import-pure. */
function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, '');
}

const CLAMPED_NOTE =
  ' The numerator is clamped at 0 because the exceptions outnumber the units counted.';

/**
 * Computes one day's metric.
 *
 * EXACT arm: only when `day.reconcileSummary` carries `reconciledUnits`. The
 * denominator is `reconciledUnits + phantom + duplicate` (every unit the run
 * judged, plus the extra ledger anomalies it found) and the numerator is
 * `reconciledUnits - missing`, clamped at 0. The outbox-pending rows the
 * run's `checked` also counts are never in the denominator (API-WR-06). A 0
 * denominator returns null percentages with an explanatory note.
 *
 * APPROXIMATE arm: every other day. The denominator is `day.eventCounts`
 * restricted to `reconciledEventNames`, and the numerator subtracts
 * `day.exceptionCounts` over the IMPORTED `RECONCILE_EXCEPTION_KINDS` (never
 * hand-copied — C1-M7), clamped at 0. A day with NO exception rows reads
 * `null`: without a persisted summary, "reconciled with no exceptions" and
 * "never reconciled" look identical (API-WR-05). A 0 denominator returns
 * null percentages with an explanatory note.
 *
 * `options.partialDay` — the current UTC day of the readout: labelled, with
 * no percentage (the nightly reconcile covers yesterday).
 */
export function computeDayMetric(
  day: FunnelReadoutDay,
  reconciledEventNames: ReadonlySet<string>,
  options: { partialDay?: string } = {},
): DayMetric {
  const metric = computeDayMetricIgnoringPartialDay(day, reconciledEventNames);
  if (options.partialDay !== undefined && day.day === options.partialDay) {
    return {
      ...metric,
      reconcilePercent: null,
      duplicatePercent: null,
      note:
        `partial day — ${day.day} is the current UTC day of this readout; the nightly reconcile ` +
        'covers yesterday, so this day is excluded from every percentage.',
    };
  }
  return metric;
}

function computeDayMetricIgnoringPartialDay(
  day: FunnelReadoutDay,
  reconciledEventNames: ReadonlySet<string>,
): DayMetric {
  const { reconcileSummary } = day;
  if (reconcileSummary && typeof reconcileSummary.reconciledUnits === 'number') {
    const { reconciledUnits, missing, phantom, duplicate } = reconcileSummary;
    const outbox = reconcileSummary.outboxPending ?? 0;
    const denominator = reconciledUnits + phantom + duplicate;
    if (denominator === 0) {
      return {
        day: day.day,
        reconcilePercent: null,
        duplicatePercent: null,
        method: 'exact',
        numerator: 0,
        denominator: 0,
        note:
          'exact — the persisted run reconciled 0 units and found no phantom or duplicate, ' +
          'so no percentage is computed.',
      };
    }
    const raw = reconciledUnits - missing;
    const numerator = Math.max(0, raw);
    return {
      day: day.day,
      reconcilePercent: (numerator / denominator) * 100,
      duplicatePercent: (duplicate / denominator) * 100,
      method: 'exact',
      numerator,
      denominator,
      note:
        `exact — denominator is the persisted run's reconciledUnits (${reconciledUnits}) + ` +
        `phantom (${phantom}) + duplicate (${duplicate}); the ${outbox} outbox-pending row(s) ` +
        'its checked count also includes are left out.' +
        (raw < 0 ? CLAMPED_NOTE : ''),
    };
  }

  const legacySummaryPrefix = reconcileSummary
    ? 'the persisted summary predates reconciledUnits (its checked count includes ' +
      'outbox-pending rows), so this day is not reported as exact — '
    : '';

  let denominator = 0;
  for (const [eventName, count] of Object.entries(day.eventCounts)) {
    if (reconciledEventNames.has(eventName)) {
      denominator += count;
    }
  }

  const APPROX_NOTE_SUFFIX =
    "eventCounts counts raw ledger rows while the exact method's reconciled units are " +
    'correlation-id-grouped.';

  if (denominator === 0) {
    return {
      day: day.day,
      reconcilePercent: null,
      duplicatePercent: null,
      method: 'approximate',
      numerator: 0,
      denominator: 0,
      note:
        `${legacySummaryPrefix}approximate — denominator is eventCounts summed over ` +
        `RECONCILED_EVENT_NAMES, which is 0 for this day, so no percentage is computed. ${APPROX_NOTE_SUFFIX}`,
    };
  }

  let exceptionCount = 0;
  for (const kind of RECONCILE_EXCEPTION_KINDS) {
    exceptionCount += day.exceptionCounts[kind] ?? 0;
  }

  if (exceptionCount === 0 && !reconcileSummary) {
    return {
      day: day.day,
      reconcilePercent: null,
      duplicatePercent: null,
      method: 'approximate',
      numerator: 0,
      denominator,
      note:
        `approximate — no reconcile evidence for this day: ${denominator} reconciled-class ` +
        'event row(s) but no exception rows and no persisted summary. Only a persisted ' +
        'summary can prove a day had zero exceptions (a day the reconcile never ran looks ' +
        'identical), so no percentage is computed.',
    };
  }

  const duplicateCount = day.exceptionCounts[DUPLICATE_EVENT_KIND] ?? 0;
  const raw = denominator - exceptionCount;
  const numerator = Math.max(0, raw);

  return {
    day: day.day,
    reconcilePercent: (numerator / denominator) * 100,
    duplicatePercent: (duplicateCount / denominator) * 100,
    method: 'approximate',
    numerator,
    denominator,
    note:
      `${legacySummaryPrefix}approximate — denominator is eventCounts summed over ` +
      `RECONCILED_EVENT_NAMES (${denominator}). ${APPROX_NOTE_SUFFIX}` +
      (raw < 0 ? CLAMPED_NOTE : ''),
  };
}

/** Verbatim, in order — see `computeReadout`'s doc comment. */
const FLIP_RULE_FOOTNOTE =
  "Reference, not an enforced threshold: v2.5's flip rule reads >=98% reconcile and <0.5% " +
  'duplicates as the bar the owner compares these numbers against at the 39-14 checkpoint before ' +
  'deciding PREP_PAID_REPORTS_ENABLED — this script does not compute a pass/fail verdict.';

const APPROXIMATE_METHOD_FOOTNOTE =
  'Approximate method: eventCounts (raw ledger rows for RECONCILED_EVENT_NAMES) as the ' +
  "denominator, minus exceptionCounts over RECONCILE_EXCEPTION_KINDS as the numerator's " +
  'subtraction — an approximation because eventCounts counts raw ledger rows while the exact ' +
  "method's reconciled units are correlation-id-grouped. A day with no exception rows and no " +
  'persisted summary reads n/a, never 100% — it cannot be told apart from a day the reconcile ' +
  'never ran.';

const EXACT_METHOD_FOOTNOTE =
  "Exact method: the persisted reconcile run's reconciledUnits + phantom + duplicate as the " +
  'denominator and reconciledUnits - missing (never below 0) as the numerator; the ' +
  'outbox-pending rows its checked count also includes are left out of both.';

/**
 * Aggregates a `FunnelReadoutResult` into per-day metrics plus a window
 * summary. NEVER computes a single blended percentage across exact and
 * approximate days — `methodMix` reports the split, and each `DayMetric`
 * carries its own `method`.
 *
 * `footnotes` always contains, verbatim and in this order: the v2.5 flip-rule
 * reference (stated as a reference, never enforced here), the approximate
 * method's definition, and — only when `methodMix.approximate > 0` — a
 * sentence naming which days were approximate and why a day can have no
 * summary.
 */
export function computeReadout(
  result: FunnelReadoutResult,
  reconciledEventNames: ReadonlySet<string>,
): Readout {
  const partialDay = utcDayKey(result.generatedAt);
  const days = result.days.map((day) =>
    computeDayMetric(day, reconciledEventNames, { partialDay }),
  );

  const methodMix: ReadoutMethodMix = { exact: 0, approximate: 0 };
  for (const metric of days) {
    methodMix[metric.method] += 1;
  }

  const sortedDayKeys = [...result.days].map((entry) => entry.day).sort();
  const window: ReadoutWindow = {
    firstDay: sortedDayKeys[0] ?? '',
    lastDay: sortedDayKeys[sortedDayKeys.length - 1] ?? '',
    dayCount: result.days.length,
  };

  const footnotes: string[] = [
    FLIP_RULE_FOOTNOTE,
    APPROXIMATE_METHOD_FOOTNOTE,
    EXACT_METHOD_FOOTNOTE,
  ];
  if (result.days.some((day) => day.day === partialDay)) {
    footnotes.push(
      `${partialDay} is the current UTC day of this readout — a partial day the nightly ` +
        'reconcile has not covered yet, so it carries no percentage.',
    );
  }
  if (methodMix.approximate > 0) {
    footnotes.push(
      `${methodMix.approximate} of ${result.days.length} day(s) in this window are ` +
        'approximate — a day has no persisted summary because it is from before this ' +
        "plan's reconcileSummaries writer took effect (the owner's next deploy), or the " +
        'shard predates that deploy.',
    );
  }

  return { days, window, methodMix, footnotes };
}

// ---------------------------------------------------------------------------
// Code review API-WR-07: the owner-run script's request and response checks,
// kept here (pure) so they are proven without a network call or the secret.
// ---------------------------------------------------------------------------

/** Firebase Hosting origins — they rewrite only `/api/**` and `/s/**`, so `/internal/jobs/*` falls through to the SPA shell with a 200. The secret must never be sent there. */
const HOSTING_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^(?:www\.)?grandfinals\.gg$/i,
  /\.web\.app$/i,
  /\.firebaseapp\.com$/i,
];

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Refuses, BEFORE any request is made, a base URL the internal-jobs secret
 * must never be sent to: anything that is not `https:` (plain `http:` is
 * allowed only for a loopback API during local development), and the
 * Firebase Hosting origins, which never route `/internal/jobs/*` to the API.
 * The message names the fix; it never contains the secret.
 */
export function assertSendableBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('PREP06_API_BASE_URL is not a valid URL');
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'PREP06_API_BASE_URL must be an https:// origin — the internal-jobs secret is never sent over plain http',
    );
  }
  if (HOSTING_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new Error(
      'PREP06_API_BASE_URL points at Firebase Hosting, which does not route /internal/jobs/* — ' +
        'use the Cloud Run service URL (see docs/prep06-readout-runbook.md)',
    );
  }
  return url;
}

const countMapSchema = z.record(z.string(), z.number().int().nonnegative());

/** Mirrors the route's `funnelReadoutResultSchema` (`src/routes/internalJobs.ts`); `prep06ReadoutCore.test.ts` proves the two agree. */
const funnelReadoutResponseSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  days: z.array(
    z.object({
      day: z.string(),
      eventCounts: countMapSchema,
      exceptionCounts: countMapSchema,
      pendingProjection: z.number().int().nonnegative(),
      reconcileSummary: z
        .object({
          checked: z.number().int().nonnegative(),
          missing: z.number().int().nonnegative(),
          phantom: z.number().int().nonnegative(),
          duplicate: z.number().int().nonnegative(),
          reconciledUnits: z.number().int().nonnegative().nullish(),
          outboxPending: z.number().int().nonnegative().nullish(),
          generatedAt: z.number().int().nonnegative(),
        })
        .nullish(),
    }),
  ),
  totals: z.object({
    eventCounts: countMapSchema,
    exceptionCounts: countMapSchema,
    pendingProjection: z.number().int().nonnegative(),
  }),
});

export type FunnelReadoutResponseOutcome =
  { ok: true; result: FunnelReadoutResult } | { ok: false; message: string };

/**
 * Validates the funnel-readout response. Every failure message is composed
 * from static text plus the HTTP status only — never the body (which could
 * echo request context back, or be the SPA shell) and never a header.
 */
export function parseFunnelReadoutResponse(response: {
  status: number;
  contentType: string | null;
  bodyText: string;
}): FunnelReadoutResponseOutcome {
  if (response.status !== 200) {
    return { ok: false, message: `funnel-readout request failed: HTTP ${response.status}` };
  }
  const mediaType = (response.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return {
      ok: false,
      message:
        'funnel-readout response was not JSON — PREP06_API_BASE_URL must be the Cloud Run ' +
        'service URL (see docs/prep06-readout-runbook.md)',
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    return { ok: false, message: 'funnel-readout response body was not valid JSON' };
  }
  const parsed = funnelReadoutResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: 'unexpected response shape' };
  }
  const days: FunnelReadoutDay[] = parsed.data.days.map((day) => {
    const { reconcileSummary, ...rest } = day;
    if (!reconcileSummary) {
      return rest;
    }
    const { reconciledUnits, outboxPending, ...summaryRest } = reconcileSummary;
    return {
      ...rest,
      reconcileSummary: {
        ...summaryRest,
        ...(typeof reconciledUnits === 'number' ? { reconciledUnits } : {}),
        ...(typeof outboxPending === 'number' ? { outboxPending } : {}),
      },
    };
  });
  return { ok: true, result: { ...parsed.data, days } };
}
