import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  creditLedgerEntrySchema,
  eventEnvelopeSchema,
  reportJobStatusSchema,
  type EventEnvelope,
} from '@smash-tracker/shared';
import { dayShardKey } from '../events/ledger.js';

/**
 * MEAS-07: the nightly reconciliation job. Cross-checks a single bounded
 * day-shard of durable domain transitions (Stripe fulfillment, credit
 * ledger, report-job transitions — via their `*ByDay` mirrors written
 * alongside the domain write in Plans 02/03) against the canonical
 * `eventLedger` day-shard, landing any drift in `reconciliationExceptions`.
 *
 * Structural Pitfall-2 guarantee (RESEARCH.md): this module imports ONLY
 * `dayShardKey` from `events/ledger.ts` — it never imports `createEvent`, so
 * a reconciliation run can never re-derive/duplicate a canonical event. Every
 * write this module makes targets `reconciliationExceptions/{day}/*` only;
 * `eventLedger` and every domain record are read-only here.
 *
 * Every read below is a single bounded day-shard (`.../${day}`), never a
 * bare full-tree `.get()` — this is the T-10-06-02 mitigation (bounded
 * blast radius) and is asserted directly by a source-shape test.
 */

export interface ReconcileResult {
  checked: number;
  missing: number;
  phantom: number;
  duplicate: number;
}

export interface ReconcileOptions {
  /** `yyyymmdd` day-shard to reconcile; defaults to yesterday (UTC). */
  day?: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Local shape for `reportJobsByDay/{day}/{jobId}` — not a shared-package schema (operational mirror only). */
const reportJobDayEntrySchema = z.object({
  uid: z.string().min(1),
  status: reportJobStatusSchema,
});

/**
 * B-class event names this reconciliation pass is responsible for. Used to
 * scope the phantom-event pass so unrelated ledger entries (e.g. a future
 * D/X event this job doesn't yet cross-reference) never false-positive as
 * orphaned.
 */
const RECONCILED_EVENT_NAMES = new Set<string>([
  'credits_granted',
  'checkout_completed',
  'credit_spent',
  'credit_refunded',
  'report_started',
  'report_completed',
  'report_failed',
]);

interface LedgerEntry {
  key: string;
  envelope: EventEnvelope;
}

function yesterdayShardKey(): string {
  return dayShardKey(Date.now() - ONE_DAY_MS);
}

/** Correlation id embedded as the prefix of a B-class `causationId` (`${id}:${transition}`). */
function subjectRefOf(causationId: string): string {
  return causationId.split(':')[0] ?? causationId;
}

export async function runReconcile(
  database: Database,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const day = opts.day ?? yesterdayShardKey();

  const [
    ledgerSnapshot,
    stripeMirrorSnapshot,
    creditMirrorSnapshot,
    reportMirrorSnapshot,
    outboxSnapshot,
  ] = await Promise.all([
    database.ref(`eventLedger/${day}`).get(),
    database.ref(`processedStripeEventsByDay/${day}`).get(),
    database.ref(`creditLedgerByDay/${day}`).get(),
    database.ref(`reportJobsByDay/${day}`).get(),
    database.ref(`outboxPending/${day}`).get(),
  ]);

  // Safe-parse-and-skip every stored ledger row — one corrupt row (shape
  // drift, a future schema bump not yet backfilled, hand-edited data) must
  // never fail the whole reconciliation run.
  const ledgerRaw = (ledgerSnapshot.val() ?? {}) as Record<string, unknown>;
  const ledgerEntries: LedgerEntry[] = [];
  for (const [key, value] of Object.entries(ledgerRaw)) {
    const parsed = eventEnvelopeSchema.safeParse(value);
    if (parsed.success) {
      ledgerEntries.push({ key, envelope: parsed.data });
    }
  }

  const byCausationId = new Map<string, LedgerEntry[]>();
  for (const entry of ledgerEntries) {
    const list = byCausationId.get(entry.envelope.causationId) ?? [];
    list.push(entry);
    byCausationId.set(entry.envelope.causationId, list);
  }

  const exceptionsRef = database.ref(`reconciliationExceptions/${day}`);
  const result: ReconcileResult = { checked: 0, missing: 0, phantom: 0, duplicate: 0 };

  // Every correlation id this run confirmed has SOME durable domain record —
  // the phantom-event pass below uses this to decide "orphaned" vs "known".
  const knownDomainSubjects = new Set<string>();

  async function writeException(
    kind: string,
    subjectRef: string,
    expected: unknown,
    actual: unknown,
  ): Promise<void> {
    // NEVER a literal `null` for expected/actual — RTDB strips null-valued
    // keys on write (the codebase's own established null-stripping pitfall),
    // which would silently drop the field from the stored exception row.
    await exceptionsRef.push().set({
      kind,
      subjectRef,
      expected,
      actual,
      detectedAt: Date.now(),
    });
  }

  async function expectEvent(
    subjectRef: string,
    eventName: string,
    causationId: string,
  ): Promise<void> {
    result.checked += 1;
    knownDomainSubjects.add(subjectRef);
    const matches = byCausationId.get(causationId) ?? [];
    const found = matches.some((match) => match.envelope.eventName === eventName);
    if (!found) {
      result.missing += 1;
      await writeException('missing_event', subjectRef, { eventName, causationId }, 'absent');
    }
  }

  // 1. Stripe fulfillment mirror: a processed Stripe event implies BOTH
  // `credits_granted` (billing/credits.ts's fulfillCheckoutSession) and
  // `checkout_completed` (routes/billing.ts's fulfillAndAck) were emitted.
  const stripeMirror = (stripeMirrorSnapshot.val() ?? {}) as Record<string, unknown>;
  for (const stripeEventId of Object.keys(stripeMirror)) {
    await expectEvent(stripeEventId, 'credits_granted', `${stripeEventId}:credits_granted`);
    await expectEvent(stripeEventId, 'checkout_completed', `${stripeEventId}:checkout_completed`);
  }

  // 2. Credit ledger mirror: every purchase/spend/refund entry implies its
  // matching B event.
  const creditMirror = (creditMirrorSnapshot.val() ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  for (const entriesForUid of Object.values(creditMirror)) {
    for (const raw of Object.values(entriesForUid ?? {})) {
      const parsed = creditLedgerEntrySchema.safeParse(raw);
      if (!parsed.success) {
        continue; // safe-parse-and-skip a corrupt day-mirror row
      }
      const entry = parsed.data;
      if (entry.type === 'purchase') {
        await expectEvent(entry.ref, 'credits_granted', `${entry.ref}:credits_granted`);
      } else if (entry.type === 'spend') {
        await expectEvent(entry.ref, 'credit_spent', `${entry.ref}:credit_spent`);
      } else if (entry.type === 'refund') {
        await expectEvent(entry.ref, 'credit_refunded', `${entry.ref}:credit_refunded`);
      }
    }
  }

  // 3. Report-job transitions mirror. `reportJobsByDay/{day}/{jobId}` only
  // retains the LAST status written that day, so only the terminal-for-the-
  // day transition is checked — intermediate transitions (e.g. `running`
  // followed same-day by `succeeded`) are not double-counted as missing.
  const reportMirror = (reportMirrorSnapshot.val() ?? {}) as Record<string, unknown>;
  for (const [jobId, raw] of Object.entries(reportMirror)) {
    const parsed = reportJobDayEntrySchema.safeParse(raw);
    if (!parsed.success) {
      continue; // safe-parse-and-skip
    }
    const { status } = parsed.data;
    knownDomainSubjects.add(jobId);
    if (status === 'running') {
      await expectEvent(jobId, 'report_started', `${jobId}:report_started`);
    } else if (status === 'succeeded') {
      await expectEvent(jobId, 'report_completed', `${jobId}:report_completed`);
    } else if (status === 'failed') {
      // `report_failed` fires with causationId `${jobId}:report_failed`
      // from the owning request, or `${jobId}:report_failed:sweep` from the
      // stuck-job sweep — either satisfies the expectation.
      result.checked += 1;
      const hasReportFailed = ledgerEntries.some(
        (entry) =>
          entry.envelope.eventName === 'report_failed' &&
          entry.envelope.causationId.startsWith(`${jobId}:report_failed`),
      );
      if (!hasReportFailed) {
        result.missing += 1;
        await writeException(
          'missing_event',
          jobId,
          { eventName: 'report_failed', causationId: `${jobId}:report_failed*` },
          'absent',
        );
      }
    }
  }

  // 4. Phantom-event pass: a reconciled-class ledger event whose correlation
  // id never showed up in ANY domain mirror above.
  for (const entry of ledgerEntries) {
    if (!RECONCILED_EVENT_NAMES.has(entry.envelope.eventName)) {
      continue;
    }
    const subjectRef = subjectRefOf(entry.envelope.causationId);
    if (!knownDomainSubjects.has(subjectRef)) {
      result.phantom += 1;
      await writeException('phantom_event', subjectRef, 'domain_transition', {
        eventName: entry.envelope.eventName,
        causationId: entry.envelope.causationId,
      });
    }
  }

  // 5. Duplicate-event pass: more than one ledger row sharing
  // (eventName, causationId, schemaVersion) — structurally prevented by
  // `createEvent()`'s dedup transaction; this is the explicit
  // assume-it-can-still-happen backstop.
  const duplicateGroups = new Map<string, LedgerEntry[]>();
  for (const entry of ledgerEntries) {
    const groupKey = `${entry.envelope.eventName}:${entry.envelope.causationId}:${entry.envelope.schemaVersion}`;
    const list = duplicateGroups.get(groupKey) ?? [];
    list.push(entry);
    duplicateGroups.set(groupKey, list);
  }
  for (const [groupKey, entries] of duplicateGroups.entries()) {
    if (entries.length > 1) {
      result.duplicate += 1;
      await writeException('duplicate_event', groupKey, 1, entries.length);
    }
  }

  // outboxPending is read (per this job's own contract) so a maintainer can
  // see pending-projection volume alongside reconciliation drift; it does
  // not currently produce its own exception class (GA4 projection failures
  // are covered by the outbox's own retry/backoff, not this job).
  result.checked += Object.keys((outboxSnapshot.val() ?? {}) as Record<string, unknown>).length;

  return result;
}
