import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-02, D-08):
 * structural lock over the unverified-snapshot label's four properties —
 * single composition, universal route coverage, chrome coverage, and
 * locale parity — so none of them can regress silently. Mirrors
 * `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts`'s
 * discovery/exact-set-equality/anti-vacuous-pass style rather than
 * reinventing it: every block below builds its input by directory scan or
 * router-source traversal, never from a hand-maintained array of file
 * paths.
 */

const SELF_PATH = resolve('src/pages/Coaching/researchLabelIntegrity.test.ts');
const SRC_ROOT = resolve('src');

/** Strips `/* ... *\/` block comments and `// ...` line comments so a prose mention inside a doc comment never counts as a real reference. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Recursively collects every `.ts`/`.tsx` source file under `dir`, INCLUDING test files (the single-composition proof must be able to discover a duplicate banner mounted from a test file's own render helper, not just production code). */
function collectAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAllSourceFiles(fullPath));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

// -----------------------------------------------------------------------
// Block 1: single-composition proof (D-08)
// -----------------------------------------------------------------------

describe('research label single-composition proof (D-08)', () => {
  // Self-excluded: this file necessarily mentions "ResearchSnapshotBanner"
  // in prose/expected-set literals below, which would otherwise make it a
  // false positive of its own scan.
  const allSourceFiles = collectAllSourceFiles(SRC_ROOT).filter((file) => file !== SELF_PATH);

  it('discovers more than 100 source files (anti-vacuous-pass guard — an empty or near-empty scan would make the equality check below meaningless)', () => {
    expect(allSourceFiles.length).toBeGreaterThan(100);
  });

  it('the set of files referencing ResearchSnapshotBanner (comment-stripped, so a doc-comment mention does not count as a render) is EXACTLY {the component, its own test, ClientWorkspaceLayout} — exact-set equality, not a containment check', () => {
    const referencing = allSourceFiles.filter((file) =>
      stripComments(readFileSync(file, 'utf-8')).includes('ResearchSnapshotBanner'),
    );
    const expected = [
      resolve('src/pages/Coaching/ClientWorkspaceLayout.tsx'),
      resolve('src/pages/Coaching/components/ResearchSnapshotBanner.test.tsx'),
      resolve('src/pages/Coaching/components/ResearchSnapshotBanner.tsx'),
    ];
    expect(referencing.sort()).toEqual(expected);
  });
});

// -----------------------------------------------------------------------
// Block 2: universal-coverage proof
// -----------------------------------------------------------------------

const APP_ROUTER_PATH = resolve('src/routes/AppRouter.tsx');
const appRouterSource = readFileSync(APP_ROUTER_PATH, 'utf-8');

interface RouteToken {
  type: 'open' | 'close';
  selfClosing: boolean;
  attrs: string;
  end: number;
}

/**
 * Tokenizes every `<Route ...>`/`<Route .../>`/`</Route>` occurrence in
 * `source` starting at `fromIndex`, tracking `{...}` brace depth so a tag's
 * own terminating `>` is found correctly even when its `element={<Foo />}`
 * attribute contains a NESTED self-closing JSX tag with its own `/>` — a
 * naive "first `>` wins" scan would mistake the nested element's close for
 * the outer `<Route>` tag's close.
 */
function tokenizeRoutes(source: string, fromIndex: number): RouteToken[] {
  const tokens: RouteToken[] = [];
  let i = fromIndex;
  while (i < source.length) {
    const openIdx = source.indexOf('<Route', i);
    const closeIdx = source.indexOf('</Route>', i);
    if (openIdx === -1 && closeIdx === -1) {
      break;
    }
    if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
      tokens.push({ type: 'close', selfClosing: false, attrs: '', end: closeIdx + 8 });
      i = closeIdx + 8;
      continue;
    }
    let j = openIdx + '<Route'.length;
    let braceDepth = 0;
    let selfClosing = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '{') {
        braceDepth += 1;
      } else if (ch === '}') {
        braceDepth -= 1;
      } else if (ch === '>' && braceDepth === 0) {
        selfClosing = source[j - 1] === '/';
        j += 1;
        break;
      }
      j += 1;
    }
    tokens.push({ type: 'open', selfClosing, attrs: source.slice(openIdx, j), end: j });
    i = j;
  }
  return tokens;
}

/** Extracts the full `<Route path="{pathMarker}" ...>...</Route>` block from `source`, using brace-depth-aware tokenization so nested wrapper Routes (e.g. the layout-only `<Route element={<ClientAnalyticsLayout />}>` block) never terminate the scan early. */
function extractRouteBlock(source: string, pathMarker: string): string {
  const markerIdx = source.indexOf(`path="${pathMarker}"`);
  if (markerIdx === -1) {
    throw new Error(`route not found in AppRouter.tsx: ${pathMarker}`);
  }
  const openTagStart = source.lastIndexOf('<Route', markerIdx);
  const tokens = tokenizeRoutes(source, openTagStart);
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'open') {
      if (!token.selfClosing) {
        depth += 1;
      }
    } else {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openTagStart, token.end);
      }
    }
  }
  throw new Error(`no matching closing </Route> found for: ${pathMarker}`);
}

/** Every `path="..."` or bare `index` self-closing `<Route .../>` nested (at any depth) inside `block`, excluding the block's own opening tag. */
function extractNestedRoutePaths(block: string): string[] {
  const tokens = tokenizeRoutes(block, 0);
  const paths: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.type !== 'open' || !token.selfClosing) {
      continue;
    }
    const pathAttr = token.attrs.match(/path="([^"]*)"/);
    if (pathAttr) {
      paths.push(pathAttr[1]!);
    } else if (/\bindex\b/.test(token.attrs)) {
      paths.push('(index)');
    }
  }
  return paths;
}

describe('research label universal-coverage proof', () => {
  const workspaceBlock = extractRouteBlock(appRouterSource, '/coach/:clientId');
  const workspaceRoutePaths = extractNestedRoutePaths(workspaceBlock);

  it('enumerates more than zero routes nested under the /coach/:clientId workspace route (anti-vacuous-pass guard)', () => {
    expect(workspaceRoutePaths.length).toBeGreaterThan(0);
  });

  it("every nested route is a descendant of the Route element that mounts ClientWorkspaceLayout — proven by extracting exactly the block bounded by that Route's own matching open/close tags", () => {
    expect(workspaceBlock).toContain('<ClientWorkspaceLayout />');
  });

  it('the enumerated set includes the known workspace pages (overview, fighters, vods, match-data, reviews, sessions) — a rename or an accidental route moved outside this block would drop it from this list', () => {
    expect(workspaceRoutePaths).toEqual(
      expect.arrayContaining([
        'overview',
        'fighters',
        'vods',
        'match-data',
        'dashboard',
        'fighter-analysis',
        'matchups',
        'reviews',
        'sessions',
      ]),
    );
  });

  // Review finding 29-07 MEDIUM: the parallel `/workspace/:tenantId` owned-
  // workspace route family exists too — this block records an EXPLICIT
  // disposition for it rather than silently never mentioning it.
  it('records an explicit disposition for the parallel /workspace/:tenantId owned-workspace family: OUT OF SCOPE, with a written reason — it is structurally unreachable by a research tenant', () => {
    const ownedWorkspaceBlock = extractRouteBlock(appRouterSource, '/workspace/:tenantId');
    const ownedWorkspaceRoutePaths = extractNestedRoutePaths(ownedWorkspaceBlock);

    // Anti-vacuous-pass: this family must itself be a real, non-empty route
    // tree, or "we checked it and it's fine" would be meaningless.
    expect(ownedWorkspaceRoutePaths.length).toBeGreaterThan(0);

    // Disposition: `/workspace/:tenantId` is the CLAIMED-OWNER family,
    // gated by its own `ClientOwnedWorkspaceLayout` — never
    // `ClientWorkspaceLayout`, which is where this plan mounts the banner.
    // A research tenant can never reach this family: plan 29-04 refuses
    // every claim operation (issuance, redemption, delegation-revoke)
    // fail-closed for a research tenant, even for an allowlisted admin
    // (RTEN-03; `apps/api/src/claims/invitations.ts`/`redemption.ts`/
    // `delegation.ts`). Because ownership can never flip for a research
    // tenant, this route family can never render one, so it is
    // deliberately out of scope for this plan's banner mount — verified
    // structurally: the block references its OWN layout, never this
    // plan's.
    expect(ownedWorkspaceBlock).toContain('ClientOwnedWorkspaceLayout');
    expect(ownedWorkspaceBlock).not.toContain('<ClientWorkspaceLayout />');
  });
});

// -----------------------------------------------------------------------
// Block 3: chrome-coverage proof (review finding 29-07 HIGH, tightened by
// cycle-2 finding C2-HIGH-9)
// -----------------------------------------------------------------------

const MAIN_LAYOUT_PATH = resolve('src/layouts/MainLayout.tsx');

/** Maps each locally-imported identifier in `source` to its module specifier, from every `import ... from '...'` statement (default and named, including `X as Y`). Type-only imports are skipped — they can never be JSX-rendered components. */
function extractImportedIdentifiers(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRe = /import\s+(type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source))) {
    const [, isTypeOnly, named, def, specifier] = match;
    if (isTypeOnly) {
      continue;
    }
    if (def) {
      map.set(def, specifier!);
    }
    if (named) {
      for (const part of named.split(',')) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith('type ')) {
          continue;
        }
        const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
        const localName = asMatch ? asMatch[2]! : trimmed;
        map.set(localName, specifier!);
      }
    }
  }
  return map;
}

/** The subset of `imported`'s keys that are actually rendered as a JSX tag (`<Name` or `<Name/`) somewhere in `source`. */
function renderedComponentIdentifiers(source: string, imported: Map<string, string>): string[] {
  return [...imported.keys()].filter((name) => new RegExp(`<${name}[\\s/>]`).test(source));
}

function resolveModuleFile(specifier: string, importerDir: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = resolve(importerDir, specifier);
  } else if (specifier.startsWith('@/')) {
    base = resolve(SRC_ROOT, specifier.slice(2));
  } else {
    return null; // external package — not part of the app's own source tree
  }
  for (const ext of ['.tsx', '.ts']) {
    if (existsSync(base + ext)) {
      return base + ext;
    }
  }
  if (existsSync(base) && /\.tsx?$/.test(base)) {
    return base;
  }
  return null;
}

/**
 * BFS over every component `entryFile` renders (directly or transitively) —
 * discovers the full chrome tree `MainLayout` mounts around `{children}`
 * (Topbar/Sidebar/Footer/GuidedPathCard and whatever THEY in turn render),
 * rather than a hand-maintained list, so a future chrome component nested
 * at any depth is still found. `entryFile` itself is excluded from the
 * result — it is the tree's root, not one of the components it renders.
 */
function discoverRenderedComponentFiles(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const worklist = [entryFile];
  while (worklist.length > 0) {
    const file = worklist.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = readFileSync(file, 'utf-8');
    const imported = extractImportedIdentifiers(source);
    for (const name of renderedComponentIdentifiers(source, imported)) {
      const resolved = resolveModuleFile(imported.get(name)!, dirname(file));
      if (resolved && !visited.has(resolved)) {
        worklist.push(resolved);
      }
    }
  }
  visited.delete(entryFile);
  return visited;
}

/**
 * A file "renders client-identifying content" iff it BOTH (a) reads one of
 * the two subject-identity sources named in this plan — the
 * coaching-clients listing (`useCoachingClients`) or the active subject's
 * client id (`useActiveSubject().clientId`) — AND (b) actually surfaces a
 * resolved `.label` from that data, rather than merely deriving a count or
 * a boolean from it. (b) is the discriminator between a component that
 * DISPLAYS a client's identity — the risk this plan exists to label — and
 * one that reads the same listing for an unrelated purpose (e.g.
 * `GuidedPathCard` gating an onboarding checklist step on whether the coach
 * has ANY clients yet — it reads `useCoachingClients` too, but only
 * `.data?.length`, and renders no client's name anywhere).
 */
function isClientIdentifyingChromeFile(source: string): boolean {
  const stripped = stripComments(source);
  const readsCoachingClientsListing = /\buseCoachingClients\s*\(/.test(stripped);
  const readsActiveSubjectClientId =
    /\buseActiveSubject\s*\(\)/.test(stripped) && /\bclientId\b/.test(stripped);
  const rendersALabel = /\.label\b/.test(stripped);
  return (readsCoachingClientsListing || readsActiveSubjectClientId) && rendersALabel;
}

describe('research label chrome-coverage proof (review finding 29-07 HIGH, cycle-2 C2-HIGH-9)', () => {
  const discoveredChromeFiles = discoverRenderedComponentFiles(MAIN_LAYOUT_PATH);
  const clientIdentifyingFiles = [...discoveredChromeFiles]
    .filter((file) => isClientIdentifyingChromeFile(readFileSync(file, 'utf-8')))
    .sort();

  it('discovers more than 3 components MainLayout renders around its children, directly or transitively (anti-vacuous-pass guard — a broken resolver returning zero would make every case below vacuously pass)', () => {
    expect(discoveredChromeFiles.size).toBeGreaterThan(3);
  });

  it('the discovered client-identifying set is EXACTLY {SidebarContent.tsx, Topbar.tsx} — the same set Task 2 owns and updated. A third file showing up here is a blocking finding for plan 29-12, never grounds to narrow this scan.', () => {
    const expected = [resolve('src/layouts/SidebarContent.tsx'), resolve('src/layouts/Topbar.tsx')];
    expect(clientIdentifyingFiles).toEqual(expected);
  });

  it.each([resolve('src/layouts/Topbar.tsx'), resolve('src/layouts/SidebarContent.tsx')])(
    '%s consumes useResearchSubject',
    (file) => {
      expect(readFileSync(file, 'utf-8')).toMatch(/\buseResearchSubject\s*\(/);
    },
  );
});

// -----------------------------------------------------------------------
// Block 4: locale-parity proof
// -----------------------------------------------------------------------

const LOCALES_DIR = resolve('src/i18n/locales');

/** Recursively flattens a nested object into dot-joined `{key: value}` pairs — leaf values only. */
function flattenLocaleObject(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      Object.assign(out, flattenLocaleObject(value, prefix ? `${prefix}.${key}` : key));
    }
  } else {
    out[prefix] = obj;
  }
  return out;
}

describe('research label locale-parity proof', () => {
  // Discovered by directory scan, not a fixed 6-path array — a 7th locale
  // added later is covered automatically.
  const localeFiles = readdirSync(LOCALES_DIR).filter((file) => file.endsWith('.json'));

  it('discovers more than 5 locale files (anti-vacuous-pass guard)', () => {
    expect(localeFiles.length).toBeGreaterThan(5);
  });

  it('every locale file carries a coaching.research block with an identical, non-empty key set', () => {
    const perLocaleKeys = localeFiles.map((file) => {
      const parsed = JSON.parse(readFileSync(resolve(LOCALES_DIR, file), 'utf-8'));
      const researchBlock = parsed.coaching?.research;
      expect(researchBlock, `${file} is missing coaching.research`).toBeDefined();
      return Object.keys(flattenLocaleObject(researchBlock)).sort();
    });

    const [first, ...rest] = perLocaleKeys;
    expect(first!.length).toBeGreaterThan(0);
    for (const keys of rest) {
      expect(keys).toEqual(first);
    }
  });

  it('no locale carries an empty value under coaching.research', () => {
    for (const file of localeFiles) {
      const parsed = JSON.parse(readFileSync(resolve(LOCALES_DIR, file), 'utf-8'));
      const flat = flattenLocaleObject(parsed.coaching.research);
      for (const [key, value] of Object.entries(flat)) {
        expect(typeof value === 'string' && value.trim().length > 0, `${file}:${key}`).toBe(true);
      }
    }
  });

  it('the five non-English locales each carry a value distinct from the English one, for every key', () => {
    const en = flattenLocaleObject(
      JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf-8')).coaching.research,
    );
    const nonEnglishFiles = localeFiles.filter((file) => file !== 'en.json');
    expect(nonEnglishFiles.length).toBeGreaterThan(0);

    for (const file of nonEnglishFiles) {
      const flat = flattenLocaleObject(
        JSON.parse(readFileSync(resolve(LOCALES_DIR, file), 'utf-8')).coaching.research,
      );
      for (const key of Object.keys(en)) {
        expect(flat[key], `${file}:${key} matches the English value verbatim`).not.toBe(en[key]);
      }
    }
  });
});
