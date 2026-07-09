# Coding Conventions

**Analysis Date:** 2026-07-09

## Naming Patterns

**Files:**

- Components: PascalCase, e.g. `StageOption.tsx`, `LanguageSelect.tsx`
- Contexts: PascalCase ending in `Context`, e.g. `AuthContext.tsx`, `AnalyticsFilterContext.tsx`
- Hooks: camelCase starting with `use`, e.g. `useFilteredMatches.ts`, `useBilling.tsx`
- Services/utilities: camelCase, e.g. `service.ts`, `verificationCode.ts`
- Test files: Colocate with source using `.test.ts` or `.test.tsx` suffix

**Functions & Variables:**

- camelCase for functions, variables, and constants: `stageAbbreviation()`, `setMockUser()`, `applyOpponentAliases()`
- Constants: camelCase with ALL_CAPS for configuration constants: `BEARER_PREFIX`, `TEST_UID`, `GSP_LIVE_STALE_MS`, `MAX_GROUPS_PER_USER`
- React components: PascalCase: `StageOption`, `App`, `Probe`

**Types & Interfaces:**

- PascalCase: `AnalyticsFilterState`, `AuthContextValue`, `BuildAppOptions`, `Match`, `Stage`
- Type names reflect their purpose: `AnalyticsSourceFilter = 'all' | 'manual' | 'startgg'`
- Interfaces for objects/objects with functions: `interface AuthContextValue`, `interface BuildAppOptions`
- Type aliases for discriminated unions or simple enums: `type AnalyticsRangeFilter = 'all' | '3m' | '6m' | '12m'`

**Private vs Public:**

- Prefix private functions/utils with underscore or keep them unexported: Functions at file scope without `export` are private
- Helper functions in tests: `function makeMatch()`, `function withOpponent()`, `function renderProbe()`

## Code Style

**Formatting:**

- Prettier enforced across all TypeScript, JavaScript, JSON, CSS, and Markdown files
- Configuration: `semi: true`, `singleQuote: true`, `trailingComma: 'all'`, `printWidth: 100`
- Format on git hook via lint-staged for staged files

**Linting:**

- ESLint with typescript-eslint (v8.62.1) and flat config (`eslint.config.js`)
- Rules: `@eslint/js.configs.recommended`, `tseslint.configs.recommended`
- React-specific: react-hooks recommended rules + `react-refresh/only-export-components` (warn)
- Prettier integration: eslint-config-prettier disables conflicting rules

**Stricter patterns observed:**

- No unused imports: TypeScript strict, linted
- No implicit `any`: TypeScript strict mode enforced across all packages
- All exports are explicitly typed (interfaces or types for objects/functions)

## Import Organization

**Order (enforced by convention, not linting rule):**

1. External packages: `import Fastify from 'fastify'`, `import { createContext } from 'react'`
2. Type imports: `import type { User } from 'firebase/auth'`, `import type { Database } from 'firebase-admin/database'`
3. Relative imports: `import { resetAuthMock } from '@/test/mockAuth'`, `import { api } from '@/lib/api'`
4. Blank line between sections

**Path Aliases:**

- `@/` resolves to `src/` in both web and API packages (configured in `tsconfig.json`)
  - `@/components/`, `@/hooks/`, `@/lib/`, `@/test/`, `@/context/`, etc.
- No relative `../` paths; always use `@/` for sibling/ancestor imports
- API uses `./` for local imports when crossing module boundaries (not aliased)

**Package imports:**

- Shared package: `import type { Match } from '@smash-tracker/shared'`
- Standard library: `import type { Database } from 'firebase-admin/database'`
- Monorepo imports use full package names: `@smash-tracker/shared`

## Error Handling

**Patterns:**

- Custom error classes extend Error and set `.name` for logging: See `NotFoundError`, `ConflictError`, `ForbiddenError` in `apps/api/src/groups/groups.ts`
  ```typescript
  export class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotFoundError';
    }
  }
  ```
- Error handlers in Fastify catch custom errors and map to HTTP status codes (see `apps/api/src/app.ts` lines 78-120)
- Try-catch blocks used for async operations; errors logged via request.log or console.error
- No swallowing errors: all catch blocks either log or re-throw
- Firebase/API errors: caught at boundary, translated to user-facing messages via Zod validation or custom error classes

**React components:**

- No error boundaries in place; unhandled promise rejections log to console/Sentry (if enabled)
- Async operations use try-catch within hooks or effects

## Logging

**Framework:** console (Fastify logger in API, console in browser)

**Patterns:**

- API: `request.log.error({ err }, 'Message')` for errors, `app.log.warn()` for warnings
- Browser: `console.error()`, `console.warn()` for development
- Fastify structured logging: logs include error details, request context
- Firebase auth errors: logged implicitly by Firebase SDK

**What to log:**

- API errors and authentication failures
- Warnings for deprecated patterns or configuration issues
- No sensitive data (tokens, emails, UIDs) in log messages

## Comments

**When to Comment:**

- Explain non-obvious logic or algorithm choices (Glicko formula references, boundary conditions)
- Document setup requirements (jsdom polyfills, ResizeObserver stub rationale)
- Reference external sources or standards: See `glicko.test.ts` comments referencing Glickman's published paper
- Rationale for workarounds: "jsdom has no canvas; the real chart components only produce "Not implemented: getContext" noise in test output"

**JSDoc/TSDoc:**

- Functions exported from utilities have brief JSDoc comments explaining purpose
- React components: JSDoc for context providers and custom hooks (e.g., `useAnalyticsFilter`, `useFilteredMatches`)
- Parameters documented inline if non-obvious
- No template comments; brief, purposeful documentation only

**Example from codebase:**

```typescript
/**
 * jsdom doesn't implement ResizeObserver, but cmdk (used by the shadcn
 * Command component, e.g. AddMatchForm's opponent combobox) calls it on
 * mount. A minimal no-op stub is enough for tests — nothing here asserts on
 * actual resize behavior.
 */
```

## Function Design

**Size:** Functions typically 10-50 lines; extracted when exceeding natural cohesion

**Parameters:**

- Destructured object parameters for functions with 2+ related arguments
  ```typescript
  export function StageOption({ stage, className }: { stage: Stage; className?: string });
  export function filterByRange(matches: Match[], range: string, now: number);
  ```
- Typed inline for simple cases, or via interface for complex options
- No positional boolean parameters; use named parameters instead

**Return Values:**

- Single responsibility: functions return one type
- Promise-returning functions always typed as `Promise<T>`, never implicit
- Error handling: functions either throw or return success, never null
- Array/object builders return new instances, never mutate input

## Module Design

**Exports:**

- Default exports for React components: `export default App;`
- Named exports for utilities, services, hooks, types: `export function stageAbbreviation()`, `export type Match = ...`
- Barrel files (index.ts) used to re-export from directories: Not observed in this codebase; explicit imports from specific files

**File structure per package:**

- Web app (`apps/web/src/`):
  - `components/`: React UI components (PascalCase)
  - `hooks/`: Custom hooks (camelCase with `use` prefix)
  - `context/`: Context providers (PascalCase ending in `Context`)
  - `providers/`: Top-level provider wrappers (`AppProviders`)
  - `lib/`: Utilities, API client, query client
  - `routes/`: Route definitions
  - `layouts/`: Page layout components
  - `test/`: Shared test mocks, stubs, setup
- API app (`apps/api/src/`):
  - `routes/`: Route handlers
  - `services/`: Business logic (RTDB service, groups service)
  - `plugins/`: Fastify plugins (auth, firebase)
  - `config/`: Environment configuration
  - `test-support/`: Test fixtures and builders
  - Feature directories (`gspLive/`, `parrygg/`, `startgg/`): Isolated services
- Shared package (`packages/shared/src/`):
  - Exported types, schemas, utility functions (no test files)

**Constants & Configuration:**

- Magic numbers extracted to named constants at file/module scope
- Environment variables loaded once in `config/env.ts` via Zod validation
- No env vars read directly in component/service code; always pass via props or context

---

_Convention analysis: 2026-07-09_
