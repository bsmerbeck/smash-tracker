import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review consensus
 * finding 1): the tree-scan lock proving every tenant-addressed
 * authorization site in the API routes through the shared research-access
 * primitive (`apps/api/src/research/access.ts`), plus a second, separately
 * classified block proving the set of files that read the tenant membership
 * tree (`clientMembers/{tenantId}`) directly is EXACTLY the set this plan
 * accounts for — no more, no less.
 *
 * Mirrors the discovery / exact-set-equality / anti-vacuous-pass style of
 * `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts`
 * rather than reinventing it, at FILE granularity (not per-call-site AST
 * analysis) — the same granularity that file's own gate uses.
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

const allSourceFiles = collectSourceFiles(API_SRC);

/** Strips `//` line comments and `/* ... *\/` block comments before scanning for a pattern. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

// ---------------------------------------------------------------------------
// Block 1: tenant-addressed AUTHORIZATION sites.
// ---------------------------------------------------------------------------

/**
 * Discovery pattern: any file that calls one of the shared membership
 * primitives, the subject resolver, the total/throwing research-access
 * entry points directly, or one of the service-layer functions those
 * primitives gate (the tenant-addressed surface the review's #1 finding
 * covers: header-driven subject routes, URL-param coach routes, the
 * destructive tenant routes, and the whole claim family).
 */
const AUTHORIZATION_CALL_PATTERN =
  /\b(requireMembership|requireTenantRole|resolveSubject|resolveSubjectId|archiveClient|deleteClient|exportClient|listClients|issueClaimInvitation|revokeClaimInvitation|getClaimInvitationStatus|redeemClaimCode|revokeCoachDelegation|resolveTenantAccess|assertTenantAccess)\(/;

const discoveredAuthorizationSites = allSourceFiles
  .filter((file) => AUTHORIZATION_CALL_PATTERN.test(stripComments(readFileSync(file, 'utf-8'))))
  .map(relPath)
  .sort();

type AuthorizationDisposition = 'gated-by-primitive' | 'refuses-research-outright' | 'no-tenant-id';

interface AuthorizationClassificationEntry {
  file: string;
  disposition: AuthorizationDisposition;
  reason: string;
}

/**
 * Every entry below carries EXACTLY one disposition and a non-empty written
 * reason. There is deliberately no catch-all disposition — a file the scan
 * discovers that is not in this table fails the exact-set-equality
 * assertion below, and a file in this table classified with a disposition
 * outside the three allowed values fails to type-check.
 */
const AUTHORIZATION_CLASSIFICATION: AuthorizationClassificationEntry[] = [
  {
    file: 'src/research/access.ts',
    disposition: 'gated-by-primitive',
    reason:
      'The primitive itself (resolveTenantAccess/assertTenantAccess) — every other entry in this table routes through here; self-referential by construction.',
  },
  {
    file: 'src/coaching/subject.ts',
    disposition: 'gated-by-primitive',
    reason:
      'resolveSubject/resolveSubjectId call assertTenantAccess after membership passes, gating every header-driven client: subject route (review finding 1).',
  },
  {
    file: 'src/plugins/resolveSubject.ts',
    disposition: 'gated-by-primitive',
    reason: "Delegates directly to coaching/subject.ts's resolveSubject; no logic of its own.",
  },
  {
    file: 'src/coaching/membershipRoles.ts',
    disposition: 'gated-by-primitive',
    reason:
      'requireTenantRole calls assertTenantAccess after the existing role check passes — the shared gate for every destructive tenant route and the whole claim family.',
  },
  {
    file: 'src/coaching/tenants.ts',
    disposition: 'gated-by-primitive',
    reason:
      'requireMembership calls assertTenantAccess; archiveClient/deleteClient/exportClient/listClients all route through requireTenantRole or the tri-state kind read. exportClient ADDITIONALLY refuses a research tenant outright, for every caller including an allowlisted custodian (RTEN-03) — file-classified by its dominant gate.',
  },
  {
    file: 'src/routes/coachingReviews.ts',
    disposition: 'gated-by-primitive',
    reason:
      'preHandler calls requireMembership on the URL :clientId, threading app.researchConfig.',
  },
  {
    file: 'src/routes/coachingSessions.ts',
    disposition: 'gated-by-primitive',
    reason:
      'preHandler calls requireMembership on the URL :clientId, threading app.researchConfig.',
  },
  {
    file: 'src/routes/coachingReviewDeliveries.ts',
    disposition: 'gated-by-primitive',
    reason:
      'preHandler calls requireMembership on the URL :clientId, threading app.researchConfig.',
  },
  {
    file: 'src/routes/coachingSessionDeliveries.ts',
    disposition: 'gated-by-primitive',
    reason:
      'preHandler calls requireMembership on the URL :clientId, threading app.researchConfig.',
  },
  {
    file: 'src/routes/coachingTenants.ts',
    disposition: 'gated-by-primitive',
    reason:
      "The five existing routes forward app.researchConfig into the tenants.ts service functions. The new GET .../kind route checks membership directly then branches on resolveTenantAccess's total outcome (D-07) — the ONE call site in the phase permitted to observe the indeterminate outcome, because membership is checked FIRST.",
  },
  {
    file: 'src/claims/invitations.ts',
    disposition: 'refuses-research-outright',
    reason:
      'issueClaimInvitation/revokeClaimInvitation thread researchConfig into requireTenantRole AND additionally refuse a research tenant unconditionally (a research tenant is not claimable at all before Phase 34, even by its own admin).',
  },
  {
    file: 'src/claims/redemption.ts',
    disposition: 'refuses-research-outright',
    reason:
      'redeemClaimCode resolves the kind once the tenant id is known (post-consumption) and returns the SAME invalid outcome every other ineligible class returns for research/unresolved — no allowlist bypass exists on this path.',
  },
  {
    file: 'src/claims/delegation.ts',
    disposition: 'refuses-research-outright',
    reason:
      'revokeCoachDelegation threads researchConfig into requireTenantRole AND additionally refuses a research tenant unconditionally, even for an allowlisted admin holding the owner role.',
  },
  {
    file: 'src/routes/claimInvitations.ts',
    disposition: 'refuses-research-outright',
    reason:
      'Thin route wrapper forwarding app.researchConfig into invitations.ts, which refuses outright.',
  },
  {
    file: 'src/routes/claims.ts',
    disposition: 'refuses-research-outright',
    reason:
      'Thin route wrapper forwarding app.researchConfig into redemption.ts, which refuses outright.',
  },
  {
    file: 'src/routes/claimDelegations.ts',
    disposition: 'refuses-research-outright',
    reason:
      'Thin route wrapper forwarding app.researchConfig into delegation.ts, which refuses outright.',
  },
  {
    file: 'src/research/routeGuards.ts',
    disposition: 'gated-by-primitive',
    reason:
      "requireResearchTenantAdmin validates the tenant id shape, applies the family's admin allowlist, reads membership, then delegates the kind decision to assertTenantAccess — the shared primitive makes the final access decision, and every negative outcome maps to the single exported RESEARCH_FAMILY_REJECTION (plan 29-05; classified post-merge in wave 2).",
  },
];

const classifiedAuthorizationFiles = AUTHORIZATION_CLASSIFICATION.map((entry) => entry.file).sort();

describe('tenant-addressed authorization coverage lock (review consensus finding 1)', () => {
  it('discovers more than 10 authorization sites (anti-vacuous-pass guard — the baseline recorded when this test was written is 16)', () => {
    expect(discoveredAuthorizationSites.length).toBeGreaterThan(10);
  });

  it('the discovered set equals the classification table exactly — a new tenant-addressed surface that skips the shared primitive fails here', () => {
    expect(discoveredAuthorizationSites).toEqual(classifiedAuthorizationFiles);
  });

  it('every classification entry carries a non-empty written reason', () => {
    for (const entry of AUTHORIZATION_CLASSIFICATION) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('exactly three dispositions are used across the table, with no catch-all value present', () => {
    const dispositions = new Set(AUTHORIZATION_CLASSIFICATION.map((entry) => entry.disposition));
    for (const disposition of dispositions) {
      expect(['gated-by-primitive', 'refuses-research-outright', 'no-tenant-id']).toContain(
        disposition,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Block 2: the CLASSIFIED direct `clientMembers/` tree-reader set (cycle-2
// finding C2-MED-6) — a superset check would be false today (rtdb.ts and
// clientWorkspaces.ts both read it for non-authorization purposes), so this
// asserts an exact CLASSIFIED set instead of pretending only the primitives
// read this tree.
// ---------------------------------------------------------------------------

const discoveredMembershipReaders = allSourceFiles
  .filter((file) => stripComments(readFileSync(file, 'utf-8')).includes('clientMembers/'))
  .map(relPath)
  .sort();

type MembershipReaderDisposition =
  | 'authorization-primitive'
  | 'research-module'
  | 'claim-control-writer'
  | 'non-authorization-reader';

interface MembershipReaderEntry {
  file: string;
  symbol: string;
  disposition: MembershipReaderDisposition;
  reason: string;
}

/**
 * There is deliberately NO catch-all disposition. A file the scan discovers
 * that is not in this table fails the exact-set-equality assertion below.
 */
const MEMBERSHIP_READER_CLASSIFICATION: MembershipReaderEntry[] = [
  {
    file: 'src/coaching/tenants.ts',
    symbol: 'requireMembership / createClientCore / deleteClient',
    disposition: 'authorization-primitive',
    reason:
      "requireMembership's read IS the access decision; createClientCore/deleteClient write and read membership as part of the SAME claim-ready lifecycle this module owns (creation, hard-delete cascade).",
  },
  {
    file: 'src/coaching/subject.ts',
    symbol: 'resolveSubject',
    disposition: 'authorization-primitive',
    reason:
      'The membership existence check IS the access decision for every header-driven client: subject route.',
  },
  {
    file: 'src/coaching/membershipRoles.ts',
    symbol: 'readMembershipRole',
    disposition: 'authorization-primitive',
    reason: 'The role read IS the access decision requireTenantRole is built from.',
  },
  {
    file: 'src/routes/coachingTenants.ts',
    symbol: 'GET /coaching/clients/:clientId/kind handler',
    disposition: 'authorization-primitive',
    reason:
      "The new kind endpoint checks clientMembers/{clientId}/{callerUid} membership directly (mirroring requireMembership) BEFORE branching on resolveTenantAccess's total outcome (D-07) — the read IS the access decision at this site.",
  },
  {
    file: 'src/claims/redemption.ts',
    symbol: 'flipTenantOwnership',
    disposition: 'claim-control-writer',
    reason:
      "Writes clientMembers as part of the atomic ownership-transition control plane, gated by this plan's research refusal above it.",
  },
  {
    file: 'src/claims/delegation.ts',
    symbol: 'revokeCoachDelegation',
    disposition: 'claim-control-writer',
    reason:
      "Writes (nulls) a delegate's clientMembers entry as part of the delegation-revoke control plane, gated by this plan's research refusal above it.",
  },
  {
    file: 'src/services/rtdb.ts',
    symbol: 'resolveCoachDisplayNameForTenant',
    disposition: 'non-authorization-reader',
    reason:
      'Reads clientMembers/{tenantId} to derive a display name for review/session delivery pages — makes NO access decision, raises no rejection.',
  },
  {
    file: 'src/claims/clientWorkspaces.ts',
    symbol: 'listOwnedWorkspaces',
    disposition: 'non-authorization-reader',
    reason:
      "Reads clientMembers/{tenantId} to assemble the caller's OWN workspace listing (the caller's uid is never taken from a path/body/query) and to self-heal orphaned index rows — makes NO access decision, raises no rejection.",
  },
  {
    file: 'src/research/routeGuards.ts',
    symbol: 'requireResearchTenantAdmin',
    disposition: 'research-module',
    reason:
      "Reads clientMembers/{tenantId}/{callerUid} as the research family's membership gate BEFORE delegating the kind decision to assertTenantAccess; every negative outcome — including missing membership — raises the single uniform RESEARCH_FAMILY_REJECTION, so the read is part of the research family's own dual-gate access decision (plan 29-05; classified post-merge in wave 2).",
  },
  {
    file: 'src/research/tenants.ts',
    symbol: 'createResearchTenant',
    disposition: 'research-module',
    reason:
      "Writes the creating admin's membership through the telemetry-silent creation core as part of the research tenant lifecycle, and listResearchTenants reads membership rows to enumerate only tenants the caller belongs to — the same claim-ready lifecycle pattern coaching/tenants.ts is classified under (plan 29-05; classified post-merge in wave 2).",
  },
];

const classifiedMembershipReaderFiles = MEMBERSHIP_READER_CLASSIFICATION.map(
  (entry) => entry.file,
).sort();

/**
 * Extracts the source text of a named function/const-arrow-function
 * declaration by brace-balance matching, starting from the first `{` after
 * the declaration and ending when the balance returns to zero. Returns
 * `null` if the symbol name is not found — callers should treat that as a
 * hard failure (the symbol moved or was renamed), not a silent skip.
 */
function extractFunctionBody(source: string, symbolName: string): string | null {
  const declPattern = new RegExp(
    `(async function ${symbolName}\\s*\\(|function ${symbolName}\\s*\\(|const ${symbolName}\\s*=)`,
  );
  const match = declPattern.exec(source);
  if (!match) return null;

  const startIdx = source.indexOf('{', match.index);
  if (startIdx === -1) return null;

  let depth = 0;
  for (let i = startIdx; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

describe('classified direct clientMembers/ tree-reader set (cycle-2 finding C2-MED-6)', () => {
  it('discovers more than 3 membership-tree readers (anti-vacuous-pass guard — the baseline recorded when this test was written is 8)', () => {
    expect(discoveredMembershipReaders.length).toBeGreaterThan(3);
  });

  it('the discovered set equals the classification table exactly', () => {
    expect(discoveredMembershipReaders).toEqual(classifiedMembershipReaderFiles);
  });

  it('every classification entry carries a non-empty written reason', () => {
    for (const entry of MEMBERSHIP_READER_CLASSIFICATION) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('exactly four dispositions are used across the table, with no catch-all value present', () => {
    const dispositions = new Set(
      MEMBERSHIP_READER_CLASSIFICATION.map((entry) => entry.disposition),
    );
    for (const disposition of dispositions) {
      expect([
        'authorization-primitive',
        'research-module',
        'claim-control-writer',
        'non-authorization-reader',
      ]).toContain(disposition);
    }
  });

  it('every non-authorization-reader entry raises NO rejection-raising construct in its named enclosing function', () => {
    const nonAuthEntries = MEMBERSHIP_READER_CLASSIFICATION.filter(
      (entry) => entry.disposition === 'non-authorization-reader',
    );
    expect(nonAuthEntries.length).toBeGreaterThan(0);

    for (const entry of nonAuthEntries) {
      const source = readFileSync(resolve('.', entry.file), 'utf-8');
      const body = extractFunctionBody(source, entry.symbol);
      expect(body, `could not locate function ${entry.symbol} in ${entry.file}`).not.toBeNull();
      expect(body).not.toMatch(/throw new ForbiddenError/);
      expect(body).not.toMatch(/throw new NotFoundError/);
      expect(body).not.toMatch(/throw new ConflictError/);
    }
  });
});
