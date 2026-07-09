<!-- refreshed: 2026-07-09 -->

# Architecture

**Analysis Date:** 2026-07-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Web SPA (React + TanStack)                   │
│                   `apps/web/src` (Main + Routes)                │
├────────────────────────────────┬────────────────────────────────┤
│  Pages (Dashboard, Matchups,   │   Layouts (MainLayout,         │
│  Scout, Opponents, GSP, etc)   │   PublicLayout, Sidebar)       │
│  `apps/web/src/pages/`         │   `apps/web/src/layouts/`      │
├────────────────────────────────┴────────────────────────────────┤
│  Providers: TanStack Query, Firebase Auth, Analytics Filter     │
│  `apps/web/src/providers/AppProviders.tsx`                      │
└────────────────┬─────────────────────────────────────────────────┘
                 │
         Request/Response via
       HTTP (TanStack Query + Zod)
                 │
┌────────────────▼─────────────────────────────────────────────────┐
│         Fastify API (Node.js Backend)                            │
│         `apps/api/src/app.ts` (buildApp)                         │
├───────────────────────────────────────────────────────────────────┤
│  Routes (36 endpoints: users, matches, opponents, GSP, start.gg  │
│  parry.gg, groups, reports, billing, scout)                     │
│  `apps/api/src/routes/`                                          │
└────────────┬───────────────────────────────────┬─────────────────┘
             │                                   │
             ▼                                   ▼
┌──────────────────────────┐        ┌─────────────────────────────┐
│  RtdbService (CRUD)      │        │  Integration Services       │
│  `apps/api/src/services/ │        │ (start.gg, parry.gg,        │
│   rtdb.ts`               │        │  Stripe, Anthropic)         │
│  Zod schemas imported    │        │ `apps/api/src/{startgg,     │
│  from shared package     │        │  parrygg,billing,reports}/` │
└──────────┬───────────────┘        └─────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Firebase (Production)                                           │
│  • Realtime Database (RTDB) — match/opponent/GSP data           │
│  • Firebase Auth — user accounts (email, Google, start.gg)      │
└──────────────────────────────────────────────────────────────────┘

Shared Layer:
─────────────
┌──────────────────────────────────────────────────────────────────┐
│  @smash-tracker/shared (TypeScript domain models + logic)        │
│  `packages/shared/src/`                                          │
│  • Zod schemas (match, opponent, GSP, user, etc)                 │
│  • Business logic (Glicko, GSP calculations, MMR transforms)    │
│  • Type definitions across web + API                            │
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component          | Responsibility                                                       | File                                      |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| AppRouter          | Client-side routing (38 routes, lazy-loaded except HomePage for SEO) | `apps/web/src/routes/AppRouter.tsx`       |
| AppProviders       | TanStack Query, Firebase Auth, Analytics Filter, Sonner contexts     | `apps/web/src/providers/AppProviders.tsx` |
| MainLayout         | App shell with Topbar, Sidebar, Footer for authenticated pages       | `apps/web/src/layouts/MainLayout.tsx`     |
| buildApp (Fastify) | HTTP server initialization, plugins, error handler, CORS             | `apps/api/src/app.ts`                     |
| Routes             | 36 Fastify endpoint handlers (users, matches, opponents, etc)        | `apps/api/src/routes/`                    |
| RtdbService        | Firebase RTDB CRUD operations with Zod validation                    | `apps/api/src/services/rtdb.ts`           |
| Shared Schemas     | Type-safe contract between web and API (Zod)                         | `packages/shared/src/`                    |
| Firebase Admin     | SDK initialization (auth, database) from env                         | `apps/api/src/firebase/admin.ts`          |

## Pattern Overview

**Overall:** Monorepo (pnpm workspaces) with 3 packages:

- **apps/web** — React SPA, client-only auth, API consumer
- **apps/api** — Fastify REST API, Firebase RTDB backend, integrations
- **packages/shared** — Zod schemas + domain logic (Glicko, GSP, imports)

**Key Characteristics:**

- Monolithic data model: Firebase Realtime Database (preserved from legacy) — no sharding
- Strict schema validation at route boundaries using Zod (`fastify-type-provider-zod`)
- Lazy-loaded routes except HomePage (V12 SEO split to optimize Core Web Vitals)
- Query client with 60s staleness window + no-retry on 4xx (incident-driven hardening)
- Custom Firebase token generation via API for start.gg login integration
- Shared TypeScript/Zod layer prevents type mismatches between web/API

## Layers

**Web Layer (SPA):**

- Purpose: User interface — data entry (matches, opponent notes), analytics dashboards, integrations
- Location: `apps/web/src/`
- Contains: React components, pages, hooks (40+), contexts, layouts, utilities
- Depends on: `@smash-tracker/shared` (Zod schemas, types), Firebase SDK (auth only), Fastify API (HTTP)
- Used by: Browsers (desktop, mobile) and crawlers (for prerendered SEO pages)

**API Layer (Fastify):**

- Purpose: Authorization, validation, RTDB mediation, integration orchestration
- Location: `apps/api/src/`
- Contains: 36 route handlers, RtdbService, plugins (auth, Firebase), config loaders
- Depends on: `@smash-tracker/shared`, Firebase Admin SDK, external APIs (start.gg GraphQL, parry.gg gRPC, Anthropic, Stripe)
- Used by: Web SPA, external webhooks (Stripe)

**Shared Layer:**

- Purpose: Single source of truth for schemas, types, and domain logic
- Location: `packages/shared/src/`
- Contains: Zod schemas, TypeScript types, business logic (Glicko, GSP MMR transforms, stage/fighter data)
- Depends on: zod, uuid, no external services
- Used by: Web + API (imported by both)

**Firebase (Data):**

- Purpose: Persistent storage for user data, auth provider
- Location: Cloud (smash-tracker-f97b7 project)
- Contains: Realtime Database (matches, opponents, GSP readings, user profiles), Firebase Auth
- Depends on: Google Cloud infrastructure
- Used by: API (admin SDK)

## Data Flow

### Primary Request Path: Create Match

1. User submits form in Dashboard/MatchData page (`apps/web/src/pages/Dashboard/`, `MatchDataPage`)
2. Form validation with client-side Zod schema (from shared)
3. HTTP POST to `/api/matches` via TanStack Query mutation (`apps/web/src/lib/api.ts`)
4. Browser sends Firebase ID token in Authorization header (from AuthContext)
5. Fastify receives request → `app.authenticate` hook validates token via Firebase Admin SDK
6. Route handler (`apps/api/src/routes/matches.ts`) parses + validates with Zod
7. RtdbService.createMatch() writes to Firebase RTDB at `matches/{uid}/{pushKey}`
8. Response returned with 201 Created + generated match ID
9. TanStack Query mutation invalidates related queries (e.g., `useFilteredMatches`)
10. UI re-renders with new match

### Analytics Query Path: Dashboard Filtered Stats

1. DashboardPage component renders, calls hooks: `useFighters()`, `useFilteredMatches(filter)`
2. Each hook calls API via `api.matches.list({ fighter_id?, ... })` (TanStack Query)
3. Fastify route (`apps/api/src/routes/matches.ts`): no auth needed for RBAC here, but user context set by hook
4. RtdbService.listMatches() queries RTDB with filters (client can see only own data via database.rules.json)
5. Response includes raw MatchRecord array
6. Client transforms to Match[] using shared domain logic (`calculateGlicko`, etc. in `@smash-tracker/shared`)
7. Components consume via hooks: WinLossTracker, MatchupSnapshot, LastMatchesChart
8. Charts render using `recharts` with transformed data

### GSP Thresholds (Live Data):

1. GSP page loads, calls `useGspLive()` hook
2. TanStack Query fetches GET `/api/gsp-live` (6h server-side cache from gsptiers.com)
3. Route handler (`apps/api/src/routes/gspLive.ts`) checks cache, fetches if stale
4. Response includes elite/max thresholds per character (from gspLive.ts service)
5. Page renders current GSP vs thresholds with live badge

### Mutation: Update GSP Settings

1. User changes preferred character on Profile page → calls `useGspSettings()` hook
2. HTTP PUT to `/api/gsp-settings/{character_id}` with Zod validation
3. RtdbService.upsertGspSettings() writes to `gspSettings/{uid}/{character_id}`
4. Subsequent GSP page renders reflect new settings (cached for 60s, refetches on tab focus)

**State Management:**

- **Server state:** Firebase RTDB (single source of truth)
- **Client state:** TanStack Query cache (mirrored server state with staleness window)
- **Auth state:** Firebase SDK (AuthContext updates on `onAuthStateChanged`)
- **UI state:** React component state (filters, modals, form inputs)
- **Analytics filter:** Global context (`AnalyticsFilterContext`) for chart date range

## Key Abstractions

**RtdbService:**

- Purpose: Encapsulates all RTDB reads/writes with Zod validation
- Examples: `createMatch()`, `listMatches()`, `upsertGspSettings()`, `mergeOpponentAlias()`
- Pattern: Async methods return typed objects; throw NotFoundError/ConflictError for HTTP status mapping

**Zod Schemas (shared):**

- Purpose: Runtime type validation at API boundaries
- Examples: `matchRecordSchema`, `matchSchema`, `gspSettingsSchema`, `userProfileSchema`
- Pattern: Imported by both web + API; fastify uses as response schema for serialization

**Query Client Configuration:**

- Purpose: App-wide TanStack Query defaults (stale time, retry logic)
- Examples: `createQueryClient()` with 60s staleTime, no-4xx-retry predicate
- Pattern: Centralized in `apps/web/src/lib/queryClient.ts`

**Page Components (lazy-loaded):**

- Purpose: Route-level feature modules with local state + hooks
- Examples: DashboardPage, MatchupsPage, ScoutPage, GspPage
- Pattern: Each page imports domain-specific hooks (useFighters, useFilteredMatches) and context (DashboardContext)

**Integration Services:**

- Purpose: External API coordination (start.gg OAuth, parry.gg gRPC, Stripe webhooks)
- Examples: `apps/api/src/startgg/`, `parrygg/`, `reports/`
- Pattern: Encapsulated in subdirectories; routes call service functions

**Firebase Admin Initialization:**

- Purpose: Single entry point for auth + database clients
- Example: `initFirebase(env)` → FirebaseServices { app, auth, database }
- Pattern: Called in `apps/api/src/index.ts` before buildApp()

## Entry Points

**Web SPA:**

- Location: `apps/web/src/main.tsx`
- Triggers: Browser loading app domain
- Responsibilities: Mount React root, render App component with providers

**API Server:**

- Location: `apps/api/src/index.ts`
- Triggers: Node process startup
- Responsibilities: Load env, init Firebase, build Fastify app, listen on port

**HomePage:**

- Location: `apps/web/src/pages/Home/HomePage.tsx`
- Triggers: Users visiting `/` (prerendered, public)
- Responsibilities: Landing + sign-in surface (not lazy-loaded for SEO)

**Protected Routes:**

- Pattern: Wrapped in `ProtectedRoute` component (redirects unauthenticated to `/`)
- Example: `/dashboard`, `/matchups`, `/scout` all require user sign-in

## Architectural Constraints

- **Threading:** Single-threaded event loop (Node.js + React). No worker threads. GSP live fetch is synchronous on first request per 6h.
- **Global state:** Firebase SDK singleton per app (web: single auth instance via `getFirebaseAuth()`; API: single admin instance created in index.ts)
- **Circular imports:** None detected; shared package has no dependencies on web/api
- **Database model:** Denormalized Firebase RTDB with per-user isolatable subtrees (`matches/{uid}`, `opponents/{uid}`, etc)
- **Auth token expiry:** Firebase ID tokens valid 1 hour; API calls refresh via `getIdToken()` hook
- **CORS:** Configurable per environment; hardened to specific origins in production
- **Lazy loading:** All routes except HomePage are dynamic imports with Suspense fallback
- **Build output:** Web builds to `dist/` (SPA + prerendered static pages); API builds to `dist/` (esbuild, single JS file)

## Anti-Patterns

### Over-fetching of Match Data

**What happens:** Routes like `/api/matches` return full MatchRecord array (with raw RTDB fields like `fighter_id`, `opponent_id`) and client must transform to Match for display.

**Why it's wrong:** Adds serialization overhead and type bridging logic on every query. Response payload larger than needed for some use cases (e.g., just reading count for analytics).

**Do this instead:** Add typed endpoint variants (e.g., `/api/matches?fields=id,date,result`) or backend transformation layer in rtdb.ts that returns Match objects directly, not MatchRecords. Reduces payload + eliminates client-side schema mapping.

### Mutation Invalidation via Key Prefixes

**What happens:** `useMutation` calls `queryClient.invalidateQueries({ queryKey: ['matches'] })` which refetches all match-related queries even if only one match changed.

**Why it's wrong:** Causes cascading network requests and UI flicker when updating a single match.

**Do this instead:** Use fine-grained invalidation: `queryClient.setQueryData(['matches', matchId], newMatch)` to update cache directly, then optionally refetch only affected derived queries (e.g., stats).

### Direct RTDB Reads in Hooks

**What happens:** Hooks like `useFilteredMatches` call API, but return raw MatchRecord array; consumers must call `calculateStats()` or `calculateGlicko()` locally.

**Why it's wrong:** Business logic scattered between shared package and component tree. Difficult to track where transformations happen. Hard to cache computed values.

**Do this instead:** Create computed views in RtdbService or shared package: `getMatchesWithStats()` returns Match[] + stats prepopulated. Components receive final shape and render directly.

## Error Handling

**Strategy:** Explicit error types thrown from services, mapped to HTTP status codes in Fastify error handler

**Patterns:**

- NotFoundError → 404
- ConflictError → 409 (e.g., editing a synced match)
- ValidationError → 400 (e.g., alias self-merge)
- Zod validation errors → 400 (via fastify-type-provider-zod)
- Unauthenticated (missing/invalid token) → 401 (auth plugin)
- Unhandled errors → 500 (logged, generic message returned)

Client handles via `ApiError` class in `lib/api.ts`: catches non-2xx responses, surfaces via error toast or component boundary.

## Cross-Cutting Concerns

**Logging:** Fastify built-in logger (pino) with `app.log.info/error`. App-level error handler logs 5xx errors. Client logs to console (dev) or silently (prod).

**Validation:** Zod schemas at every API boundary (request + response). Client-side form validation mirrors via shared schemas. Database.rules.json enforces isolation per UID.

**Authentication:** Firebase Auth (email, Google, start.gg OAuth). Web sends ID token in every API call. API verifies via Admin SDK.

**Rate Limiting:** None currently implemented (would need Fastify plugin if abuse observed).

**Observability:** Firebase Realtime Database console for data inspection. Sentry/Datadog not integrated; logs go to stdout (Cloud Run captures them).

---

_Architecture analysis: 2026-07-09_
