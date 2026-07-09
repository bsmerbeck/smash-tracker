# Codebase Structure

**Analysis Date:** 2026-07-09

## Directory Layout

```
smash-tracker/
├── apps/
│   ├── api/                    # Fastify REST API (Node.js backend)
│   │   ├── src/
│   │   │   ├── index.ts        # Entry point (load env, init Firebase, start server)
│   │   │   ├── app.ts          # Fastify app factory + error handler
│   │   │   ├── routes/         # 36 endpoint handlers
│   │   │   ├── services/       # rtdb.ts (CRUD with Zod validation)
│   │   │   ├── firebase/       # Admin SDK initialization
│   │   │   ├── plugins/        # Fastify plugins (auth, Firebase context)
│   │   │   ├── config/         # Env loaders + validators
│   │   │   ├── startgg/        # start.gg API integration
│   │   │   ├── parrygg/        # parry.gg gRPC-Web integration
│   │   │   ├── billing/        # Stripe webhook handlers
│   │   │   ├── reports/        # Anthropic AI scouting reports
│   │   │   ├── gspLive/        # GSP tier live fetch (gsptiers.com)
│   │   │   ├── groups/         # Group leaderboard logic
│   │   │   ├── test-support/   # Test fixtures, mocks
│   │   │   └── types/          # TypeScript-only types
│   │   ├── tsconfig.json       # TypeScript config (references tsconfig.build.json)
│   │   ├── package.json        # API dependencies
│   │   └── dist/               # Compiled output (esbuild, single JS file)
│   │
│   └── web/                    # React SPA (frontend)
│       ├── src/
│       │   ├── main.tsx        # React root mount
│       │   ├── App.tsx         # Top-level component (App > AppProviders > AppRouter)
│       │   ├── index.css       # Global styles (Tailwind)
│       │   ├── routes/         # AppRouter.tsx + route wrappers
│       │   ├── pages/          # Feature pages (lazy-loaded)
│       │   │   ├── Home/       # Landing + sign-in (eager loaded, prerendered)
│       │   │   ├── Dashboard/  # Win/loss tracking, matchup snapshots
│       │   │   ├── Matchups/   # Matchup analytics (character vs character)
│       │   │   ├── Opponents/  # Opponent management
│       │   │   ├── Scout/      # AI scouting reports
│       │   │   ├── Gsp/        # GSP tracker (per-character)
│       │   │   ├── Groups/     # Group leaderboards
│       │   │   ├── Tournaments/ # Tournament bracket sync (start.gg)
│       │   │   ├── Reports/    # Report history
│       │   │   ├── Trends/     # Long-term analytics
│       │   │   ├── Profile/    # User settings + security
│       │   │   ├── Integrations/ # start.gg, parry.gg links
│       │   │   └── ...         # 10+ other pages
│       │   ├── layouts/        # App shell components
│       │   │   ├── MainLayout.tsx    # Auth shell (Topbar, Sidebar, Footer)
│       │   │   ├── PublicLayout.tsx  # Public pages shell
│       │   │   ├── Sidebar.tsx       # Nav drawer
│       │   │   ├── Topbar.tsx        # Header with user menu
│       │   │   ├── nav.ts            # Navigation constants
│       │   │   └── Footer.tsx        # Site footer
│       │   ├── components/     # Reusable React components
│       │   │   ├── ui/         # Shadcn/ui primitives
│       │   │   ├── match-form/ # Match entry form + related
│       │   │   ├── vod/        # VOD timestamp UI
│       │   │   ├── billing/    # Stripe checkout components
│       │   │   └── ...         # Feature-specific components
│       │   ├── hooks/          # 40+ custom React hooks
│       │   │   ├── useMatches.ts           # Query matches
│       │   │   ├── useFilteredMatches.ts  # Query + filter (complex)
│       │   │   ├── useGspReadings.ts      # GSP data
│       │   │   ├── useStartgg.ts          # start.gg integration
│       │   │   ├── useParrygg.ts          # parry.gg integration
│       │   │   ├── useBilling.ts          # Stripe checkout
│       │   │   ├── useScoutReports.ts     # AI reports
│       │   │   └── ...
│       │   ├── context/        # React Context providers
│       │   │   ├── AuthContext.tsx    # Firebase auth state + sign-in/out
│       │   │   └── AnalyticsFilterContext.tsx # Global analytics filter (date, fighter)
│       │   ├── providers/      # Provider composition
│       │   │   └── AppProviders.tsx  # TanStack Query + Auth + Filter + Sonner
│       │   ├── lib/            # Utilities + clients
│       │   │   ├── api.ts      # HTTP client (TanStack Query hooks)
│       │   │   ├── firebase.ts # Firebase SDK init + helpers
│       │   │   ├── queryClient.ts # TanStack Query config (staleTime, retry)
│       │   │   ├── stats.ts    # Win/loss calculation (Transform MatchRecord → Match)
│       │   │   ├── glicko.ts   # Glicko rating wrapper
│       │   │   ├── vod.ts      # VOD timestamp parsing
│       │   │   ├── stageOptions.ts # Stage data helpers
│       │   │   └── colors.ts   # Color palette
│       │   ├── data/           # Static data files
│       │   │   └── sprites/    # Fighter character sprites
│       │   ├── i18n/           # i18next translations
│       │   │   ├── en.ts       # English strings
│       │   │   ├── ja.ts       # Japanese strings
│       │   │   └── ... other languages
│       │   ├── test/           # Test utilities + setup
│       │   │   ├── setup.ts    # Vitest config (mock Firebase, setup imports)
│       │   │   ├── mockAuth.ts # Mock AuthContext for tests
│       │   │   └── seo.test.ts # Prerender verification
│       │   ├── assets/         # Static images, logos
│       │   ├── public/         # Prerendered static HTML pages
│       │   └── vite.config.ts  # Vite bundler config
│       ├── tsconfig.json       # TypeScript config (references app + node)
│       ├── package.json        # Web dependencies
│       └── dist/               # Built SPA + static pages
│
├── packages/
│   └── shared/                 # Shared domain models + logic
│       ├── src/
│       │   ├── index.ts        # Main exports
│       │   ├── match.ts        # Match + MatchRecord types/schemas
│       │   ├── opponent.ts     # Opponent types
│       │   ├── fighter.ts      # Fighter types
│       │   ├── stage.ts        # Stage types
│       │   ├── gsp.ts          # GSP calculation logic
│       │   ├── gspMmr.ts       # GSP ↔ MMR conversion (decay-fit model)
│       │   ├── gspTiers.ts     # Elite/Max tier thresholds
│       │   ├── gspLive.ts      # Live tier data struct
│       │   ├── gspReading.ts   # GSP snapshot record type
│       │   ├── glicko.ts       # Glicko rating system
│       │   ├── meta.ts         # Matchup meta analytics
│       │   ├── reports.ts      # Report generation types
│       │   ├── startgg.ts      # start.gg API types + transforms
│       │   ├── parrygg.ts      # parry.gg API types
│       │   ├── groups.ts       # Group leaderboard types
│       │   ├── billing.ts      # Stripe/credits types
│       │   ├── fighterData.ts  # Static fighter roster
│       │   ├── stageData.ts    # Static stage roster
│       │   ├── stageFavorites.ts # Per-character stage preferences
│       │   ├── user.ts         # User profile type
│       │   ├── error.ts        # Custom error types
│       │   └── index.test.ts   # Integration tests
│       ├── tsconfig.json       # TypeScript config (references build)
│       ├── package.json        # Shared dependencies (zod, uuid)
│       └── dist/               # Compiled output
│
├── .planning/
│   └── codebase/
│       ├── ARCHITECTURE.md     # This file's companion (pattern, layers, data flow)
│       ├── STRUCTURE.md        # This file (directory layout, naming conventions)
│       └── ...                 # Other codebase analysis docs
│
├── node_modules/              # pnpm-managed dependencies (shared)
├── pnpm-workspace.yaml        # Workspace config (overrides, allowBuilds)
├── pnpm-lock.yaml             # Lockfile (deterministic builds)
├── package.json               # Root workspace config
├── tsconfig.json              # Root TypeScript config
├── eslint.config.js           # ESLint config (flat config)
├── .prettierrc.json           # Prettier formatting rules
├── Dockerfile                 # Cloud Run deployment (API + web prerender)
├── firebase.json              # Firebase project config (hosting, RTDB rules)
├── database.rules.json        # RTDB security rules (per-UID isolation)
└── README.md                  # Project documentation
```

## Directory Purposes

**apps/api:**

- Purpose: Node.js backend serving REST API + integrating external services
- Contains: Express/Fastify server, route handlers, Firebase RTDB CRUD, external API clients
- Key files: `index.ts` (entry), `app.ts` (server factory), `routes/` (endpoints), `services/rtdb.ts` (data layer)

**apps/web:**

- Purpose: React SPA (client-side application)
- Contains: React components, pages, hooks, layouts, contexts, static assets, styles
- Key files: `main.tsx` (DOM mount), `App.tsx` (root component), `routes/AppRouter.tsx` (routing), `lib/api.ts` (HTTP client)

**apps/web/src/pages:**

- Purpose: Feature modules, one per user-facing page/section
- Contains: Page components + page-local state, components, hooks (subdirectories per page)
- Pattern: Each page directory contains `*Page.tsx` (main export) + `components/` subdirectory

**apps/web/src/hooks:**

- Purpose: Reusable React hooks (TanStack Query wrappers, form logic, Firebase integration)
- Contains: Custom hooks (40+) organized by feature area
- Naming: `use{Feature}.ts` (e.g., `useMatches.ts`, `useFilteredMatches.ts`)

**apps/web/src/lib:**

- Purpose: Utilities, clients, helpers (not React components)
- Contains: HTTP client, Firebase SDK init, stats calculations, color helpers, query config
- Key files: `api.ts` (HTTP), `firebase.ts` (auth init), `queryClient.ts` (TanStack config), `stats.ts` (business logic)

**apps/web/src/components:**

- Purpose: Reusable UI components (not tied to a specific page)
- Contains: Form inputs, modals, cards, shadcn/ui primitives, feature-specific components
- Structure: `ui/` subdirectory for Shadcn primitives, feature subdirectories for complex components

**apps/web/src/layouts:**

- Purpose: App shell components (Topbar, Sidebar, Footer, Page layout)
- Contains: MainLayout (for auth pages), PublicLayout (for public pages)
- Single responsibility: Each layout file handles one piece of the shell

**apps/api/src/routes:**

- Purpose: Fastify route handlers (one handler per endpoint or endpoint group)
- Contains: 36 endpoint files (e.g., `users.ts`, `matches.ts`, `gspLive.ts`)
- Pattern: Each file is a `FastifyPluginAsyncZod` that registers multiple routes (GET, POST, PUT, DELETE)

**apps/api/src/services:**

- Purpose: Business logic layer (CRUD operations, data transforms)
- Contains: `rtdb.ts` (RtdbService class with all CRUD methods)
- Pattern: Service methods throw custom errors (NotFoundError, ConflictError) for status mapping

**apps/api/src/{startgg,parrygg,billing,reports}:**

- Purpose: External integration modules
- Contains: API clients, type definitions, transform logic specific to each integration
- Pattern: Isolated subdirectories with no cross-integration imports

**packages/shared/src:**

- Purpose: Shared domain models + business logic (imported by both web + API)
- Contains: Zod schemas, TypeScript types, Glicko/GSP calculation functions
- Key files: `index.ts` (exports), `match.ts`, `gsp.ts`, `glicko.ts`, test files

## Key File Locations

**Entry Points:**

- `apps/web/src/main.tsx` — React app mount (creates root, renders App)
- `apps/api/src/index.ts` — Node server startup (loads env, init Firebase, start Fastify)

**Configuration:**

- `apps/web/src/lib/firebase.ts` — Firebase Web SDK init + helpers
- `apps/web/src/lib/queryClient.ts` — TanStack Query defaults (staleTime, retry)
- `apps/api/src/config/env.ts` — Environment variable loaders + Zod validators
- `apps/api/src/firebase/admin.ts` — Firebase Admin SDK init

**Core Logic:**

- `apps/web/src/routes/AppRouter.tsx` — Client-side routing (38 routes)
- `apps/api/src/app.ts` — Fastify app factory + error handler
- `apps/api/src/services/rtdb.ts` — CRUD layer (all database operations)
- `packages/shared/src/gsp.ts`, `glicko.ts` — Business logic (rating calculations)

**Testing:**

- `apps/web/src/test/setup.ts` — Vitest config (mocks Firebase)
- `apps/api/src/test-support/` — Test fixtures (mock data, helpers)

## Naming Conventions

**Files:**

- React components: PascalCase with `.tsx` extension (e.g., `DashboardPage.tsx`, `UserMenu.tsx`)
- Hooks: camelCase with `use` prefix (e.g., `useMatches.ts`, `useAuth.ts`)
- Utilities/services: camelCase with `.ts` extension (e.g., `stats.ts`, `rtdb.ts`)
- Routes (API handlers): camelCase with `.ts` extension (e.g., `users.ts`, `matches.ts`)
- Tests: Same name as file under test + `.test` suffix (e.g., `useMatches.test.ts`, `stats.test.ts`)

**Directories:**

- Feature pages: PascalCase (e.g., `Dashboard/`, `Opponents/`, `Scout/`)
- Shared utilities: camelCase (e.g., `lib/`, `utils/`, `hooks/`)
- API routes: camelCase (e.g., `routes/`, `services/`)
- Integration modules: lowercase-kebab when multi-word (e.g., `gspLive/`, `test-support/`)

**React Components:**

- Named exports (e.g., `export function DashboardPage() {}`)
- Props interface named `{ComponentName}Props` (e.g., `DashboardPageProps`)
- One component per file (exceptions: very simple UI primitives)

**Zod Schemas:**

- Imported from `@smash-tracker/shared`
- Named with `Schema` suffix (e.g., `matchRecordSchema`, `userProfileSchema`)
- Paired with inferred type (e.g., `type Match = z.infer<typeof matchSchema>`)

**API Routes:**

- HTTP methods as comments (e.g., `// PUT /api/users/me`)
- Endpoint paths follow RESTful conventions (`/api/users/{uid}`, `/api/matches/{matchId}`)

## Where to Add New Code

**New Feature (full-stack):**

- Primary code:
  - Web: `apps/web/src/pages/{FeatureName}/` (new page directory)
  - API: `apps/api/src/routes/{feature}.ts` (new route handler)
  - Shared: `packages/shared/src/{domain}.ts` (if new domain type/schema needed)
- Tests:
  - Web: `apps/web/src/pages/{FeatureName}/*.test.tsx`
  - API: `apps/api/src/routes/{feature}.test.ts`
  - Shared: `packages/shared/src/{domain}.test.ts`

**New Component/Module (web only):**

- Reusable component: `apps/web/src/components/{FeatureName}/` (subdirectory)
- Page-specific component: `apps/web/src/pages/{PageName}/components/` (within page)
- Layout component: `apps/web/src/layouts/` (if shell-related)

**New Hook (web only):**

- Implementation: `apps/web/src/hooks/use{HookName}.ts`
- Test: `apps/web/src/hooks/use{HookName}.test.ts` or `.test.tsx` (if using React Testing Library)

**New Utility/Service (web):**

- Shared helpers: `apps/web/src/lib/{utilityName}.ts` (not tied to React)
- Tests: `apps/web/src/lib/{utilityName}.test.ts`

**New Route/Endpoint (API):**

- New endpoint group: `apps/api/src/routes/{resource}.ts` (e.g., `widgets.ts`)
- Add export to `apps/api/src/app.ts` under `app.register(widgetsRoutes)`
- Test: `apps/api/src/routes/{resource}.test.ts`

**New Integration (API):**

- Isolated module: `apps/api/src/{integration}/` (e.g., `foobar/`)
- Sub-files: `client.ts`, `types.ts`, `handlers.ts` (if complex)
- Tests: `apps/api/src/{integration}/*.test.ts`

**New Shared Type/Schema:**

- Domain file: `packages/shared/src/{domain}.ts` (e.g., `widgets.ts` for widget types)
- Export in `packages/shared/src/index.ts`
- Test: `packages/shared/src/{domain}.test.ts`

**New Page (web):**

1. Create directory: `apps/web/src/pages/{PageName}/`
2. Create component: `apps/web/src/pages/{PageName}/{PageName}Page.tsx` (main export)
3. Add route in `apps/web/src/routes/AppRouter.tsx` with lazy import
4. Add nav entry in `apps/web/src/layouts/nav.ts` (if user-visible)
5. Add to i18n keys in `apps/web/src/i18n/` (translation strings)

## Special Directories

**apps/web/public/:**

- Purpose: Prerendered static HTML pages (for SEO)
- Generated: Yes (via `scripts/prerender.mjs` at build time)
- Committed: No (gitignored, rebuilt on deploy)
- Pages: HomePage + public-only pages (FAQ, GSP Calculator, Not Found)

**apps/web/dist/:**

- Purpose: Built SPA bundle + prerendered HTML
- Generated: Yes (via Vite at build time)
- Committed: No (gitignored)
- Contents: index.html, JS chunks, CSS, prerendered pages

**apps/api/dist/:**

- Purpose: Compiled Node.js server code (single esbuild bundle)
- Generated: Yes (via esbuild at build time)
- Committed: No (gitignored)
- Contents: Single `server.js` file (tree-shaken, minified)

**node_modules/:**

- Purpose: pnpm-managed dependencies (workspace + node_modules hoisting)
- Generated: Yes (via `pnpm install`)
- Committed: No (gitignored)

**.planning/:**

- Purpose: GSD workflow planning artifacts + codebase documentation
- Generated: Yes (by Claude agents via /gsd commands)
- Committed: Yes (tracked in git)

**Database (Firebase RTDB):**

- `users/{uid}` → User profile (email)
- `primaryFighters/{uid}` → Fighter ID array
- `secondaryFighters/{uid}` → Fighter ID array
- `matches/{uid}/{pushKey}` → MatchRecord (match data)
- `opponents/{uid}/{opponentName}` → true (set-membership map)
- `gspSettings/{uid}/{character_id}` → GspSettings (preferred GSP character)
- `gspReadings/{uid}/{character_id}/{timestamp}` → GspReading (snapshot)
- `stageFavorites/{uid}/{character_id}` → StageFavorites (stage pick rates)
- `opponentNotes/{uid}/{opponentName}` → OpponentNote (notes per opponent)
- `opponentAliases/{uid}/{canonical}` → string[] (nickname mappings)
- `groups/{groupId}` → Group metadata
- `groupMembers/{groupId}/{uid}` → member metadata

---

_Structure analysis: 2026-07-09_
