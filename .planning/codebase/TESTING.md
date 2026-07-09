# Testing Patterns

**Analysis Date:** 2026-07-09

## Test Framework

**Runner:**

- Vitest (latest version, per monorepo setup)
- Config files: `apps/web/vitest.config.ts`, `apps/api/vitest.config.ts`, `packages/shared/vitest.config.ts`
- Different environments per package:
  - Web app: jsdom (browser environment)
  - API & shared: node (server environment)

**Assertion Library:**

- Vitest built-in expect() with extended matchers via `@testing-library/jest-dom/vitest`

**Run Commands:**

```bash
pnpm test                    # Run all tests across monorepo
pnpm --filter @smash-tracker/shared build && pnpm test  # With shared build dependency
pnpm test --watch           # Watch mode (example usage pattern)
pnpm test -- --coverage     # Coverage report
```

## Test File Organization

**Location:**

- Co-located with source: `.test.ts` or `.test.tsx` suffix in the same directory as source file
- Example: `apps/web/src/components/StageOption.tsx` → `apps/web/src/components/StageOption.test.tsx`
- Shared test utilities in `apps/web/src/test/`: `mockAuth.ts`, `setup.ts`, `seo.test.ts` (test-specific checks)
- API test support in `apps/api/src/test-support/`: `testApp.ts`, `fakeDatabase.ts`, `fakeAuth.ts`

**Naming:**

- `.test.ts` for logic/utility tests
- `.test.tsx` for React component tests
- Test files use `describe()` and `it()` blocks

**Structure:**

```
apps/web/src/
├── components/
│   ├── StageOption.tsx
│   └── StageOption.test.tsx
├── hooks/
│   ├── useFilteredMatches.ts
│   └── useFilteredMatches.test.ts
├── test/
│   ├── setup.ts          # Global setup (jsdom polyfills, i18n init)
│   ├── mockAuth.ts       # Shared Firebase auth mocks
│   └── stubs/            # Module replacement stubs (react-chartjs-2.tsx)
```

## Test Structure

**Suite Organization:**

```typescript
describe('ComponentName or FunctionName', () => {
  beforeEach(() => {
    // Setup (e.g., reset mocks, clear state)
  });

  it('should do X when Y happens', () => {
    // Arrange
    const input = ...;

    // Act
    const result = doSomething(input);

    // Assert
    expect(result).toBe(expectedValue);
  });

  it('handles edge case Z', () => {
    // Single focused test for one behavior
  });
});
```

**Patterns:**

- Setup: `beforeEach()` for shared mocks, state resets
- Test names: descriptive, past tense (e.g., "rendered the landing page", "passes everything through", "keeps only untagged records")
- Arrange-Act-Assert pattern for unit tests
- Nested `describe()` blocks for organizing related tests (e.g., `describe('filterBySource')`, `describe('filterByRange')`)
- No `afterEach()` observed; mocks cleaned via `resetAuthMock()` or `vi.clearAllMocks()` in beforeEach

## Mocking

**Framework:** Vitest's `vi` object (imported from 'vitest')

**Patterns:**

**Firebase Auth Mocks:**

```typescript
vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});
```

See `apps/web/src/test/mockAuth.ts` for implementation: mock auth instance with `currentUser` getter, `authStateListener` callback, and utility functions like `setMockUser()`, `resetAuthMock()`.

**API Mocks:**

```typescript
vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
    },
  },
}));
```

**Module stubs for jsdom incompatibilities:**

- `vitest.config.ts` uses alias to replace problematic modules:
  ```typescript
  alias: {
    'react-chartjs-2': fileURLToPath(
      new URL('./src/test/stubs/react-chartjs-2.tsx', import.meta.url),
    ),
  },
  ```
- Reason: jsdom has no canvas support; Chart.js components error in tests but math is covered by pure builder functions

**Polyfills in setup.ts:**

- `ResizeObserver`: No-op stub (cmdk Command calls it on mount)
- `Element.scrollIntoView()`: No-op stub (cmdk calls on navigation)
- Pointer Capture API: Stubbed `hasPointerCapture()`, `setPointerCapture()`, `releasePointerCapture()` (Radix UI Select calls these)

**What to Mock:**

- External APIs (Firebase, start.gg, parry.gg)
- HTTP calls (fetch, Axios) — use `vi.fn()` for overridable fetch
- Browser APIs missing from jsdom
- Module dependencies in isolated unit tests

**What NOT to Mock:**

- Core React utilities (hooks, components render with real implementation)
- Test helpers and fixtures (these are utilities, not external dependencies)
- Pure utility functions (test them directly)
- Business logic being tested (test the actual implementation, not mocked)

## Fixtures and Factories

**Test Data:**

**Example from glicko.test.ts:**

```typescript
function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}
```

**Example from useFilteredMatches.test.ts:**

```typescript
const manual = { id: 'm1', fighter_id: 1, opponent_id: 2, time: 1, win: true } as Match;
const imported = {
  id: 'sgg-1-g1',
  fighter_id: 1,
  opponent_id: 2,
  time: 2,
  win: false,
  source: 'startgg',
  externalId: 'sgg:1:g1',
} as Match;
```

**Example from useBilling.test.tsx:**

```typescript
const CREDITS_STATUS = {
  freeAccess: false,
  balance: 4,
  packs: [
    { id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' },
    { id: 'pack15', credits: 15, amountCents: 2000, label: '15 reports' },
  ],
};
```

**Location:**

- Fixtures defined at top of test file or in shared `test/` directory
- Factories (builder functions) defined inline in test file or in test-support directory
- API test app builders: `buildTestApp()` in `apps/api/src/test-support/testApp.ts`

## Coverage

**Requirements:** No coverage targets enforced (coverage checks not configured)

**View Coverage:**

```bash
pnpm test -- --coverage   # Generates coverage report (if configured)
```

## Test Types

**Unit Tests:**

- Scope: Single function or component in isolation
- Approach: Mock external dependencies, assert direct outputs
- Examples: `useFilteredMatches.test.ts` (pure logic), `glicko.test.ts` (algorithm)
- Pattern: Simple inputs, expected outputs, edge cases (boundaries, empty arrays)

**Integration Tests:**

- Scope: Multiple components or layers working together
- Approach: Test auth context + component interaction, Firebase + service calls
- Examples: `App.test.tsx` (mocks Firebase but renders full app), `AnalyticsFilterContext.test.tsx` (context provider + consuming hook)
- Pattern: Render providers + consumer component, simulate user interaction, assert state changes

**E2E Tests:**

- Framework: Not used
- Reason: Not found in test files; project relies on integration tests + manual QA

## Common Patterns

**Async Testing:**

```typescript
it('renders the landing page with sign-in when signed out', async () => {
  render(<App />);

  expect(
    await screen.findByRole('heading', { level: 1, name: /smash tracker/i }),
  ).toBeInTheDocument();
});
```

- Use `async`/`await` on test function
- Use `screen.findByXxx()` (waits) instead of `screen.getByXxx()` (throws immediately)
- `waitFor()` for custom conditions: Not observed in sample tests but available via `@testing-library/react`

**Error Testing:**

```typescript
it('rejects requests with no Authorization header', async () => {
  const { app } = buildTestApp();

  const response = await app.inject({ method: 'GET', url: '/api/matches' });

  expect(response.statusCode).toBe(401);
});
```

- Inject requests with missing/invalid auth headers
- Assert HTTP status codes
- No error snapshot testing; explicit status/message checks

**Boundary Testing (from useFilteredMatches.test.ts):**

```typescript
it('includes a match exactly at the cutoff boundary (inclusive)', () => {
  const cutoff = now - 90 * DAY_MS; // 3m = 30*3 days
  const atBoundary = matchAt('boundary', cutoff);
  expect(filterByRange([atBoundary], '3m', now)).toEqual([atBoundary]);
});

it('excludes a match one millisecond before the cutoff', () => {
  const cutoff = now - 90 * DAY_MS;
  const justBefore = matchAt('just-before', cutoff - 1);
  expect(filterByRange([justBefore], '3m', now)).toEqual([]);
});
```

- Test exact boundaries for time windows, range filters
- Test off-by-one errors explicitly

**Reference Comparison Testing (from useFilteredMatches.test.ts):**

```typescript
it('returns the same array reference when the alias map is empty', () => {
  const matches = [withOpponent('m1', 'rival')];
  expect(applyOpponentAliases(matches, {})).toBe(matches);
});

it('leaves matches whose opponent is not an alias key untouched (same reference)', () => {
  const matches = [withOpponent('m1', 'someoneelse')];
  const result = applyOpponentAliases(matches, { rivl: 'rival' });
  expect(result[0]).toBe(matches[0]);
});
```

- Performance optimization: return same array reference when no changes needed
- Assert with `.toBe()` (reference equality) when optimizations matter
- Documented in test comment with version reference (V8-A)

**Props & Rendering (from StageOption.test.tsx pattern):**

```typescript
it('renders stage thumbnail when url is present', () => {
  const stage: Stage = { id: 1, name: 'Battlefield', url: 'https://example.com/bf.png' };
  const { container } = render(<StageOption stage={stage} />);
  expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/bf.png');
});
```

- Render components with required props
- Query via `screen.getByRole()` / `screen.getByTestId()` for accessibility testing
- Use `container.querySelector()` only when role/testId queries don't work

## Test Execution

**Global Setup (`apps/web/src/test/setup.ts`):**

- Imported in vitest config `setupFiles`
- Initializes i18n (uses bundled English resources)
- Polyfills jsdom gaps (ResizeObserver, scrollIntoView, Pointer Capture API)
- Imports `@testing-library/jest-dom/vitest` for extended matchers

**Per-Test Setup:**

- `beforeEach()` resets mocks and state
- Factories and fixtures created fresh per test
- No shared state between tests (each test runs independently)

---

_Testing analysis: 2026-07-09_
