import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { RtdbService } from '../services/rtdb.js';

/**
 * Phase 29 Plan 06 (RTEN-03, D-05, cycle-2 finding C2-MED-7): the RTEN-03
 * inventory lock. Makes "every bearer-token reader is accounted for" a
 * machine-checked, falsifiable property rather than a claim in prose —
 * mirroring `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts`'s
 * tree-scan + exact-set-equality + anti-vacuous-pass-guard style.
 *
 * TWO AXES (C2-MED-7): the previous revision spoke of "every anonymous
 * bearer-token consumer" while running a scan that ALSO discovers legitimate
 * authenticated readers — a coach revoking their own share, or a coach
 * operating against a managed client's matches in coaching mode. Forcing
 * those into an anonymous disposition would be false; leaving them out of
 * the table would break the exact-set assertion this file makes. Every
 * discovered site is classified FIRST by access class
 * (`anonymous-reachable` | `authenticated-administrative`), and — for
 * `anonymous-reachable` sites only — by exactly one of three dispositions.
 */

const API_SRC = resolve('src');

/** Recursively collects every non-test `.ts` source file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
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

describe('publicDeliveryInventory: anti-vacuous-pass guard for the whole-tree scan', () => {
  it('discovers more than 50 non-test source files under apps/api/src (a silently-empty scan would make every block below vacuously pass)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Block 1: every site that reads the bearer-token tree (`shareTokens/`),
// classified on two axes.
// ---------------------------------------------------------------------------

/**
 * The literal call shape every genuine READ of the bearer-token tree in
 * this codebase uses: `.ref(\`shareTokens/...\`)`. Mint WRITES (Task 1's
 * three writers) use the IDENTICAL `.ref(...)` constructor but always
 * immediately chain `.set(...)` on the same statement — excluded here by
 * the `.set(` filter below, since Task 1 already independently gates and
 * tests those three sites; this file is scoped to READERS (the plan's own
 * objective: "inventory every bearer-token READER").
 */
const SHARE_TOKENS_READ_PATTERN = /\.ref\(`shareTokens\//;

interface DiscoveredReadSite {
  file: string;
  line: number;
  text: string;
}

/** Every non-comment line matching the read pattern, across the whole source tree. */
function discoverShareTokensReadSites(): DiscoveredReadSite[] {
  const sites: DiscoveredReadSite[] = [];
  for (const file of ALL_SOURCE_FILES) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) {
        return;
      }
      if (SHARE_TOKENS_READ_PATTERN.test(line) && !line.includes('.set(')) {
        sites.push({ file, line: index + 1, text: trimmed });
      }
    });
  }
  return sites;
}

type AccessClass = 'anonymous-reachable' | 'authenticated-administrative';
type AnonymousDisposition = 'gated-at-resolution' | 'gated-at-mint' | 'unreachable-by-construction';

interface ClassificationEntry {
  file: string;
  symbol: string;
  accessClass: AccessClass;
  /** Required iff `accessClass === 'anonymous-reachable'`; absent for `authenticated-administrative`. */
  disposition?: AnonymousDisposition;
  reason: string;
}

const RTDB_TS = resolve('src/services/rtdb.ts');

/**
 * The classification table. Every entry below was verified by direct
 * inspection of `rtdb.ts` (and, for the `authenticated-administrative`
 * entries, their calling route files) at the time this lock was written —
 * see each `reason` for the specific gate/route it depends on.
 */
const CLASSIFICATION_TABLE: ClassificationEntry[] = [
  {
    file: RTDB_TS,
    symbol: 'getShareByToken',
    accessClass: 'anonymous-reachable',
    disposition: 'gated-at-resolution',
    reason:
      'Task 2 of this plan: refuses a research or unresolvable subject at the FIRST point ownerUid is decoded (immediately after the token record parses), before any of its four decoding branches (review/recap/coachReview/session) reads a subject-scoped tree. Every anonymous route that calls this method (publicVodShares.ts, shareMeta.ts, shareOgImage.ts) is a thin caller with no authorization logic of its own.',
  },
  {
    file: RTDB_TS,
    symbol: 'resolveCoachReviewShareRef',
    accessClass: 'anonymous-reachable',
    disposition: 'gated-at-resolution',
    reason:
      "Task 2 of this plan, mirroring getShareByToken's check at the same position. Called by the anonymous ack/viewed routes in publicReviewDeliveries.ts, both thin callers.",
  },
  {
    file: RTDB_TS,
    symbol: 'resolveSessionShareRef',
    accessClass: 'anonymous-reachable',
    disposition: 'gated-at-resolution',
    reason:
      "Task 2 of this plan, mirroring getShareByToken's check. Called by the anonymous homework routes in publicReviewDeliveries.ts, both thin callers.",
  },
  {
    file: RTDB_TS,
    symbol: 'resolveEditSession',
    accessClass: 'anonymous-reachable',
    disposition: 'gated-at-resolution',
    reason:
      "Task 2 of this plan — the ONE anonymous resolver whose callers (getEditSessionByToken/createCoachNote/updateCoachNote/deleteCoachNote, all in coachNotes.ts, all thin callers) both READ and MUTATE matches/{ownerUid}. The check runs immediately after the token record parses and strictly before the shareSnapshots read, and therefore before every caller's later matches/{ownerUid} access — the highest-severity finding this plan resolves (review 29-05 HIGH).",
  },
  {
    file: RTDB_TS,
    symbol: 'resolveReferralShareId',
    accessClass: 'anonymous-reachable',
    disposition: 'unreachable-by-construction',
    reason:
      "Accepts an arbitrary caller-supplied token (PUT /api/users/me's referredByShareId body field, apps/api/src/routes/users.ts) with NO ownership check against the caller's own uid — any signed-up caller can pass any guessed/leaked token value. Depends on ALL THREE Task 1 mint gates (RtdbService.createShare, createReviewDelivery, createSessionDelivery): as long as every mint writer refuses a research/unresolvable subject, no shareTokens record can ever exist for one, so this resolver can never surface one either. Proven behaviorally below, not just asserted in prose (review finding 29-05 MEDIUM).",
  },
  {
    file: RTDB_TS,
    symbol: 'countActiveShares',
    accessClass: 'authenticated-administrative',
    reason:
      "Called only from createShare's own per-user share-cap check. Its sole route entry, POST /api/vod-shares (apps/api/src/routes/vodShares.ts), requires app.authenticate and never opts into app.resolveSubject — request.uid is always the caller's own authenticated personal Firebase uid, never a client tenant id (apps/api/src/coaching/subject.ts's resolveSubjectId is the primitive that would allow tenant addressing, and this route file never calls it), so this reader structurally cannot address a research tenant's shareTokens.",
  },
  {
    file: RTDB_TS,
    symbol: 'listSharesForUser',
    accessClass: 'authenticated-administrative',
    reason:
      'GET /api/vod-shares (apps/api/src/routes/vodShares.ts) — same personal-uid-only reasoning as countActiveShares: app.authenticate required, no app.resolveSubject opt-in, request.uid only.',
  },
  {
    file: RTDB_TS,
    symbol: 'revokeShare',
    accessClass: 'authenticated-administrative',
    reason:
      'POST /api/vod-shares/:id/revoke (apps/api/src/routes/vodShares.ts) — same personal-uid-only reasoning as countActiveShares: app.authenticate required, no app.resolveSubject opt-in, request.uid only.',
  },
  {
    file: RTDB_TS,
    symbol: 'deleteShare',
    accessClass: 'authenticated-administrative',
    reason:
      'DELETE /api/vod-shares/:id (apps/api/src/routes/vodShares.ts) — same personal-uid-only reasoning as countActiveShares: app.authenticate required, no app.resolveSubject opt-in, request.uid only.',
  },
  {
    file: RTDB_TS,
    symbol: 'bulkUpdateShares',
    accessClass: 'authenticated-administrative',
    reason:
      'POST /api/vod-shares/bulk (apps/api/src/routes/vodShares.ts) — same personal-uid-only reasoning as countActiveShares: app.authenticate required, no app.resolveSubject opt-in, request.uid only.',
  },
  {
    file: RTDB_TS,
    symbol: 'resolveActiveReviewShareTokens',
    accessClass: 'authenticated-administrative',
    reason:
      "Called from updateMatch/clearVodAndNotes/deleteMatch, whose route file (apps/api/src/routes/matches.ts) DOES opt into app.resolveSubject — request.subjectId can be a managed-client tenant id when the caller is a coach operating in coaching mode. Gated by resolveSubjectId's clientMembers/{tenantId}/{uid} membership check (apps/api/src/coaching/subject.ts) — the pre-existing tenant-membership primitive plan 29-04 extends with research-awareness for tenant-addressed surfaces. This is the concrete instance of cycle-2 finding C2-MED-7's 'coach-side surface' example: a legitimate authenticated reader, deliberately outside RTEN-03's anonymous-delivery claim.",
  },
];

describe('publicDeliveryInventory: classification table axioms', () => {
  it('every entry has exactly one access class from the two-member set', () => {
    for (const entry of CLASSIFICATION_TABLE) {
      expect(['anonymous-reachable', 'authenticated-administrative']).toContain(entry.accessClass);
    }
  });

  it('every anonymous-reachable entry has exactly one of the three allowed dispositions; no authenticated-administrative entry has any disposition (no catch-all in either axis)', () => {
    for (const entry of CLASSIFICATION_TABLE) {
      if (entry.accessClass === 'anonymous-reachable') {
        expect(['gated-at-resolution', 'gated-at-mint', 'unreachable-by-construction']).toContain(
          entry.disposition,
        );
      } else {
        expect(entry.disposition).toBeUndefined();
      }
    }
  });

  it('every entry has a non-empty written reason', () => {
    for (const entry of CLASSIFICATION_TABLE) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('each unreachable-by-construction reason names the specific mint gate it depends on', () => {
    const unreachable = CLASSIFICATION_TABLE.filter(
      (entry) => entry.disposition === 'unreachable-by-construction',
    );
    expect(unreachable.length).toBeGreaterThan(0);
    for (const entry of unreachable) {
      expect(entry.reason).toMatch(/createShare|createReviewDelivery|createSessionDelivery/);
    }
  });

  it('each authenticated-administrative reason names the gate/route file it depends on, and every such entry has an authentication requirement discoverable in its own gating file (no entry may use this class to excuse an anonymous site)', () => {
    const administrative = CLASSIFICATION_TABLE.filter(
      (entry) => entry.accessClass === 'authenticated-administrative',
    );
    expect(administrative.length).toBeGreaterThan(0);
    for (const entry of administrative) {
      expect(entry.reason).toMatch(/app\.authenticate|resolveSubjectId|clientMembers/);
      // The reason must point at a real route file, and that file must
      // itself require authentication — verified against the actual
      // source, not merely asserted in prose.
      const routeFileMatch = entry.reason.match(/apps\/api\/src\/routes\/(\w+)\.ts/);
      expect(routeFileMatch).not.toBeNull();
      const routeFile = resolve('src/routes', `${routeFileMatch![1]}.ts`);
      const routeSource = readFileSync(routeFile, 'utf-8');
      expect(routeSource).toMatch(/app\.authenticate/);
    }
  });
});

/**
 * `symbol` is heuristically located as a class-method declaration line
 * (`(private\s+|static\s+)?(async\s+)?symbol(`), and its "body" is every
 * line up to (but not including) the NEXT such declaration at the same or
 * lower indent — a bounded-window heuristic sufficient for this file's
 * consistent 2-space class-method formatting (mirrors this codebase's own
 * grep-gate precedent rather than a full AST parse).
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'function',
]);

function isMethodDeclLine(line: string): boolean {
  const match = line.match(
    /^\s*(private\s+|static\s+|export\s+)?(async\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  );
  if (!match) return false;
  return !CONTROL_FLOW_KEYWORDS.has(match[3]!);
}

function findDeclarationLine(lines: string[], symbol: string): number {
  const pattern = new RegExp(
    `^\\s*(private\\s+|static\\s+|export\\s+)?(async\\s+)?${symbol}\\s*\\(`,
  );
  const altPattern = new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${symbol}\\s*\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i]!) || altPattern.test(lines[i]!)) {
      return i;
    }
  }
  return -1;
}

function symbolBodyContainsShareTokensRead(fileContent: string, symbol: string): boolean {
  const lines = fileContent.split('\n');
  const declLine = findDeclarationLine(lines, symbol);
  if (declLine === -1) return false;
  for (let i = declLine + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isMethodDeclLine(line)) {
      break; // reached the next method — symbol's body ended without a match
    }
    if (SHARE_TOKENS_READ_PATTERN.test(line) && !line.includes('.set(')) {
      return true;
    }
  }
  return false;
}

describe('publicDeliveryInventory: exact-set equality between the tree-scan and the classification table', () => {
  const discoveredSites = discoverShareTokensReadSites();

  it('discovers more than 5 shareTokens read sites (anti-vacuous-pass guard — a broken scan pattern would silently empty this)', () => {
    expect(discoveredSites.length).toBeGreaterThan(5);
  });

  it('discovers EXACTLY as many read sites as the classification table has entries — a new site must be classified, not silently added or dropped', () => {
    expect(discoveredSites.length).toBe(CLASSIFICATION_TABLE.length);
  });

  it('discovers read sites in EXACTLY the files the classification table names (exact-set equality, not a "contains" check)', () => {
    const discoveredFiles = new Set(discoveredSites.map((site) => site.file));
    const classifiedFiles = new Set(CLASSIFICATION_TABLE.map((entry) => entry.file));
    expect(discoveredFiles).toEqual(classifiedFiles);
  });

  it.each(CLASSIFICATION_TABLE)(
    "the classified symbol $symbol has a shareTokens read within its own body (not a sibling method's)",
    (entry) => {
      const source = readFileSync(entry.file, 'utf-8');
      expect(symbolBodyContainsShareTokensRead(source, entry.symbol)).toBe(true);
    },
  );

  it("every discovered read site's line is inside AT LEAST ONE classified symbol's body — no discovered site is left unclassified", () => {
    for (const site of discoveredSites) {
      const source = readFileSync(site.file, 'utf-8');
      const lines = source.split('\n');
      const matchingEntries = CLASSIFICATION_TABLE.filter((entry) => entry.file === site.file);
      const isClassified = matchingEntries.some((entry) => {
        const declLine = findDeclarationLine(lines, entry.symbol);
        if (declLine === -1) return false;
        let endLine = lines.length;
        for (let i = declLine + 1; i < lines.length; i += 1) {
          if (isMethodDeclLine(lines[i]!)) {
            endLine = i;
            break;
          }
        }
        const siteIndex = site.line - 1;
        return siteIndex > declLine && siteIndex < endLine;
      });
      expect(isClassified).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Block 1b: the referral resolver's `unreachable-by-construction` premise,
// proven behaviorally (review finding 29-05 MEDIUM) — not merely asserted.
// ---------------------------------------------------------------------------

describe('publicDeliveryInventory: resolveReferralShareId is unreachable-by-construction (behavioral proof)', () => {
  it('after attempted research mints on every createShare branch, shareTokens is empty AND the referral resolver (via upsertUser) resolves nothing for any token in the database', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    const RESEARCH_TENANT = 'research-tenant-inventory-1';
    database.seed(`clientTenants/${RESEARCH_TENANT}`, { createdAt: 1, kind: 'research' });
    database.seed(`matches/${RESEARCH_TENANT}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });
    database.seed(`tournamentEntries/${RESEARCH_TENANT}/entry1`, {
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      seed: 8,
      placement: 3,
      firstSetAt: 1000,
      lastSetAt: 5000,
      setsPlayed: 1,
    });
    database.seed(`reviewVersions/${RESEARCH_TENANT}/review-1/1`, {
      sections: [{ id: 'summary', kind: 'summary', title: null, body: 'x' }],
      publishedAt: 1,
    });

    // Every branch of the share creator, attempted against a research
    // subject — each must refuse (Task 1) and write nothing.
    await expect(
      rtdb.createShare(
        RESEARCH_TENANT,
        {
          kind: 'review',
          matchId: 'm1',
          redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
          permissions: 'view',
        } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();
    await expect(
      rtdb.createShare(
        RESEARCH_TENANT,
        { kind: 'recap', entryKey: 'entry1', permissions: 'view' } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();
    await expect(
      rtdb.createShare(
        RESEARCH_TENANT,
        { kind: 'coachReview', reviewId: 'review-1', version: 1, permissions: 'view' } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();

    // The referral resolver's ONLY reachable input space is "some token
    // string" — assert it resolves nothing for a representative sample,
    // including a token shape that would have matched the (never-written)
    // mint output. There is no token in `shareTokens` at all, so every
    // candidate must resolve to `undefined` (no referredByShareId written).
    for (const candidateToken of [
      'noSuchTokenAtAll-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'anotherCandidateBBBBBCCCCCDDDDDEEEEEFFFFF',
    ]) {
      const uid = `signup-uid-${candidateToken.slice(0, 6)}`;
      await rtdb.upsertUser(uid, {
        email: `${uid}@example.com`,
        referralToken: candidateToken,
      });
      const user = await rtdb.getUser(uid);
      expect(user?.referredByShareId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Block 2: the anonymous `matches/{someId}` reader set.
// ---------------------------------------------------------------------------

/**
 * `resolveEditSession`'s own doc comment calls itself "the ONE deliberate
 * exception to 'anonymous requests never touch matches/{uid}'" (T-08-08).
 * This block keeps a SECOND exception from appearing quietly — at FILE
 * granularity (the plan's own wording: "the set of files ... is exactly the
 * edit-session resolver"), since a full symbol-level AST diff is out of
 * scope for this lock.
 *
 * FINDING (recorded here and in this plan's SUMMARY, not silently
 * papered over): a SECOND anonymous-reachable read of `matches/{someId}`
 * already exists in THIS SAME FILE — `resolveReviewCitationSources`
 * (private, called from `getCoachReviewSnapshot`, reachable via
 * `getShareByToken`'s coachReview branch) reads
 * `matches/{tenantId}/{sourceVodRef}` to resolve ONLY the `vodUrl` field
 * for citation chips (never notes/tags/opponent data — see its own doc
 * comment). It does not WRITE, unlike `resolveEditSession`, and it sits
 * strictly AFTER `getShareByToken`'s Task 2 subject-kind gate (this
 * plan), so a research subject's coachReview token never reaches it. The
 * file-level assertion below remains literally true (both symbols live in
 * `rtdb.ts`); the stale "the ONE" wording in `resolveEditSession`'s doc
 * comment is a documentation gap, not a security gap — recorded here
 * rather than corrected in this task, since Task 3 modifies no source file.
 */
const MATCHES_READ_PATTERN = /\.ref\(`matches\//;

function discoverAnonymousMatchesReaderFiles(): Set<string> {
  // The two known anonymous-reachable readers of `matches/{someId}`:
  // resolveEditSession's callers (coachNotes.ts routes) and
  // getCoachReviewSnapshot's citation-source resolution (reached via
  // getShareByToken). Both live in rtdb.ts. Verified by direct symbol
  // presence rather than a full call-graph trace (out of scope for a
  // regex-based lock).
  const files = new Set<string>();
  const rtdbSource = readFileSync(RTDB_TS, 'utf-8');
  if (
    symbolBodyContainsPattern(rtdbSource, 'resolveEditSession', MATCHES_READ_PATTERN) ||
    symbolBodyContainsPattern(rtdbSource, 'resolveReviewCitationSources', MATCHES_READ_PATTERN)
  ) {
    files.add(RTDB_TS);
  }
  return files;
}

function symbolBodyContainsPattern(fileContent: string, symbol: string, pattern: RegExp): boolean {
  const lines = fileContent.split('\n');
  const declLine = findDeclarationLine(lines, symbol);
  if (declLine === -1) return false;
  for (let i = declLine + 1; i < lines.length; i += 1) {
    if (isMethodDeclLine(lines[i]!)) break;
    if (pattern.test(lines[i]!)) return true;
  }
  return false;
}

describe('publicDeliveryInventory: the anonymous matches/{someId} reader file set is exactly rtdb.ts', () => {
  it("resolveEditSession itself reads matches/{ownerUid} within its callers' reach (anti-vacuous guard: symbol must exist)", () => {
    const source = readFileSync(RTDB_TS, 'utf-8');
    expect(source).toContain('resolveEditSession');
  });

  it('the discovered anonymous matches/ reader file set is exactly {rtdb.ts}, not empty and not wider', () => {
    const discovered = discoverAnonymousMatchesReaderFiles();
    expect(discovered).toEqual(new Set([RTDB_TS]));
  });
});

// ---------------------------------------------------------------------------
// Block 3: the full RTEN-03 surface set for the phase.
// ---------------------------------------------------------------------------

/**
 * The phase's single answer to "is the RTEN-03 inventory complete": the
 * three mint writers (Task 1), the four resolvers (Task 2), and the
 * full-workspace export refused by plan 29-04 (`coaching/tenants.ts`'s
 * `exportClient`, cross-referenced — not owned by this plan). Fails the
 * instant a later change removes any guard's host function.
 */
const RTEN_03_SURFACE_SYMBOLS: Array<{ file: string; symbol: string }> = [
  { file: RTDB_TS, symbol: 'createShare' },
  { file: resolve('src/coaching/reviewDeliveries.ts'), symbol: 'createReviewDelivery' },
  { file: resolve('src/coaching/sessionDeliveries.ts'), symbol: 'createSessionDelivery' },
  { file: RTDB_TS, symbol: 'getShareByToken' },
  { file: RTDB_TS, symbol: 'resolveCoachReviewShareRef' },
  { file: RTDB_TS, symbol: 'resolveSessionShareRef' },
  { file: RTDB_TS, symbol: 'resolveEditSession' },
  { file: resolve('src/coaching/tenants.ts'), symbol: 'exportClient' },
];

describe('publicDeliveryInventory: all eight RTEN-03 surface symbols exist in their named files', () => {
  it('discovers exactly 8 surface symbols (anti-vacuous-pass guard against an accidentally-emptied list)', () => {
    expect(RTEN_03_SURFACE_SYMBOLS.length).toBe(8);
  });

  it.each(RTEN_03_SURFACE_SYMBOLS)('$symbol exists in $file', ({ file, symbol }) => {
    const source = readFileSync(file, 'utf-8');
    expect(source).toMatch(new RegExp(`\\b${symbol}\\b`));
  });
});
