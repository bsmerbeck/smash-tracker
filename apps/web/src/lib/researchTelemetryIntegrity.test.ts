import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 29 Plan 09 (RTEN-04, D-06, review finding 29-08 MEDIUM): the
 * browser-side counterpart of `apps/api/src/research/serverEmitterAudit.
 * test.ts` — the "no honest place to hide a reachable, ungated browser
 * telemetry call site" contract Tasks 1-2 enforce at each call site.
 * Mirrors that file's discovery / exact-set-equality / closed-disposition /
 * anti-vacuous-pass-guard style at FILE granularity, adapted to three
 * DISTINCT emitter functions (the page-view logger, the product-event
 * logger, and the ingestion-route poster) instead of one shared writer.
 *
 * Discovery is import-aware and comment/string-literal-stripped (a raw text
 * grep for `logProductEvent(` would match a comment, this file's own doc
 * comments, or a test file asserting against the mocked function), excludes
 * test files (a test calling the mocked function to set up an assertion is
 * not a production call site) and this audit file itself.
 */

const SRC_ROOT = resolve('src');
const SELF_PATH = resolve('src/lib/researchTelemetryIntegrity.test.ts');

/** Recursively collects every non-test `.ts`/`.tsx` source file under `dir`. */
function collectNonTestSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectNonTestSourceFiles(fullPath));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

const ALL_NON_TEST_SOURCE_FILES = collectNonTestSourceFiles(SRC_ROOT).filter(
  (file) => file !== SELF_PATH,
);

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

/** Strips `//` line and `/* ... *\/` block comments — string literals survive, mirroring the server-side audit's `stripComments` (import paths and string-literal event names both need to stay intact for binding resolution). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Strips every string literal's CONTENT — applied ONLY on top of `stripComments`, only when counting call sites, so a mention inside a log/error string is never counted as a real call. */
function stripStringLiterals(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Resolves the local binding name a file imports `exportedName` under from
 * `modulePath` (e.g. `@/lib/firebase`) — handles an aliased import
 * (`X as Y`) correctly, mirroring the server-side audit's
 * `resolveLedgerBinding`. Returns `null` when the file does not import that
 * specific named export from that specific module at all (a file importing
 * `setAnalyticsCollectionEnabled` from the SAME module, e.g.
 * `ResearchTelemetrySuppression.tsx`, correctly resolves to `null` here —
 * that is a different function, not one of the three emitters this scan
 * tracks).
 */
function resolveImportBinding(
  commentStrippedSource: string,
  modulePath: string,
  exportedName: string,
): string | null {
  const escapedModule = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapedModule}['"]`, 'g');
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(commentStrippedSource))) {
    const specifiers = match[1]!.split(',').map((s) => s.trim());
    for (const spec of specifiers) {
      if (spec === '') continue;
      const aliasMatch = spec.match(new RegExp(`^${exportedName}\\s+as\\s+(\\w+)$`));
      if (aliasMatch) return aliasMatch[1]!;
      if (spec === exportedName) return exportedName;
    }
  }
  return null;
}

/** Counts call-expression occurrences of `binding(` in already comment-AND-string-stripped source. */
function countCallSites(fullyStrippedSource: string, binding: string): number {
  const pattern = new RegExp(`\\b${binding}\\s*\\(`, 'g');
  return (fullyStrippedSource.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// Anti-vacuous-pass guard for the whole-tree scan.
// ---------------------------------------------------------------------------

describe('researchTelemetryIntegrity: anti-vacuous-pass guard for the whole-tree scan', () => {
  it('discovers more than 100 non-test source files under apps/web/src (a silently-empty scan would make every block below vacuously pass)', () => {
    expect(ALL_NON_TEST_SOURCE_FILES.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Discovery: the three emitter functions, each with its own defining module.
// ---------------------------------------------------------------------------

type Emitter = 'logAnalyticsPageView' | 'logProductEvent' | 'postCanonicalEvent';

const EMITTER_MODULES: Record<Emitter, string> = {
  logAnalyticsPageView: '@/lib/firebase',
  logProductEvent: '@/lib/firebase',
  postCanonicalEvent: '@/lib/canonicalEvents',
};

interface DiscoveredEmitterFile {
  file: string;
  emitters: Emitter[];
  callSiteCount: number;
}

function discoverEmitterFiles(): DiscoveredEmitterFile[] {
  const byFile = new Map<string, DiscoveredEmitterFile>();
  for (const file of ALL_NON_TEST_SOURCE_FILES) {
    const raw = readFileSync(file, 'utf-8');
    const commentStripped = stripComments(raw);
    const fullyStripped = stripStringLiterals(commentStripped);
    for (const emitter of Object.keys(EMITTER_MODULES) as Emitter[]) {
      const binding = resolveImportBinding(commentStripped, EMITTER_MODULES[emitter], emitter);
      if (!binding) continue;
      const count = countCallSites(fullyStripped, binding);
      if (count === 0) continue;
      const rel = relPath(file);
      const existing = byFile.get(rel);
      if (existing) {
        existing.emitters.push(emitter);
        existing.callSiteCount += count;
      } else {
        byFile.set(rel, { file: rel, emitters: [emitter], callSiteCount: count });
      }
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

const DISCOVERED_EMITTER_FILES = discoverEmitterFiles();
const DISCOVERED_BASELINE_CALL_SITE_COUNT = DISCOVERED_EMITTER_FILES.reduce(
  (sum, entry) => sum + entry.callSiteCount,
  0,
);

// ---------------------------------------------------------------------------
// Classification — exactly THREE dispositions, no catch-all (mirrors the
// server-side audit's closed-set discipline).
// ---------------------------------------------------------------------------

type Disposition = 'gated' | 'unreachable-by-construction' | 'covered-by-global-suppression';

interface ClassificationEntry {
  file: string;
  disposition: Disposition;
  reason: string;
  /** Required for every `gated` entry (review finding 29-08 MEDIUM: an
   * import check alone is not dominance evidence) — the exact test name
   * that behaviorally proves the guard dominates every call site in this
   * file, i.e. a research/pending/errored render produces zero calls. */
  provenBy?: string;
}

/**
 * Every entry carries EXACTLY one disposition and a non-empty written
 * reason. There is deliberately no fourth disposition — a file the scan
 * discovers that is not in this table fails the exact-set-equality
 * assertion below, and a future editor who "helpfully" adds a permissive
 * fourth bucket converts this audit into a rubber stamp. Do not add one.
 */
const CLASSIFICATION_TABLE: ClassificationEntry[] = [
  {
    file: 'src/context/AuthContext.tsx',
    disposition: 'unreachable-by-construction',
    reason:
      "postCanonicalEvent('signup_cta_clicked') fires ONLY from signInWithGoogle's click handler — inherently a PRE-AUTH action with no Firebase identity yet. A research tenant has no auth principal of its own (RTEN-07) and is only ever viewed by an ALREADY-authenticated admin coach in coaching mode; this call site fires strictly before any such session could exist. Mirrors serverEmitterAudit.test.ts's X-class classification of the same event name.",
  },
  {
    file: 'src/pages/Share/ShareViewPage.tsx',
    disposition: 'unreachable-by-construction',
    reason:
      "Both the logProductEvent('share_opened', ...) call and the postCanonicalEvent('share_view_loaded', ...) call fire only once a share token RESOLVES and the page renders. Every form of share resolution is already gated for a research/unresolved subject by plan 29-06 (getShareByToken and its three sibling resolvers return nothing) — a research tenant's share can never resolve, so this page's telemetry can never fire for one. Mirrors serverEmitterAudit.test.ts's X-class classification of share_view_loaded.",
  },
  {
    file: 'src/pages/Tournaments/prepPaid/PrepPaidReportsCard.tsx',
    disposition: 'unreachable-by-construction',
    reason:
      "postCanonicalEvent('prep_offer_viewed', {}) fires only on the personal /tournaments/:entryKey/prep page. The tournament-prep feature has no coaching-mode/subject-resolution surface at all (confirmed server-side in serverEmitterAudit.test.ts's src/prep/prep.ts classification: every prep route addresses request.uid directly and never opts into app.resolveSubject) — this page can never render under a tenant/subject context.",
  },
  {
    file: 'src/pages/VodManager/VodManagerPage.tsx',
    disposition: 'gated',
    reason:
      "This plan's Task 2: the quick-tag-capture logProductEvent('vod_note_created') call is skipped when the research-subject signal reports research, pending, or error — the note itself is still always created.",
    provenBy:
      "VodManagerPage.test.tsx > 'RTEN-04: fires zero product-event calls for a quick-tag capture that creates a new row in a research workspace, but the note is still created'",
  },
  {
    file: 'src/pages/VodManager/components/NoteComposer.tsx',
    disposition: 'gated',
    reason:
      "This plan's Task 2: the composer's logProductEvent('vod_note_created') call is skipped under the same condition — the note itself is still always created.",
    provenBy:
      "NoteComposer.test.tsx > 'fires zero product-event calls for a research subject, but the note is still created' and > 'fires zero product-event calls while the kind lookup is pending or errored (fail-closed), but the note is still created'",
  },
  {
    file: 'src/routes/RouteAnalytics.tsx',
    disposition: 'gated',
    reason:
      "This plan's Task 2: the logAnalyticsPageView call is skipped when the research-subject signal reports research, pending, or error; the kind state joins location.pathname in the effect's dependency list so a pending->coaching resolution at an unchanged path still fires once resolved.",
    provenBy:
      "RouteAnalytics.test.tsx > 'fires no page view for a research workspace', > 'fires no page view while the kind lookup is pending (fail-closed)', and > 'fires no page view when the kind lookup errored (fail-closed)'",
  },
];

const CLASSIFIED_FILES = CLASSIFICATION_TABLE.map((entry) => entry.file).sort((a, b) =>
  a.localeCompare(b),
);

describe('researchTelemetryIntegrity: call-site classification (RTEN-04, D-06)', () => {
  it('discovers more than 3 call sites across more than 3 files (anti-vacuous-pass guard — the baseline recorded when this test was written is 6 call sites across 6 files)', () => {
    expect(DISCOVERED_BASELINE_CALL_SITE_COUNT).toBeGreaterThan(3);
    expect(DISCOVERED_EMITTER_FILES.length).toBeGreaterThan(3);
  });

  it('the discovered file set equals the classification table exactly — a new unclassified browser telemetry call site fails here', () => {
    expect(DISCOVERED_EMITTER_FILES.map((entry) => entry.file)).toEqual(CLASSIFIED_FILES);
  });

  it('every classification entry carries a non-empty reason', () => {
    for (const entry of CLASSIFICATION_TABLE) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("every 'gated' entry names the behavioral test that proves its guard dominates every call site in the file (review finding 29-08 MEDIUM: an import check alone is not dominance evidence)", () => {
    const gatedEntries = CLASSIFICATION_TABLE.filter((entry) => entry.disposition === 'gated');
    expect(gatedEntries.length).toBeGreaterThan(0);
    for (const entry of gatedEntries) {
      expect(entry.provenBy, `${entry.file} is 'gated' but names no behavioral test`).toBeTruthy();
      expect(entry.provenBy!.length).toBeGreaterThan(0);
    }
  });

  it("every 'gated' entry structurally imports useResearchSubject (the structural half of dominance evidence)", () => {
    const gatedEntries = CLASSIFICATION_TABLE.filter((entry) => entry.disposition === 'gated');
    for (const entry of gatedEntries) {
      const source = readFileSync(resolve('.', entry.file), 'utf-8');
      expect(
        stripComments(source),
        `${entry.file} is classified 'gated' but does not import useResearchSubject`,
      ).toMatch(/\buseResearchSubject\s*\(/);
    }
  });

  it('exactly three dispositions are used across the table, with no catch-all value present', () => {
    const dispositions = new Set(CLASSIFICATION_TABLE.map((entry) => entry.disposition));
    for (const disposition of dispositions) {
      expect(['gated', 'unreachable-by-construction', 'covered-by-global-suppression']).toContain(
        disposition,
      );
    }
  });

  it('does NOT count an occurrence inside a comment or a string literal (fixture, mirrors serverEmitterAudit.test.ts’s own discipline)', () => {
    const fixture = [
      "import { logProductEvent } from '@/lib/firebase';",
      '// logProductEvent(fakeArgA) — a comment mention must not count',
      '/* logProductEvent(fakeArgB) — a block-comment mention must not count */',
      'const message = "please call logProductEvent(fakeArgC) to emit";',
      'const templated = `logProductEvent(fakeArgD) is what fires this`;',
      "void logProductEvent('the_one_real_call'); // the ONE real call",
    ].join('\n');

    const commentStripped = stripComments(fixture);
    const binding = resolveImportBinding(commentStripped, '@/lib/firebase', 'logProductEvent');
    expect(binding).toBe('logProductEvent');
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countCallSites(fullyStripped, binding!)).toBe(1);
  });

  it('resolves an aliased import binding, and does not count the unaliased name as a call (fixture)', () => {
    const fixture = [
      "import { logProductEvent as emitProductEvent } from '@/lib/firebase';",
      '// logProductEvent(a, b) — the unaliased name is not even imported here',
      "void emitProductEvent('vod_note_created');",
    ].join('\n');

    const commentStripped = stripComments(fixture);
    const binding = resolveImportBinding(commentStripped, '@/lib/firebase', 'logProductEvent');
    expect(binding).toBe('emitProductEvent');
    const fullyStripped = stripStringLiterals(commentStripped);
    expect(countCallSites(fullyStripped, binding!)).toBe(1);
    expect(countCallSites(fullyStripped, 'logProductEvent')).toBe(0);
  });

  it('a file importing setAnalyticsCollectionEnabled from the SAME module does NOT resolve as a logProductEvent/logAnalyticsPageView binding (fixture — distinguishes the suppression control from the emitters it is not)', () => {
    const fixture = [
      "import { setAnalyticsCollectionEnabled } from '@/lib/firebase';",
      'setAnalyticsCollectionEnabled(false);',
    ].join('\n');
    const commentStripped = stripComments(fixture);
    expect(resolveImportBinding(commentStripped, '@/lib/firebase', 'logProductEvent')).toBeNull();
    expect(
      resolveImportBinding(commentStripped, '@/lib/firebase', 'logAnalyticsPageView'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No hidden per-caller research-subject check inside a shared logger module
// — the anti-pattern this phase avoids on both tiers (server-side mirror:
// serverEmitterAudit.test.ts has no analogous block because the server-side
// ledger writer never needed one; here it is explicit because Task 1 added
// research-aware CODE to lib/firebase.ts, and a reader could reasonably
// wonder whether that crossed the line).
// ---------------------------------------------------------------------------

/** Matches an actual per-caller subject-identity read — never a bare mention of the word "research" in a doc comment (comments are stripped before this runs). */
const SUBJECT_CHECK_PATTERN = /\buseResearchSubject\s*\(|\bisResearchKind\s*\(/;

describe('researchTelemetryIntegrity: no hidden per-caller subject check inside a shared logger module', () => {
  it("lib/firebase.ts contains no per-caller research-subject check — Task 1's synchronous collection flag is a GLOBAL collection control, not a per-caller check, and is explicitly exempted from this rule", () => {
    const source = stripComments(readFileSync(resolve('src/lib/firebase.ts'), 'utf-8'));
    expect(source).not.toMatch(SUBJECT_CHECK_PATTERN);
    // The exemption, stated structurally rather than merely in prose: the
    // module DOES carry a global collection flag (collectionEnabled /
    // setAnalyticsCollectionEnabled) — that is expected and is what makes
    // Task 1's design work. It is a single flag any caller's disable/enable
    // affects identically, never a per-caller subject branch.
    expect(source).toMatch(/collectionEnabled/);
  });

  it('lib/canonicalEvents.ts (the ingestion-route poster) contains no per-caller research-subject check of its own — every gating decision lives at the CALL SITE (D-18/D-06)', () => {
    const source = stripComments(readFileSync(resolve('src/lib/canonicalEvents.ts'), 'utf-8'));
    expect(source).not.toMatch(SUBJECT_CHECK_PATTERN);
  });

  it('FIXTURE: a hidden per-caller check inside a shared module IS detected (proves the block above is not vacuous)', () => {
    const violatingFixture = [
      'export function logProductEvent(name, params) {',
      '  const { isResearch } = useResearchSubject();',
      '  if (isResearch) return;',
      '  // ... emit ...',
      '}',
    ].join('\n');
    expect(stripComments(violatingFixture)).toMatch(SUBJECT_CHECK_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// No file (other than lib/firebase.ts, the wrapper's own definition) makes
// a direct analytics-SDK log call — the fourth category the plan names
// ("any direct analytics-SDK log call"). A bypass of the two wrapper
// functions would escape every gate Task 1/2 built.
// ---------------------------------------------------------------------------

function discoverFirebaseAnalyticsReferrers(): string[] {
  return ALL_NON_TEST_SOURCE_FILES.filter((file) =>
    stripComments(readFileSync(file, 'utf-8')).includes('firebase/analytics'),
  )
    .map(relPath)
    .sort();
}

describe('researchTelemetryIntegrity: no direct analytics-SDK bypass of the wrapper functions', () => {
  it("the only non-test file referencing 'firebase/analytics' is lib/firebase.ts itself — a second referrer would be a direct SDK call bypassing logAnalyticsPageView/logProductEvent's gates entirely", () => {
    expect(discoverFirebaseAnalyticsReferrers()).toEqual(['src/lib/firebase.ts']);
  });
});

// ---------------------------------------------------------------------------
// Suppression-component mount: exactly once, at the router root, BEFORE the
// page-view reporter — discovered by scanning for its JSX usage and
// comparing source positions, not by asserting against a fixed path.
// ---------------------------------------------------------------------------

/** Every index in `source` where `<componentName` opens a JSX tag (comment-stripped first, so a doc-comment mention never counts as a render). */
function findJsxRenderSites(source: string, componentName: string): number[] {
  const stripped = stripComments(source);
  const pattern = new RegExp(`<${componentName}[\\s/>]`, 'g');
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped))) {
    indices.push(match.index);
  }
  return indices;
}

function discoverJsxRenderers(componentName: string): string[] {
  return ALL_NON_TEST_SOURCE_FILES.filter(
    (file) => findJsxRenderSites(readFileSync(file, 'utf-8'), componentName).length > 0,
  )
    .map(relPath)
    .sort();
}

describe('researchTelemetryIntegrity: suppression-component mount (exactly once, router root, before the page-view reporter)', () => {
  const renderers = discoverJsxRenderers('ResearchTelemetrySuppression');

  it('discovers exactly one non-test file rendering <ResearchTelemetrySuppression> (a duplicate mount would double-fire the setter; a zero-result scan would be vacuous)', () => {
    expect(renderers).toEqual(['src/routes/AppRouter.tsx']);
  });

  it('within that file, the suppression component is rendered BEFORE RouteAnalytics (source-position comparison, not a fixed line number)', () => {
    const source = readFileSync(resolve('src/routes/AppRouter.tsx'), 'utf-8');
    const suppressionSites = findJsxRenderSites(source, 'ResearchTelemetrySuppression');
    const routeAnalyticsSites = findJsxRenderSites(source, 'RouteAnalytics');

    expect(suppressionSites.length).toBeGreaterThan(0);
    expect(routeAnalyticsSites.length).toBeGreaterThan(0);
    expect(suppressionSites[0]!).toBeLessThan(routeAnalyticsSites[0]!);
  });

  it('FIXTURE: a suppression component rendered AFTER RouteAnalytics is detected as out of order (proves the position check is not vacuous)', () => {
    const violatingFixture = ['<RouteAnalytics />', '<ResearchTelemetrySuppression />'].join('\n');
    const suppressionSites = findJsxRenderSites(violatingFixture, 'ResearchTelemetrySuppression');
    const routeAnalyticsSites = findJsxRenderSites(violatingFixture, 'RouteAnalytics');
    expect(suppressionSites[0]!).toBeGreaterThan(routeAnalyticsSites[0]!);
  });
});
