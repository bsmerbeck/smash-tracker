import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_TENANT_TREES } from '../coaching/tenants.js';

/**
 * Phase 29 Plan 07 (RTEN-04, research open question 3, review finding 29-06
 * HIGH): closes "can a cross-user aggregation surface reach a research
 * tenant's CONTENT trees" with a machine-checked lock, not a prose claim.
 *
 * Per review finding 29-06 HIGH, the earlier revision's aggregation
 * inventory scanned only tenant METADATA/index trees — but
 * `apps/api/src/groups/groups.ts`'s group-scoring `loadMatches` reads
 * `matches/${uid}` (line ~300), a CANONICAL CONTENT tree, at a uid sourced
 * from a group membership record (a DIFFERENT user's uid than the caller).
 * That is exactly the aggregation shape this lock exists to catch — this
 * file therefore scans CONTENT trees (imported from `CANONICAL_TENANT_TREES`,
 * never re-typed), not just metadata trees.
 *
 * The finding this lock encodes and keeps true: group membership can only be
 * established by an authenticated Firebase account, a research tenant has NO
 * auth principal of its own (RTEN-07), and no code path writes a research
 * tenant id into a group membership record — so `groups/groups.ts`'s
 * aggregation cannot currently reach a research tenant's content, even
 * though its READ SHAPE is structurally identical to one that could. A
 * future aggregation reading a subject-keyed content tree MUST be added to
 * the allowlist below WITH a structural reason — "it probably will not
 * include research tenants" is explicitly NOT such a reason.
 *
 * `apps/api/src/routes/scout.ts` was read directly per this plan's
 * `<read_first>` instruction and confirmed to make ZERO local RTDB reads —
 * every scouting result comes from the start.gg/parry.gg providers using
 * this app's OWN API credentials, never a user token, never a local
 * subject-keyed tree. It is intentionally absent from every set below.
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

describe('aggregationSurfaces: anti-vacuous-pass guard for the whole-tree scan', () => {
  it('discovers more than 50 non-test source files under apps/api/src', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(50);
  });

  it('imports CANONICAL_TENANT_TREES from coaching/tenants.ts rather than re-typing the list', () => {
    expect(CANONICAL_TENANT_TREES.length).toBeGreaterThan(0);
    expect(CANONICAL_TENANT_TREES).toContain('matches');
  });
});

// ---------------------------------------------------------------------------
// Block 1: CANONICAL CONTENT-tree readers (review finding 29-06 HIGH).
// ---------------------------------------------------------------------------

/** A subject-keyed reference into one of `CANONICAL_TENANT_TREES`, e.g. `` `matches/${uid}` ``. */
function buildTreeReadPattern(tree: string): RegExp {
  return new RegExp('`' + tree + '/\\$\\{');
}

function discoverContentTreeReaderFiles(): string[] {
  const readers = new Set<string>();
  for (const file of ALL_SOURCE_FILES) {
    const source = readFileSync(file, 'utf-8');
    for (const tree of CANONICAL_TENANT_TREES) {
      if (buildTreeReadPattern(tree).test(source)) {
        readers.add(relPath(file));
        break;
      }
    }
  }
  return [...readers].sort();
}

const DISCOVERED_CONTENT_TREE_READERS = discoverContentTreeReaderFiles();

interface ContentReaderEntry {
  file: string;
  reason: string;
}

/**
 * Every entry carries a non-empty reason. A file the scan discovers that is
 * not in this table fails the exact-set-equality assertion below.
 */
const CONTENT_TREE_READER_ALLOWLIST: ContentReaderEntry[] = [
  {
    file: 'src/claims/invitations.ts',
    reason:
      "Reads/writes activeClaimInvitationByTenant/{tenantId} — the tenant's OWN one-active-code pointer, gated by this file's own research refusal above every write.",
  },
  {
    file: 'src/claims/redemption.ts',
    reason:
      "Reads/nulls activeClaimInvitationByTenant/{tenantId} as part of the atomic ownership-transition control plane, gated by this file's own research/unresolved refusal.",
  },
  {
    file: 'src/coaching/deliveryVodFreeze.ts',
    reason:
      "Reads matches/{tenantId}/{matchId} for a SPECIFIC match id the coach picked, scoped to the delivery's OWN tenantId (the requireMembership-gated route's :clientId) — never a foreign/cross-user id.",
  },
  {
    file: 'src/coaching/reviewDeliveries.ts',
    reason:
      "Reads/writes reviewVersions/{tenantId}/... and reviewDeliveries/{tenantId}/... scoped to the requireMembership-gated route's own :clientId tenantId.",
  },
  {
    file: 'src/coaching/reviews.ts',
    reason:
      "Reads/writes reviewDrafts/reviewVersions/reviewVersionIndex/reviewStatus/reviewDeliveries, all scoped to the requireMembership-gated route's own :clientId tenantId — this plan's Task 1 additionally gates its telemetry emission on that same tenantId's resolved kind.",
  },
  {
    file: 'src/coaching/sessionDeliveries.ts',
    reason:
      "Reads/writes trainingSessions/{tenantId}/... and sessionDeliveries/{tenantId}/..., scoped to the requireMembership-gated route's own :clientId tenantId.",
  },
  {
    file: 'src/coaching/sessions.ts',
    reason:
      "Reads/writes trainingSessions/{tenantId}/..., scoped to the requireMembership-gated route's own :clientId tenantId.",
  },
  {
    file: 'src/coaching/tenants.ts',
    reason:
      "Reads/nulls sessionDeliveries/{tenantId} and activeClaimInvitationByTenant/{tenantId} as part of the tenant lifecycle (archive/delete/export cascade), operating on the tenant's OWN id — this module also OWNS CANONICAL_TENANT_TREES, imported here.",
  },
  {
    file: 'src/groups/groups.ts',
    reason:
      "THE aggregation surface (review finding 29-06 HIGH): loadMatches reads matches/{uid} at a uid sourced from groupMembers/{groupId} — a DIFFERENT user's uid than the caller. Group membership can only be established by an authenticated Firebase account; a research tenant has no auth principal of its own (RTEN-07) and no code path writes a research tenant id into a group membership record — so this aggregation cannot currently reach a research tenant's content. Block 3 below proves the uid this file passes to loadMatches is ALWAYS derived from a group membership record, never a caller-supplied or foreign id.",
  },
  {
    file: 'src/parrygg/sync.ts',
    reason:
      "Writes matches/{uid} and opponents/{uid} for the SYNCING user's own uid (the authenticated caller importing their own parry.gg history) — never a foreign id.",
  },
  {
    file: 'src/reports/generate.ts',
    reason:
      "Reads matches/opponentAliases/opponentNotes/primaryFighters/secondaryFighters at request.uid — the personal (never coaching-mode) report-requesting user's own uid, per this plan's Task 2 classification of the report/prep surface as request.uid-only.",
  },
  {
    file: 'src/reports/synthesis.ts',
    reason:
      'Reads matches/opponentAliases at request.uid — same personal, request.uid-only reasoning as reports/generate.ts.',
  },
  {
    file: 'src/research/enrichment/projection.ts',
    reason:
      "Phase 30.2 Plan 08 (ENR-07/ENR-08): applyEnrichmentProjection reads and writes matches/{tenantId}/{key} through a per-row .transaction(), scoped to the tenantId a caller (a future enrichment run entry point, gated the same way the ingestion batch executor is) passes in and this file validates via isPathSafeTenantId — never a foreign/cross-user id. The row read/transaction only merges the Liquipedia stage/VOD members forward through the shared resolveEnrichedMatchMembers rules; it makes no aggregation decision across tenants, mirroring research/ingestion/projection.ts's own-tenant-only classification immediately below.",
  },
  {
    file: 'src/research/ingestion/projection.ts',
    reason:
      "Phase 30 Plan 03 (ING-03/ING-06): writes matches/{tenantId}/{key} through a per-row .transaction() scoped to the tenantId the caller (30-07's batch executor, itself gated by requireResearchTenantAdmin) passed in — never a foreign/cross-user id. The transaction reads the existing row only to merge user-owned annotations forward (mergePreservedMatchMembers); it makes no aggregation decision across tenants, mirroring startgg/sync.ts's and parrygg/sync.ts's own-tenant-only classification above.",
  },
  {
    file: 'src/routes/prepBindings.ts',
    reason:
      "Reads matches/opponentAliases at request.uid — the personal tournament-prep feature, confirmed request.uid-only (no coaching-mode surface) in this plan's serverEmitterAudit.test.ts classification of src/prep/prep.ts.",
  },
  {
    file: 'src/services/rtdb.ts',
    reason:
      'RtdbService — the central data-access layer. Every method takes the CALLER-RESOLVED subject id (request.subjectId or request.uid) as a direct parameter; no method aggregates across a foreign/cross-user id list. Covers matches/playlists/opponents/opponentAliases/opponentNotes/stageFavorites/primaryFighters/secondaryFighters/reviewVersions/reviewDeliveries/sessionDeliveries.',
  },
  {
    file: 'src/startgg/sync.ts',
    reason:
      "Writes matches/{uid} and opponents/{uid} for the SYNCING user's own uid (the authenticated caller importing their own start.gg history) — never a foreign id.",
  },
];

const ALLOWLISTED_CONTENT_READER_FILES = CONTENT_TREE_READER_ALLOWLIST.map(
  (entry) => entry.file,
).sort();

describe('aggregationSurfaces: canonical CONTENT-tree reader lock (review finding 29-06 HIGH)', () => {
  it('discovers more than 5 content-tree reader files (anti-vacuous-pass guard — the baseline recorded when this test was written is 15)', () => {
    expect(DISCOVERED_CONTENT_TREE_READERS.length).toBeGreaterThan(5);
  });

  it('the discovered set equals the allowlist exactly — a future aggregation reading subject content fails here until classified', () => {
    expect(DISCOVERED_CONTENT_TREE_READERS).toEqual(ALLOWLISTED_CONTENT_READER_FILES);
  });

  it('every allowlist entry carries a non-empty reason', () => {
    for (const entry of CONTENT_TREE_READER_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('the group aggregation module (src/groups/groups.ts) appears in the allowlist with the structural RTEN-07 reason', () => {
    const groupsEntry = CONTENT_TREE_READER_ALLOWLIST.find(
      (entry) => entry.file === 'src/groups/groups.ts',
    );
    expect(groupsEntry).toBeDefined();
    expect(groupsEntry?.reason).toMatch(/RTEN-07/);
    expect(groupsEntry?.reason).not.toMatch(/probably will not/i);
  });
});

// ---------------------------------------------------------------------------
// Block 2: tenant METADATA / MEMBERSHIP / per-coach INDEX tree readers.
// ---------------------------------------------------------------------------

const METADATA_MEMBERSHIP_INDEX_TREES = ['clientTenants', 'clientMembers', 'coachClients'];

function discoverMetadataReaderFiles(): string[] {
  const readers = new Set<string>();
  for (const file of ALL_SOURCE_FILES) {
    const source = readFileSync(file, 'utf-8');
    for (const tree of METADATA_MEMBERSHIP_INDEX_TREES) {
      if (buildTreeReadPattern(tree).test(source)) {
        readers.add(relPath(file));
        break;
      }
    }
  }
  return [...readers].sort();
}

const DISCOVERED_METADATA_READERS = discoverMetadataReaderFiles();

interface MetadataReaderEntry {
  file: string;
  reason: string;
}

const METADATA_READER_ALLOWLIST: MetadataReaderEntry[] = [
  {
    file: 'src/claims/clientWorkspaces.ts',
    reason:
      "Reads clientMembers/{tenantId} to assemble the caller's OWN workspace listing (the caller's uid is never taken from a path/body/query) — makes no cross-user aggregation decision (mirrors this file's classification in plan 29-04's tenantAccessEnumeration.test.ts).",
  },
  {
    file: 'src/claims/delegation.ts',
    reason:
      "Reads/nulls clientMembers and coachClients as part of the delegation-revoke control plane, gated by this file's own research refusal above the write.",
  },
  {
    file: 'src/claims/redemption.ts',
    reason:
      "Reads clientTenants/{tenantId} and coachClients/{coachUid}/{tenantId} to resolve the redeeming tenant's own metadata/label during the atomic ownership flip.",
  },
  {
    file: 'src/coaching/membershipRoles.ts',
    reason: "readMembershipRole's read of clientMembers IS the requireTenantRole access decision.",
  },
  {
    file: 'src/coaching/subject.ts',
    reason:
      'The clientMembers existence check IS the access decision for every header-driven client: subject route.',
  },
  {
    file: 'src/coaching/tenants.ts',
    reason:
      "requireMembership's clientMembers read IS the access decision; the tenant lifecycle (create/list/archive/delete/export) reads/writes clientTenants/clientMembers/coachClients as the tenant metadata/membership/index owner.",
  },
  {
    file: 'src/research/reportSubject.ts',
    reason:
      "classifyReportSubject's clientMembers read IS the access decision (checked BEFORE clientTenants' kind read, deliberately — no-oracle ordering, plan 29-11) for the report route's research-subject refusal; never used for cross-user aggregation.",
  },
  {
    file: 'src/research/routeGuards.ts',
    reason:
      "requireResearchTenantAdmin reads clientMembers/{tenantId}/{callerUid} as the research family's own membership gate before delegating the kind decision to assertTenantAccess (plan 29-05).",
  },
  {
    file: 'src/research/subjectKind.ts',
    reason:
      'readSubjectKind reads ONLY clientTenants/{subjectId}/kind — the tri-state kind lookup every isolation call site in this plan builds on (plan 29-01).',
  },
  {
    file: 'src/research/tenants.ts',
    reason:
      'Writes/reads clientMembers and coachClients as part of the research tenant lifecycle (creation, listing tenants the caller belongs to) — the same claim-ready lifecycle pattern coaching/tenants.ts owns for coaching tenants (plan 29-05).',
  },
  {
    file: 'src/routes/coachingTenants.ts',
    reason:
      "The GET .../kind endpoint checks clientMembers/{clientId}/{callerUid} directly (mirroring requireMembership) BEFORE branching on resolveTenantAccess's total outcome (plan 29-04) — the read IS the access decision at this site.",
  },
  {
    file: 'src/services/rtdb.ts',
    reason:
      "resolveCoachDisplayNameForTenant reads clientMembers/{tenantId} to derive a display name for review/session delivery pages — makes no access decision, raises no rejection (mirrors this file's classification in plan 29-04's tenantAccessEnumeration.test.ts).",
  },
];

const ALLOWLISTED_METADATA_READER_FILES = METADATA_READER_ALLOWLIST.map(
  (entry) => entry.file,
).sort();

describe('aggregationSurfaces: tenant metadata/membership/index-tree reader lock', () => {
  it('discovers more than 5 metadata/membership/index reader files (anti-vacuous-pass guard — the baseline recorded when this test was written is 11)', () => {
    expect(DISCOVERED_METADATA_READERS.length).toBeGreaterThan(5);
  });

  it('the discovered set equals the allowlist exactly', () => {
    expect(DISCOVERED_METADATA_READERS).toEqual(ALLOWLISTED_METADATA_READER_FILES);
  });

  it('every allowlist entry carries a non-empty reason', () => {
    for (const entry of METADATA_READER_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Block 3: the group module's tenant-id-derived reference paths originate
// ONLY from a group membership record (expressed as a scan of the file's
// own reference-path expressions, not a prose claim).
// ---------------------------------------------------------------------------

/**
 * Extracts the source text of a named function declaration by brace-balance
 * matching — mirrors `tenantAccessEnumeration.test.ts`'s identically-named
 * helper. Returns `null` if the symbol name is not found.
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

const GROUPS_FILE = 'src/groups/groups.ts';

describe("aggregationSurfaces: groups.ts's tenant-id-derived reference paths originate only from group membership records", () => {
  const groupsSource = readFileSync(resolve('.', GROUPS_FILE), 'utf-8');

  it('loadMatches (the sole matches/{uid} content-tree reader in this file) has exactly ONE call site in the whole file', () => {
    const callSites = groupsSource.match(/\bloadMatches\(/g) ?? [];
    // Two occurrences total: the function's own declaration line
    // (`function loadMatches(`, matched too since it ends in the same
    // token boundary) plus its ONE call site.
    const declarationPattern = /async function loadMatches\(/;
    expect(declarationPattern.test(groupsSource)).toBe(true);
    expect(callSites.length).toBe(2);
  });

  it('the getGroupLeaderboard function body reads groupMembers/{groupId}, derives memberUids from it via Object.keys, and calls loadMatches ONLY inside the memberUids.map callback', () => {
    const body = extractFunctionBody(groupsSource, 'getGroupLeaderboard');
    expect(body, 'could not locate getGroupLeaderboard in groups.ts').not.toBeNull();

    // The membership read.
    expect(body).toMatch(/database\.ref\(`groupMembers\/\$\{groupId\}`\)/);
    // memberUids is derived FROM that read's own result (membersRaw), not
    // from any other source.
    expect(body).toMatch(/memberUids\s*=\s*Object\.keys\(membersRaw\)/);
    // loadMatches is called with the map callback's OWN `uid` parameter,
    // nested inside `memberUids.map(async (uid) => { ... loadMatches(database, uid) ... })`
    // — never `callerUid` (the caller's own uid, a distinct parameter this
    // function also has) and never any other identifier.
    const mapCallMatch = body?.match(
      /memberUids\.map\(async \(uid\) => \{[\s\S]*?loadMatches\(database, uid\)[\s\S]*?\}\)/,
    );
    expect(
      mapCallMatch,
      "loadMatches must be called with the memberUids.map callback's own `uid` parameter",
    ).not.toBeNull();
    // The function's own caller-identity parameter is a DIFFERENT name
    // (callerUid, used only for the isYou comparison) and is never passed
    // to loadMatches.
    expect(body).toMatch(/entry\.uid === callerUid/);
    expect(body).not.toMatch(/loadMatches\(database, callerUid\)/);
  });

  it('FIXTURE: a hypothetical reference path built from an identifier OTHER than the membership-derived uid would fail the map-callback assertion above (proves the check is not vacuous)', () => {
    const violatingFixture = [
      'export async function getGroupLeaderboard(database, cache, callerUid, groupId) {',
      '  const membersSnapshot = await database.ref(`groupMembers/${groupId}`).get();',
      '  const membersRaw = membersSnapshot.exists() ? membersSnapshot.val() : {};',
      '  const memberUids = Object.keys(membersRaw);',
      "  // VIOLATION: reads the caller's OWN matches for every entry instead of each member's.",
      '  const matches = await loadMatches(database, callerUid);',
      '  return matches;',
      '}',
    ].join('\n');
    const violatingBody = extractFunctionBody(violatingFixture, 'getGroupLeaderboard');
    expect(violatingBody).not.toBeNull();
    const mapCallMatch = violatingBody?.match(
      /memberUids\.map\(async \(uid\) => \{[\s\S]*?loadMatches\(database, uid\)[\s\S]*?\}\)/,
    );
    expect(mapCallMatch).toBeNull();
  });
});
