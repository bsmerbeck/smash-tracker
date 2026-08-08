import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { X_EVENT_ALLOWLIST } from '@smash-tracker/shared';
import type { ReportsConfig, StartggConfig, StripeConfig } from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import { issueClaimInvitation, revokeClaimInvitation } from '../claims/invitations.js';
import { redeemClaimCode } from '../claims/redemption.js';
import { revokeCoachDelegation } from '../claims/delegation.js';
import { hashClaimCode, normalizeClaimCode } from '../claims/crypto.js';
import { runSweepStuckReportJobs } from '../jobs/sweepStuckReportJobs.js';

/**
 * Phase 29 Plan 07 (RTEN-04, D-06, review finding 29-06 MEDIUM/DIVERGENT
 * VIEW): the server-side canonical-event emitter audit — the second half of
 * the "no honest place to hide a reachable, ungated emitter" contract Task 1
 * enforces at each call site. Discovery is import-aware and comment/string-
 * literal-stripped (a raw text `createEvent(` grep would match a comment, a
 * log message, or this very file's own doc comments), excludes test files
 * and this audit file itself, and asserts EXACT-SET equality against a
 * classification table with a CLOSED three-disposition set — there is
 * deliberately no fourth "reachable but ungated" bucket, so a
 * misclassification fails the suite rather than passing it.
 *
 * Mirrors the discovery / exact-set-equality / anti-vacuous-pass-guard style
 * of `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts`
 * and this phase's own `tenantAccessEnumeration.test.ts`/
 * `publicDeliveryInventory.test.ts` precedents, at FILE granularity (the
 * same granularity those two locks use) — a file's `callSiteCount` is
 * recorded alongside its classification so the baseline call-site total is
 * still machine-checked, not merely the file count.
 */

const API_SRC = resolve('src');

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

const ALL_SOURCE_FILES = collectSourceFiles(API_SRC);

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

/**
 * Strips `//` line comments and `/* ... *\/` block comments only — string
 * literals are left INTACT here, because both `resolveLedgerBinding` (needs
 * the quoted import path) and `optsIntoSubjectResolutionPreHandler` (needs
 * the quoted `'preHandler'` literal) depend on string content surviving
 * this pass. Call-site counting additionally runs `stripStringLiterals`
 * (below) on TOP of this, so a `createEvent(` mention inside a string is
 * never counted as a real call.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Strips every string literal's CONTENT (template/single/double-quoted),
 * replacing it with an empty placeholder — applied ONLY when counting call
 * sites, so a `createEvent(...)` mention written inside a log message or an
 * error string is never counted as a real call. Must run on ALREADY
 * comment-stripped source (a comment can itself contain unbalanced quotes
 * that would otherwise confuse this pass).
 */
function stripStringLiterals(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Resolves the LOCAL binding name a file imports the ledger's sole writer
 * under — `createEvent` for every file in this codebase today, but this
 * resolves an aliased import (`createEvent as foo`) correctly too, so
 * discovery stays import-aware rather than hardcoding the unaliased name
 * (review finding 29-06 MEDIUM). Returns `null` when the file does not
 * import from the ledger module at all. Takes COMMENT-stripped (not
 * string-stripped) source — the import path is itself a string literal.
 */
function resolveLedgerBinding(commentStrippedSource: string): string | null {
  const importMatch = commentStrippedSource.match(
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*events\/ledger(?:\.js)?['"]/,
  );
  if (!importMatch) return null;
  const specifiers = importMatch[1]!.split(',').map((s) => s.trim());
  for (const spec of specifiers) {
    if (spec === '') continue;
    const aliasMatch = spec.match(/^createEvent\s+as\s+(\w+)$/);
    if (aliasMatch) return aliasMatch[1]!;
    if (spec === 'createEvent') return 'createEvent';
  }
  return null;
}

/** Counts call-expression occurrences of `binding(` in already comment-AND-string-stripped source. */
function countLedgerCallSites(fullyStrippedSource: string, binding: string): number {
  const pattern = new RegExp(`\\b${binding}\\s*\\(`, 'g');
  return (fullyStrippedSource.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// Anti-vacuous-pass guard for the whole-tree scan.
// ---------------------------------------------------------------------------

describe('serverEmitterAudit: anti-vacuous-pass guard for the whole-tree scan', () => {
  it('discovers more than 50 non-test source files under apps/api/src (a silently-empty scan would make every block below vacuously pass)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

/**
 * `routes/events.ts` is deliberately EXCLUDED from this file-level
 * discovery: its single `createEvent(app.firebase.database, envelope)` call
 * forwards a CLIENT-SUPPLIED (but allowlist-validated) envelope rather than
 * a statically-known, fixed event name — the "gated / unreachable-by-
 * construction / owned-by-plan-29-11" disposition scheme describes emitters
 * with a fixed event name at the call site, which this one is not. Its
 * reachability is governed PER ALLOWLISTED NAME, not per call site — see
 * the dedicated X-class block below, which is where the resolved-open-
 * question decision for this route lives.
 */
const EVENTS_ROUTE_FILE = 'src/routes/events.ts';

interface DiscoveredEmitterFile {
  file: string;
  callSiteCount: number;
}

function discoverEmitterFiles(): DiscoveredEmitterFile[] {
  const results: DiscoveredEmitterFile[] = [];
  for (const file of ALL_SOURCE_FILES) {
    const rel = relPath(file);
    if (rel === EVENTS_ROUTE_FILE) continue;
    const raw = readFileSync(file, 'utf-8');
    const commentStripped = stripComments(raw);
    const binding = resolveLedgerBinding(commentStripped);
    if (!binding) continue;
    const fullyStripped = stripStringLiterals(commentStripped);
    const count = countLedgerCallSites(fullyStripped, binding);
    if (count > 0) {
      results.push({ file: rel, callSiteCount: count });
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

const DISCOVERED_EMITTER_FILES = discoverEmitterFiles();
const DISCOVERED_BASELINE_CALL_SITE_COUNT = DISCOVERED_EMITTER_FILES.reduce(
  (sum, entry) => sum + entry.callSiteCount,
  0,
);

// ---------------------------------------------------------------------------
// Classification — exactly THREE dispositions, no catch-all.
// ---------------------------------------------------------------------------

type Disposition = 'gated' | 'unreachable-by-construction' | 'owned-by-plan-29-11';

interface ClassificationEntry {
  file: string;
  disposition: Disposition;
  reason: string;
}

/**
 * Every entry carries EXACTLY one disposition and a non-empty written
 * reason. There is deliberately NO fourth disposition meaning "reachable
 * but ungated" (review DIVERGENT VIEW finding) — a file the scan discovers
 * that is not in this table fails the exact-set-equality assertion below, a
 * table entry with an unrecognized disposition fails to type-check, and a
 * future editor who "helpfully" adds a permissive fourth bucket converts
 * this audit into a rubber stamp. Do not add one.
 */
const CLASSIFICATION_TABLE: ClassificationEntry[] = [
  {
    file: 'src/billing/credits.ts',
    disposition: 'unreachable-by-construction',
    reason:
      'Every function (spendCredit/spendCredits/addCredits/refundCredit/markStripeEventProcessed) takes a caller uid directly, with no tenant/subject parameter of any kind — personal billing has no coaching-mode surface, and a research tenant has no auth principal to hold a personal credit balance under (RTEN-07).',
  },
  {
    file: 'src/claims/delegation.ts',
    disposition: 'unreachable-by-construction',
    reason:
      'revokeCoachDelegation (plan 29-04) refuses a research tenant unconditionally, even for an allowlisted owner, strictly BEFORE its createEvent call — proven behaviorally below, not merely cited.',
  },
  {
    file: 'src/claims/invitations.ts',
    disposition: 'unreachable-by-construction',
    reason:
      'issueClaimInvitation/revokeClaimInvitation (plan 29-04) both refuse a research tenant unconditionally before any createEvent call, including the rotation-revoke branch inside issueClaimInvitation — proven behaviorally below.',
  },
  {
    file: 'src/claims/redemption.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "redeemClaimCode (plan 29-04) resolves the kind once the tenant id is known and returns the SAME 'invalid' outcome an unknown code returns for a research/unresolved tenant — claim_conflict_detected/claim_completed/coach_delegation_granted are only reachable past that refusal — proven behaviorally below.",
  },
  {
    file: 'src/coaching/reviews.ts',
    disposition: 'gated',
    reason:
      "This plan's Task 1: publishReview resolves the subject kind at the top of the function, before the seal/status mutation, and suppresses coach_review_published/review_revision_published for a research or unresolved tenant.",
  },
  {
    file: 'src/coaching/tenants.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "createClient's createEvent call fires only from the coaching-only wrapper, which hardcodes createClientCore(..., 'coaching') — research tenant creation calls createClientCore directly (plan 29-01's exclusion-by-construction split; plan 29-05 builds research tenant creation on that same core) and structurally never reaches this function's body at all.",
  },
  {
    file: 'src/jobs/sweepStuckReportJobs.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "Reclassified by plan 29-11's Task 2 refusal: this sweep reads ONLY the bounded `reportJobsByStatus/running` index, which a research-subject request can never populate — the refusal in routes/reports.ts sits above every job write (request.uid-keyed evidence/payload/results), so a research-subject submission is refused before a job record (and therefore before a `running` index entry) can ever exist for the sweep to find. Proven behaviorally below: a refused submission leaves the sweep with nothing to sweep and nothing to emit.",
  },
  {
    file: 'src/onboarding/activation.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "reconcilePlayerActivation is invoked only for a PERSONAL (non-client-library) write — matches.ts's sole call site wraps it in `if (!isClientLibrary)`, always passing request.uid, never a tenant id.",
  },
  {
    file: 'src/prep/prep.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "Every route in this module's caller family (routes/prep.ts, routes/prepBindings.ts) addresses request.uid directly and never opts into app.resolveSubject — the tournament-prep feature has no coaching-mode/subject-resolution surface at all.",
  },
  {
    file: 'src/routes/billing.ts',
    disposition: 'unreachable-by-construction',
    reason:
      'Stripe checkout/webhook routes address request.uid directly and never opt into app.resolveSubject — billing has no coaching-mode surface.',
  },
  {
    file: 'src/routes/coachingReviewDeliveries.ts',
    disposition: 'gated',
    reason:
      "This plan's Task 1: resolves the subject kind from the URL :clientId at the top of each handler, before its mutation. The review_delivery_created (mint) call site is ADDITIONALLY unreachable-by-construction on its own — plan 29-06's createReviewDelivery already refuses to write for a research/unresolved subject before this guard is ever reached — but is classified under this file's dominant `gated` disposition per this plan's own instruction ('gated ... Task 1's five files'); review_delivery_revoked (revoke) IS genuinely reachable (a delivery minted before the tenant became research), and this plan's guard is what suppresses it.",
  },
  {
    file: 'src/routes/coachingReviews.ts',
    disposition: 'gated',
    reason:
      "This plan's Task 1: resolves the subject kind from the URL :clientId at the top of the POST /reviews handler, before the autosave mutation, suppressing coach_review_draft_started for a research tenant (reachable via an allowlisted admin).",
  },
  {
    file: 'src/routes/coachingSessionDeliveries.ts',
    disposition: 'gated',
    reason:
      "This plan's Task 1: resolves the subject kind from the URL :clientId at the top of the handler. session_delivery_created is ADDITIONALLY unreachable-by-construction on its own — plan 29-06's createSessionDelivery already refuses to write for a research/unresolved subject before this guard is ever reached — but is classified under this file's dominant `gated` disposition per this plan's own instruction, and the guard stays in place as defensive layering.",
  },
  {
    file: 'src/routes/matches.ts',
    disposition: 'gated',
    reason:
      "This plan's Task 1: both client_vod_attached call sites (POST/PATCH) read request.subjectKind, already resolved by the resolveSubject preHandler before either mutation, suppressing for a research subject (reachable via an allowlisted admin).",
  },
  {
    file: 'src/routes/publicReviewDeliveries.ts',
    disposition: 'unreachable-by-construction',
    reason:
      'Both createEvent calls (client_review_acknowledged, client_review_view_loaded) sit strictly downstream of resolveCoachReviewShareRef, which plan 29-06 gates to return nothing for a research/unresolved subject — the route 404s before either handler reaches its createEvent line.',
  },
  {
    file: 'src/routes/reports.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "Reclassified by plan 29-11's Task 2 refusal: classifyReportSubject is called immediately after the activation-gate block and BEFORE every arm (prep_bundle/post_event_synthesis/prep_report/legacy) — a research or indeterminate classification returns before any evidence read, payload assembly, job write, spend, or createEvent call. This route's evidence/payload/results are all keyed by request.uid, so once refused, no research-subject job can ever reach the `report_completed`/`report_failed` emission sites below. Proven behaviorally below (zero rows across all three telemetry trees, with an ordinary-subject positive control in the same harness).",
  },
  {
    file: 'src/routes/users.ts',
    disposition: 'unreachable-by-construction',
    reason:
      "All three createEvent call sites (PUT /api/users/me) sit inside the block registered under `app.addHook('preHandler', app.authenticate)` ONLY — this file's `app.resolveSubject` opt-in (GET /api/users/me/fighter) is registered on a LATER, separate route group with no createEvent call of its own. request.uid only, never a tenant id.",
  },
];

const CLASSIFIED_FILES = CLASSIFICATION_TABLE.map((entry) => entry.file).sort();

describe('serverEmitterAudit: call-site classification (RTEN-04, D-06)', () => {
  it('discovers more than 30 call sites across more than 15 files (anti-vacuous-pass guard — the baseline recorded when this test was written is 37 call sites across 17 files)', () => {
    expect(DISCOVERED_BASELINE_CALL_SITE_COUNT).toBeGreaterThan(30);
    expect(DISCOVERED_EMITTER_FILES.length).toBeGreaterThan(15);
  });

  it('the discovered file set equals the classification table exactly — a new unclassified call site fails here', () => {
    expect(DISCOVERED_EMITTER_FILES.map((entry) => entry.file)).toEqual(CLASSIFIED_FILES);
  });

  it('every classification entry carries a non-empty reason', () => {
    for (const entry of CLASSIFICATION_TABLE) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("every 'unreachable-by-construction' reason cites the specific plan/guard it depends on, OR the structural (no-tenant-parameter) design that makes a guard unnecessary", () => {
    const unreachableEntries = CLASSIFICATION_TABLE.filter(
      (entry) => entry.disposition === 'unreachable-by-construction',
    );
    expect(unreachableEntries.length).toBeGreaterThan(0);
    for (const entry of unreachableEntries) {
      expect(entry.reason).toMatch(
        /plan 29-0[1456]|createClientCore|resolveCoachReviewShareRef|no tenant\/subject parameter|request\.uid/,
      );
    }
  });

  it('exactly three dispositions are used across the table, with no catch-all value present', () => {
    const dispositions = new Set(CLASSIFICATION_TABLE.map((entry) => entry.disposition));
    for (const disposition of dispositions) {
      expect(['gated', 'unreachable-by-construction', 'owned-by-plan-29-11']).toContain(
        disposition,
      );
    }
  });

  it('does NOT count an occurrence inside a comment or a string literal (fixture, review finding 29-06 MEDIUM)', () => {
    const fixture = [
      "import { createEvent } from '../events/ledger.js';",
      '// createEvent(fakeArgA) — a comment mention must not count',
      '/* createEvent(fakeArgB) — a block-comment mention must not count */',
      'const message = "please call createEvent(fakeArgC) to emit";',
      'const templated = `createEvent(fakeArgD) is what fires this`;',
      'void createEvent(database, envelope); // the ONE real call',
    ].join('\n');

    const commentStripped = stripComments(fixture);
    const binding = resolveLedgerBinding(commentStripped);
    expect(binding).toBe('createEvent');
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countLedgerCallSites(fullyStripped, binding!)).toBe(1);
  });

  it('resolves an aliased import binding, and does not count the unaliased name as a call (fixture)', () => {
    const fixture = [
      "import { createEvent as emitCanonicalEvent } from '../events/ledger.js';",
      '// createEvent(db, env) — the unaliased name is not even imported here',
      'void emitCanonicalEvent(database, envelope);',
    ].join('\n');

    const commentStripped = stripComments(fixture);
    const binding = resolveLedgerBinding(commentStripped);
    expect(binding).toBe('emitCanonicalEvent');
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countLedgerCallSites(fullyStripped, binding!)).toBe(1);
    // The unaliased name genuinely does not appear as a call anywhere in
    // the stripped source (it only appears inside the now-removed comment).
    expect(countLedgerCallSites(fullyStripped, 'createEvent')).toBe(0);
  });

  it('a file that imports the ledger module but never calls the resolved binding is NOT discovered (zero-call-site exclusion)', () => {
    const fixture = [
      "import { createEvent } from '../events/ledger.js';",
      '// This file imports the writer for a type re-export only and never calls it.',
      "export type { EventEnvelope } from '../events/envelope.js';",
    ].join('\n');
    const commentStripped = stripComments(fixture);
    const binding = resolveLedgerBinding(commentStripped);
    expect(binding).toBe('createEvent');
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countLedgerCallSites(fullyStripped, binding!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Behavioral proof of the claim-family classification (review DIVERGENT
// VIEW / cycle-2 discipline: not asserted in prose).
// ---------------------------------------------------------------------------

const HMAC_SECRET = 'audit-test-claim-secret';
const TENANT_ID = 'audit-tenant-1';
const COACH_UID = 'audit-coach-1';
const CLIENT_UID = 'audit-client-1';
const SESSION_ID = 'audit-session-1';
const CLIENT_IP = '203.0.113.99';

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function eventLedgerEntries(database: FakeDatabase, eventName: string): unknown[] {
  const dump = database.dump() as Record<string, unknown>;
  const ledgerByDay = dump.eventLedger as Record<string, Record<string, unknown>> | undefined;
  if (!ledgerByDay) return [];
  return Object.values(ledgerByDay).flatMap((dayEntries) =>
    Object.values(dayEntries).filter(
      (entry) => (entry as { eventName?: string }).eventName === eventName,
    ),
  );
}

function seedResearchTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'research' });
}

function seedMembership(
  database: FakeDatabase,
  tenantId: string,
  uid: string,
  role: 'custodian' | 'owner' | 'delegate',
): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role, joinedAt: 1 });
}

function digestFor(code: string): string {
  return hashClaimCode(HMAC_SECRET, normalizeClaimCode(code));
}

function seedInvitation(database: FakeDatabase, tenantId: string, digest: string): void {
  database.seed(`claimInvitations/${digest}`, {
    tenantId,
    issuerUid: COACH_UID,
    createdAt: 1,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });
}

describe('serverEmitterAudit: claim-family emitters produce zero telemetry for a research tenant (behavioral proof)', () => {
  it('issuance: refused for a research tenant (zero rows across all three telemetry trees); positive control emits for an ordinary tenant', async () => {
    const researchDb = new FakeDatabase();
    seedMembership(researchDb, TENANT_ID, COACH_UID, 'custodian');
    seedResearchTenant(researchDb, TENANT_ID);
    await expect(
      issueClaimInvitation(
        researchDb as never,
        COACH_UID,
        TENANT_ID,
        { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
        { adminUids: new Set([COACH_UID]) },
      ),
    ).rejects.toThrow('Not a member of this client tenant');
    await flush();
    const researchDump = researchDb.dump() as Record<string, unknown>;
    expect(researchDump).not.toHaveProperty('eventLedger');
    expect(researchDump).not.toHaveProperty('eventDedup');
    expect(researchDump).not.toHaveProperty('outboxPending');

    // Positive control (ordinary tenant, same operation): claim_invitation_created IS observed.
    const ordinaryDb = new FakeDatabase();
    seedMembership(ordinaryDb, TENANT_ID, COACH_UID, 'custodian');
    await issueClaimInvitation(
      ordinaryDb as never,
      COACH_UID,
      TENANT_ID,
      { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
      null,
    );
    await flush();
    expect(eventLedgerEntries(ordinaryDb, 'claim_invitation_created')).toHaveLength(1);
  });

  it('rotation: a second issuance attempt against the SAME research tenant is refused identically (zero rows); positive control fires BOTH claim_invitation_revoked(rotated) and claim_invitation_created for an ordinary tenant', async () => {
    const researchDb = new FakeDatabase();
    seedMembership(researchDb, TENANT_ID, COACH_UID, 'custodian');
    seedResearchTenant(researchDb, TENANT_ID);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        issueClaimInvitation(
          researchDb as never,
          COACH_UID,
          TENANT_ID,
          { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
          { adminUids: new Set([COACH_UID]) },
        ),
      ).rejects.toThrow('Not a member of this client tenant');
    }
    await flush();
    const researchDump = researchDb.dump() as Record<string, unknown>;
    expect(researchDump).not.toHaveProperty('eventLedger');

    // Positive control: an ordinary tenant's SECOND issuance is a genuine
    // rotation — the old code is auto-revoked and a new one issued.
    const ordinaryDb = new FakeDatabase();
    seedMembership(ordinaryDb, TENANT_ID, COACH_UID, 'custodian');
    await issueClaimInvitation(
      ordinaryDb as never,
      COACH_UID,
      TENANT_ID,
      { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
      null,
    );
    // A tick between the two issuances so their causationIds (derived from
    // Date.now()) never collide within the same millisecond — mirrors
    // invitations.test.ts's own rotation test, which flushes between calls
    // for the same reason.
    await flush();
    await issueClaimInvitation(
      ordinaryDb as never,
      COACH_UID,
      TENANT_ID,
      { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
      null,
    );
    await flush();
    expect(eventLedgerEntries(ordinaryDb, 'claim_invitation_created')).toHaveLength(2);
    const revoked = eventLedgerEntries(ordinaryDb, 'claim_invitation_revoked') as Array<{
      payload: { reason: string };
    }>;
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.payload.reason).toBe('rotated');
  });

  it('revocation: refused for a research tenant (zero rows); positive control fires claim_invitation_revoked(coach_revoked) for an ordinary tenant', async () => {
    const researchDb = new FakeDatabase();
    seedMembership(researchDb, TENANT_ID, COACH_UID, 'custodian');
    seedResearchTenant(researchDb, TENANT_ID);
    await expect(
      revokeClaimInvitation(
        researchDb as never,
        COACH_UID,
        TENANT_ID,
        { sessionId: SESSION_ID },
        { adminUids: new Set([COACH_UID]) },
      ),
    ).rejects.toThrow('Not a member of this client tenant');
    await flush();
    const researchDump = researchDb.dump() as Record<string, unknown>;
    expect(researchDump).not.toHaveProperty('eventLedger');

    const ordinaryDb = new FakeDatabase();
    seedMembership(ordinaryDb, TENANT_ID, COACH_UID, 'custodian');
    await issueClaimInvitation(
      ordinaryDb as never,
      COACH_UID,
      TENANT_ID,
      { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
      null,
    );
    await revokeClaimInvitation(
      ordinaryDb as never,
      COACH_UID,
      TENANT_ID,
      { sessionId: SESSION_ID },
      null,
    );
    await flush();
    const revoked = eventLedgerEntries(ordinaryDb, 'claim_invitation_revoked') as Array<{
      payload: { reason: string };
    }>;
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.payload.reason).toBe('coach_revoked');
  });

  it('redemption + delegation grant: a code naming a research tenant is refused with the SAME invalid outcome an unknown code returns (zero rows); positive control fires claim_completed AND coach_delegation_granted for an ordinary tenant', async () => {
    const researchDb = new FakeDatabase();
    seedMembership(researchDb, TENANT_ID, COACH_UID, 'custodian');
    seedResearchTenant(researchDb, TENANT_ID);
    const researchCode = 'AUDIT-RESEARCH-CODE-1';
    seedInvitation(researchDb, TENANT_ID, digestFor(researchCode));

    const researchResult = await redeemClaimCode(researchDb as never, {
      code: researchCode,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
      researchConfig: null,
    });
    expect(researchResult).toEqual({ status: 'invalid' });
    await flush();
    expect(eventLedgerEntries(researchDb, 'claim_completed')).toHaveLength(0);
    expect(eventLedgerEntries(researchDb, 'coach_delegation_granted')).toHaveLength(0);

    const ordinaryDb = new FakeDatabase();
    seedMembership(ordinaryDb, TENANT_ID, COACH_UID, 'custodian');
    const ordinaryCode = 'AUDIT-ORDINARY-CODE-1';
    seedInvitation(ordinaryDb, TENANT_ID, digestFor(ordinaryCode));
    const ordinaryResult = await redeemClaimCode(ordinaryDb as never, {
      code: ordinaryCode,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
      researchConfig: null,
    });
    expect(ordinaryResult).toEqual({ status: 'ok', tenantId: TENANT_ID });
    await flush();
    expect(eventLedgerEntries(ordinaryDb, 'claim_completed')).toHaveLength(1);
    expect(eventLedgerEntries(ordinaryDb, 'coach_delegation_granted')).toHaveLength(1);
  });

  it('delegation revoke: refused for a research tenant (zero rows), even for an allowlisted owner; positive control fires coach_delegation_revoked for an ordinary tenant', async () => {
    const DELEGATE_UID = 'audit-delegate-1';
    const researchDb = new FakeDatabase();
    seedResearchTenant(researchDb, TENANT_ID);
    seedMembership(researchDb, TENANT_ID, CLIENT_UID, 'owner');
    seedMembership(researchDb, TENANT_ID, DELEGATE_UID, 'delegate');
    await expect(
      revokeCoachDelegation(
        researchDb as never,
        CLIENT_UID,
        TENANT_ID,
        DELEGATE_UID,
        { sessionId: SESSION_ID },
        { adminUids: new Set([CLIENT_UID]) },
      ),
    ).rejects.toThrow('Not a member of this client tenant');
    await flush();
    const researchDump = researchDb.dump() as Record<string, unknown>;
    expect(researchDump).not.toHaveProperty('eventLedger');

    const ordinaryDb = new FakeDatabase();
    seedMembership(ordinaryDb, TENANT_ID, CLIENT_UID, 'owner');
    seedMembership(ordinaryDb, TENANT_ID, DELEGATE_UID, 'delegate');
    await revokeCoachDelegation(
      ordinaryDb as never,
      CLIENT_UID,
      TENANT_ID,
      DELEGATE_UID,
      { sessionId: SESSION_ID },
      null,
    );
    await flush();
    expect(eventLedgerEntries(ordinaryDb, 'coach_delegation_revoked')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Behavioral proof of the report-route/stale-sweep reclassification (plan
// 29-11, Task 3): a research-subject submission is refused before any job
// record exists, so the report route's completion/failure emissions and the
// sweep's stale-job emission are unreachable-by-construction, not merely
// unreachable-by-instruction.
// ---------------------------------------------------------------------------

const REPORT_AUDIT_TENANT_ID = 'audit-report-research-tenant-1';

const REPORT_AUDIT_STARTGG_CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

const REPORT_AUDIT_REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set([TEST_UID]),
};

const REPORT_AUDIT_STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-123',
  webhookSecret: 'whsec-test-456',
};

const REPORT_AUDIT_RESOLVE_RESPONSE = {
  user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Pandem1c' } },
};
const REPORT_AUDIT_EMPTY_SETS_RESPONSE = {
  player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } },
};

function reportAuditGqlResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify({ data }), init);
}

function reportAuditScoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return reportAuditGqlResponse(REPORT_AUDIT_RESOLVE_RESPONSE);
    }
    return reportAuditGqlResponse(REPORT_AUDIT_EMPTY_SETS_RESPONSE);
  }) as typeof fetch;
}

const REPORT_AUDIT_VALID_REPORT = {
  overview: 'A fast-falling Fox/Falco player.',
  gameplan: ['Punish landing lag.'],
  characterStrategy: {
    picks: ['Mario'],
    reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
  },
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'Flat stages favor us.',
  },
  headToHead: null,
  watchFor: ['Shine spikes off stage.'],
  confidenceNotes: 'No sampled sets — treat this as a cold read.',
};

function reportAuditStubClient(
  impl: (params: unknown) => Promise<{ stop_reason: string | null; parsed_output: unknown }>,
): AnthropicLikeClient {
  return { messages: { parse: impl as AnthropicLikeClient['messages']['parse'] } };
}

function seedReportAuditResearchTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'research' });
}

function seedReportAuditMembership(database: FakeDatabase, tenantId: string, uid: string): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role: 'custodian', joinedAt: 1 });
}

describe('serverEmitterAudit: report route + stale-job sweep produce zero telemetry for a refused research-subject submission (behavioral proof, plan 29-11)', () => {
  it('a research-subject submission creates no job record and emits nothing; a subsequent sweep finds nothing and emits nothing; an ordinary-subject positive control in the SAME harness observes a job and its events', async () => {
    const { app, database } = buildTestApp({
      startgg: REPORT_AUDIT_STARTGG_CONFIG,
      startggFetch: reportAuditScoutFetchMock(),
      reports: REPORT_AUDIT_REPORTS_CONFIG,
      stripe: REPORT_AUDIT_STRIPE_CONFIG,
      reportsClient: reportAuditStubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: REPORT_AUDIT_VALID_REPORT,
      })),
    });
    seedReportAuditResearchTenant(database, REPORT_AUDIT_TENANT_ID);
    seedReportAuditMembership(database, REPORT_AUDIT_TENANT_ID, TEST_UID);

    const refusedResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: { ...authHeader(), 'x-active-subject': `client:${REPORT_AUDIT_TENANT_ID}` },
      payload: { query: 'user/07dc2239' },
    });
    await flush();

    expect(refusedResponse.statusCode).toBe(403);
    expect((database.dump() as Record<string, unknown>).reportJobs).toBeUndefined();
    expect(eventLedgerEntries(database, 'report_completed')).toHaveLength(0);
    expect(eventLedgerEntries(database, 'report_failed')).toHaveLength(0);

    // The sweep reads only `reportJobsByStatus/running` — nothing to find,
    // nothing to refund, nothing to emit.
    const sweepResult = await runSweepStuckReportJobs(database as never);
    expect(sweepResult).toEqual({ swept: 0, refunded: 0 });
    await flush();
    expect(eventLedgerEntries(database, 'report_failed')).toHaveLength(0);

    // Positive control, SAME harness: an ordinary (no-header) submission
    // DOES create a job and DOES emit report_completed — the zero
    // assertions above are not vacuous.
    const ordinaryResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { query: 'user/07dc2239' },
    });
    await flush();

    expect(ordinaryResponse.statusCode).toBe(200);
    expect(eventLedgerEntries(database, 'report_completed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// X-class allowlist classification (research open question 2).
// ---------------------------------------------------------------------------

type XClassDisposition = 'reachable-owned-by-plan-29-09' | 'unreachable';

interface XClassEntry {
  name: string;
  disposition: XClassDisposition;
  reason: string;
}

/**
 * `POST /api/events` (routes/events.ts) is a deliberately PUBLIC,
 * anonymous-first route with no subject header handling and no tenant
 * context of any kind (resolved open question 2) — it is NOT given a
 * server-side subject check in this phase; the control for this path is the
 * allowlist itself plus browser-side suppression (plan 29-09). Every
 * currently-allowlisted name is classified here so a future addition to
 * `X_EVENT_ALLOWLIST` fails this suite until it, too, is classified.
 */
const X_CLASS_CLASSIFICATION: XClassEntry[] = [
  {
    name: 'share_view_loaded',
    disposition: 'unreachable',
    reason:
      "Fired unconditionally on ShareViewPage.tsx (the anonymous /s/:token page) whenever a share token RESOLVES and renders. Every form of share resolution is already gated for a research/unresolved subject by plan 29-06 (getShareByToken and its three sibling resolvers return nothing) — a research tenant's share can never resolve, so this browser event can never fire for one.",
  },
  {
    name: 'signup_cta_clicked',
    disposition: 'unreachable',
    reason:
      "Fired ONLY from AuthContext.tsx's signInWithGoogle handler, at the sign-in CTA click — inherently a PRE-AUTH action with no Firebase identity yet. A research tenant has no auth principal of its own (RTEN-07) and is only ever viewed by an ALREADY-authenticated admin coach in coaching mode — this event fires strictly before any such session could exist.",
  },
  {
    name: 'prep_offer_viewed',
    disposition: 'unreachable',
    reason:
      "Fired only from PrepPaidReportsCard.tsx on the personal /tournaments/:entryKey/prep page. Confirmed structurally personal-uid-only above (src/prep/prep.ts's classification) — the tournament-prep feature has no coaching-mode surface, so this page can never render under a tenant/subject context at all.",
  },
];

const CLASSIFIED_X_NAMES = X_CLASS_CLASSIFICATION.map((entry) => entry.name).sort();

describe('serverEmitterAudit: X-class allowlist classification (research open question 2)', () => {
  it('the allowlist is non-empty (anti-vacuous-pass guard)', () => {
    expect(X_EVENT_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it('the imported allowlist equals the classification table exactly — a newly-allowlisted name fails here until classified', () => {
    expect([...X_EVENT_ALLOWLIST].sort()).toEqual(CLASSIFIED_X_NAMES);
  });

  it('every classification entry carries a non-empty reason', () => {
    for (const entry of X_CLASS_CLASSIFICATION) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('every disposition present is one of the two allowed values', () => {
    const dispositions = new Set(X_CLASS_CLASSIFICATION.map((entry) => entry.disposition));
    for (const disposition of dispositions) {
      expect(['reachable-owned-by-plan-29-09', 'unreachable']).toContain(disposition);
    }
  });
});

// ---------------------------------------------------------------------------
// Subject-kind population invariant (cycle-2 finding C2-MED-8).
// ---------------------------------------------------------------------------

/**
 * A guard reading `request.subjectKind` as `undefined` must be able to
 * conclude "personal" and nothing else — true ONLY if the route it lives on
 * opted into the `resolveSubject` preHandler (plan 29-04 assigns the
 * property UNCONDITIONALLY inside that preHandler). This block locks the
 * CONSUMER side: every file that reads `request.subjectKind` must carry
 * that registration, discovered from the file's own source, never a
 * hand-written list.
 */

/** Matches a genuine READ of `request.subjectKind` — excludes the assignment inside the plugin itself. */
const SUBJECT_KIND_READ_PATTERN = /request\.subjectKind(?!\s*=(?!=))/;

function readsSubjectKind(strippedSource: string): boolean {
  return SUBJECT_KIND_READ_PATTERN.test(strippedSource);
}

function optsIntoSubjectResolutionPreHandler(strippedSource: string): boolean {
  return /app\.addHook\(\s*['"]preHandler['"]\s*,\s*app\.resolveSubject\s*\)/.test(strippedSource);
}

function discoverSubjectKindReaders(): string[] {
  const readers: string[] = [];
  for (const file of ALL_SOURCE_FILES) {
    const stripped = stripComments(readFileSync(file, 'utf-8'));
    if (readsSubjectKind(stripped)) {
      readers.push(relPath(file));
    }
  }
  return readers.sort();
}

const DISCOVERED_SUBJECT_KIND_READERS = discoverSubjectKindReaders();

/** The URL-param coach route files this plan's Task 1 resolves the kind for LOCALLY from `:clientId` — none of these may read `request.subjectKind`, since they carry no subject header at all. */
const URL_PARAM_COACH_ROUTE_FILES = [
  'src/routes/coachingReviews.ts',
  'src/routes/coachingReviewDeliveries.ts',
  'src/routes/coachingSessionDeliveries.ts',
  'src/routes/coachingSessions.ts',
];

describe('serverEmitterAudit: subject-kind population invariant (cycle-2 finding C2-MED-8)', () => {
  it('discovers at least 1 reader of request.subjectKind (anti-vacuous-pass guard)', () => {
    expect(DISCOVERED_SUBJECT_KIND_READERS.length).toBeGreaterThan(0);
  });

  it('every discovered reader file opts into the subject preHandler', () => {
    for (const file of DISCOVERED_SUBJECT_KIND_READERS) {
      const stripped = stripComments(readFileSync(resolve('.', file), 'utf-8'));
      expect(
        optsIntoSubjectResolutionPreHandler(stripped),
        `${file} reads request.subjectKind but never registers app.addHook('preHandler', app.resolveSubject)`,
      ).toBe(true);
    }
  });

  it('no URL-param coach route file reads request.subjectKind — those resolve their kind locally from :clientId instead', () => {
    for (const file of URL_PARAM_COACH_ROUTE_FILES) {
      expect(DISCOVERED_SUBJECT_KIND_READERS).not.toContain(file);
    }
  });

  it('FIXTURE: a route that reads request.subjectKind WITHOUT the preHandler registration fails the registration check (proves the block is not vacuous)', () => {
    const violatingFixture = [
      'const matchesRoutes = async (app) => {',
      "  app.addHook('preHandler', app.authenticate);",
      "  // NOTE: no app.addHook('preHandler', app.resolveSubject) here.",
      "  app.get('/matches', async (request) => {",
      "    if (request.subjectKind === 'ordinary') { /* ... */ }",
      '  });',
      '};',
    ].join('\n');
    const stripped = stripComments(violatingFixture);
    expect(readsSubjectKind(stripped)).toBe(true);
    expect(optsIntoSubjectResolutionPreHandler(stripped)).toBe(false);
  });

  it('FIXTURE: the assignment inside the resolveSubject plugin itself is NOT counted as a read', () => {
    const pluginFixture = [
      'export default fp(async function resolveSubjectPlugin(app) {',
      "  app.decorate('resolveSubject', async (request, reply) => {",
      '    const resolved = await resolveSubject({ database: app.firebase.database, uid: request.uid, header: undefined, researchConfig: app.researchConfig });',
      '    request.subjectId = resolved.subjectId;',
      '    request.subjectKind = resolved.subjectKind;',
      '  });',
      '});',
    ].join('\n');
    const stripped = stripComments(pluginFixture);
    expect(readsSubjectKind(stripped)).toBe(false);
  });
});
