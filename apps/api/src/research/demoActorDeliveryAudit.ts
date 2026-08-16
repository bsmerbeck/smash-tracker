import type { Database } from 'firebase-admin/database';
import type { DemoAccountConfig } from '../config/env.js';
import { isDemoAccountSubject } from './demoAccount.js';

/**
 * Phase 30.3 (Gate 6 corrective, defect A3): a STRICTLY READ-ONLY detection
 * helper for delivery tokens that may already have been minted through the
 * actor-versus-client hole this phase closes.
 *
 * The hole: the two delivery mint writers (`createReviewDelivery`,
 * `createSessionDelivery`) refuse when the CLIENT TENANT is a demo subject,
 * but nothing checked the ACTOR. A demo coach (IzAw) who passed an ORDINARY
 * fictional client's tenant id therefore minted a real, publicly resolvable
 * `shareTokens/{token}` — the tenant-scoped guard never fired, because the
 * tenant genuinely was ordinary. Both routes now refuse on `request.uid`
 * before any read, write, or event, so no NEW artifact of this shape can be
 * created. This module finds artifacts that predate that fix.
 *
 * This module NEVER writes, revokes, or deletes anything. Revocation is a
 * judgement call about live client-facing links and belongs to the
 * maintainer, not to an automated sweep — see `describeFindings` for the
 * remediation guidance to hand over with the results.
 *
 * Two independent channels, because neither alone is complete:
 *
 *  1. LEDGER (exact, names the delivery). Every mint against an ORDINARY
 *     tenant emits `review_delivery_created` / `session_delivery_created`
 *     carrying `actorId` — and an ordinary tenant is exactly the case the
 *     hole covers, so for the mints in question the event was NOT
 *     suppressed. Any such envelope whose `actorId` is an allowlisted demo
 *     uid is a direct hit, and its `causationId` (`{parentId}:{deliveryId}`)
 *     names the artifact.
 *  2. MEMBERSHIP (superset, names the exposure surface). Ledger emission is
 *     best-effort and day-sharded — a write failure, a dedup abort, or
 *     retention pruning can lose a row. So the second channel enumerates
 *     every tenant that has a demo uid in `clientMembers/{tenantId}` and
 *     reports the deliveries living under it. This over-reports (an
 *     ordinary co-coach on the same tenant may have minted them
 *     legitimately) and is meant as the bound on what to review by hand,
 *     not as an accusation.
 */

/** The two mint events whose `actorId` identifies a delivery's creator. */
const DELIVERY_MINT_EVENTS = ['review_delivery_created', 'session_delivery_created'] as const;
type DeliveryMintEvent = (typeof DELIVERY_MINT_EVENTS)[number];

/** The delivery trees a tenant-scoped sweep enumerates, and the mint event each corresponds to. */
const DELIVERY_TREES = [
  { tree: 'reviewDeliveries', kind: 'review' },
  { tree: 'sessionDeliveries', kind: 'session' },
] as const;

export interface LedgerHit {
  /** Which mint event named this delivery. */
  eventName: DeliveryMintEvent;
  /** The allowlisted demo uid recorded as the actor. */
  actorId: string;
  /** `{reviewId|sessionId}:{deliveryId}` exactly as the route recorded it. */
  causationId: string;
  /** The `{deliveryId}` half of `causationId`, for locating the record. */
  deliveryId: string;
  /** The `{reviewId|sessionId}` half of `causationId`. */
  parentId: string;
  /** The UTC `yyyymmdd` shard the envelope was found under. */
  day: string;
  occurredAt: number;
}

export interface TenantExposure {
  tenantId: string;
  /** The allowlisted demo uids holding membership on this tenant. */
  demoMemberUids: string[];
  deliveries: {
    kind: 'review' | 'session';
    /** `reviewDeliveries/{tenantId}/{parentId}/{deliveryId}` or the session equivalent. */
    path: string;
    parentId: string;
    deliveryId: string;
    /** The record's own `status`, when present — `revoked` needs no action. */
    status: string | null;
    /** True when the record carries no `revokedAt`, i.e. the link may still resolve. */
    live: boolean;
  }[];
}

export interface DemoActorDeliveryFindings {
  /** False when no demo allowlist is configured — every result below is then trivially empty. */
  enforcementConfigured: boolean;
  ledgerHits: LedgerHit[];
  tenantExposures: TenantExposure[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDeliveryMintEvent(value: unknown): value is DeliveryMintEvent {
  return typeof value === 'string' && (DELIVERY_MINT_EVENTS as readonly string[]).includes(value);
}

/**
 * Channel 1: scans every `eventLedger/{day}` shard for delivery-mint
 * envelopes whose `actorId` is an allowlisted demo uid.
 *
 * Deliberately tolerant of malformed rows (skip, never throw) — this is a
 * forensic sweep over historical data, and one unparseable envelope must not
 * hide every other finding.
 */
export async function findDemoActorMintEvents(
  database: Database,
  demoConfig: DemoAccountConfig | null,
): Promise<LedgerHit[]> {
  if (demoConfig === null) {
    return [];
  }

  const hits: LedgerHit[] = [];
  const ledger = asRecord((await database.ref('eventLedger').get()).val());
  if (!ledger) {
    return hits;
  }

  for (const [day, shard] of Object.entries(ledger)) {
    const rows = asRecord(shard);
    if (!rows) continue;
    for (const row of Object.values(rows)) {
      const envelope = asRecord(row);
      if (!envelope) continue;
      if (!isDeliveryMintEvent(envelope.eventName)) continue;
      const actorId = envelope.actorId;
      if (typeof actorId !== 'string' || !isDemoAccountSubject(demoConfig, actorId)) continue;
      const causationId = typeof envelope.causationId === 'string' ? envelope.causationId : '';
      // `causationId` is `{parentId}:{deliveryId}`; a parent id can itself
      // contain no `:` (push keys and tenant-scoped ids never do), so the
      // LAST separator is the delivery boundary.
      const separator = causationId.lastIndexOf(':');
      hits.push({
        eventName: envelope.eventName,
        actorId,
        causationId,
        parentId: separator === -1 ? causationId : causationId.slice(0, separator),
        deliveryId: separator === -1 ? '' : causationId.slice(separator + 1),
        day,
        occurredAt: typeof envelope.occurredAt === 'number' ? envelope.occurredAt : 0,
      });
    }
  }

  return hits.sort((a, b) => a.occurredAt - b.occurredAt);
}

/**
 * Channel 2: enumerates every tenant with an allowlisted demo uid in
 * `clientMembers/{tenantId}`, and every review/session delivery living under
 * those tenants.
 */
export async function findDemoMemberTenantDeliveries(
  database: Database,
  demoConfig: DemoAccountConfig | null,
): Promise<TenantExposure[]> {
  if (demoConfig === null) {
    return [];
  }

  const exposures: TenantExposure[] = [];
  const allMembers = asRecord((await database.ref('clientMembers').get()).val());
  if (!allMembers) {
    return exposures;
  }

  for (const [tenantId, members] of Object.entries(allMembers)) {
    const memberMap = asRecord(members);
    if (!memberMap) continue;
    const demoMemberUids = Object.keys(memberMap).filter((uid) =>
      isDemoAccountSubject(demoConfig, uid),
    );
    if (demoMemberUids.length === 0) continue;

    const deliveries: TenantExposure['deliveries'] = [];
    for (const { tree, kind } of DELIVERY_TREES) {
      const byParent = asRecord((await database.ref(`${tree}/${tenantId}`).get()).val());
      if (!byParent) continue;
      for (const [parentId, parentNode] of Object.entries(byParent)) {
        const byDelivery = asRecord(parentNode);
        if (!byDelivery) continue;
        for (const [deliveryId, deliveryNode] of Object.entries(byDelivery)) {
          const record = asRecord(deliveryNode);
          if (!record) continue;
          deliveries.push({
            kind,
            path: `${tree}/${tenantId}/${parentId}/${deliveryId}`,
            parentId,
            deliveryId,
            status: typeof record.status === 'string' ? record.status : null,
            live: record.revokedAt == null,
          });
        }
      }
    }

    exposures.push({ tenantId, demoMemberUids: demoMemberUids.sort(), deliveries });
  }

  return exposures.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

/** Runs both detection channels. Read-only: performs `get()` reads and nothing else. */
export async function auditDemoActorDeliveries(
  database: Database,
  demoConfig: DemoAccountConfig | null,
): Promise<DemoActorDeliveryFindings> {
  const [ledgerHits, tenantExposures] = await Promise.all([
    findDemoActorMintEvents(database, demoConfig),
    findDemoMemberTenantDeliveries(database, demoConfig),
  ]);
  return { enforcementConfigured: demoConfig !== null, ledgerHits, tenantExposures };
}

/**
 * Renders findings as a maintainer-readable report. Descriptive only — it
 * recommends manual review and never performs, schedules, or authorizes a
 * revocation or deletion.
 */
export function describeFindings(findings: DemoActorDeliveryFindings): string {
  const lines: string[] = [];
  lines.push('Demo-actor delivery audit (READ-ONLY — nothing was modified)');

  if (!findings.enforcementConfigured) {
    lines.push('');
    lines.push(
      'No demo allowlist is configured for this environment, so both channels returned empty. Re-run with DEMO_ACCOUNT_UIDS set before drawing any conclusion.',
    );
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Channel 1 — ledger mint events by a demo actor: ${findings.ledgerHits.length}`);
  for (const hit of findings.ledgerHits) {
    lines.push(
      `  ${hit.eventName} actor=${hit.actorId} causationId=${hit.causationId} shard=${hit.day}`,
    );
  }

  const liveCount = findings.tenantExposures.reduce(
    (total, exposure) => total + exposure.deliveries.filter((d) => d.live).length,
    0,
  );
  lines.push('');
  lines.push(
    `Channel 2 — tenants with a demo member: ${findings.tenantExposures.length} (deliveries still live: ${liveCount})`,
  );
  for (const exposure of findings.tenantExposures) {
    lines.push(`  tenant=${exposure.tenantId} demoMembers=${exposure.demoMemberUids.join(',')}`);
    for (const delivery of exposure.deliveries) {
      lines.push(`    ${delivery.live ? 'LIVE   ' : 'revoked'} ${delivery.path}`);
    }
  }

  lines.push('');
  lines.push('Next steps are a MAINTAINER decision. Suggested order:');
  lines.push(
    '  1. Cross-reference channel 1 hits against channel 2 paths — a hit present in both is a confirmed demo-actor mint.',
  );
  lines.push(
    '  2. For each confirmed, still-LIVE delivery, revoke through the existing revoke route (POST .../deliveries/:deliveryId/revoke), which is soft and auditable. Do not delete records directly.',
  );
  lines.push(
    '  3. Channel-2-only entries are NOT evidence of the defect on their own — an ordinary co-coach on the same tenant may have minted them legitimately. Review before acting.',
  );
  lines.push('  4. Record the outcome; this helper intentionally keeps no state.');

  return lines.join('\n');
}
