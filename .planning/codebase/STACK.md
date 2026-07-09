# Technology Stack

**Analysis Date:** 2026-07-09

## Languages

**Primary:**

- TypeScript 6.0.3 - All application code (web, API, shared libraries)
- JavaScript - Build scripts (Vite, Prerender, OG card generation)

## Runtime

**Environment:**

- Node.js 24+ (specified in `.nvmrc`)
- Supports both local development and Cloud Run/GKE environments with Application Default Credentials

**Package Manager:**

- pnpm 11.9.0 - Workspace monorepo with workspace:* references
- Lock file: `pnpm-lock.yaml` (frozen-lockfile deployment model)

## Frameworks

**Frontend:**

- React 19.2.7 - UI framework
- React Router 8.1.0 - Client-side routing with hash-based SPA navigation
- Vite 8.1.3 - Build tool and dev server (`apps/web/vite.config.ts`)
- Tailwind CSS 4.3.2 - Styling (via `@tailwindcss/vite` integration)

**Backend:**

- Fastify 5.9.0 - HTTP server (see `apps/api/src/app.ts`)
- fastify-type-provider-zod 7.0.0 - Schema-first API routes with Zod validation

**Testing:**

- Vitest 4.1.9 - Test runner across all packages (separate configs per package)
- jsdom 29.1.1 - DOM environment for web tests
- @testing-library/react 16.3.2 - React component testing
- puppeteer 25.3.0 - Build-time browser automation (prerender, OG image generation)

**Build & Dev:**

- @vitejs/plugin-react 6.0.3 - React Fast Refresh
- tsx 4.23.0 - TypeScript execution for API dev watch (`pnpm dev` via `tsx watch`)

## Key Dependencies

**Critical:**

- firebase 12.15.0 - Web SDK: auth (Google provider), analytics, messaging
- firebase-admin 14.1.0 - Server SDK: Authentication, Realtime Database, Cloud Functions interop
- @anthropic-ai/sdk 0.110.0 - Claude API for AI scouting report generation
- @parry-gg/client 1.0.12 - gRPC-Web client for parry.gg match/user data
- stripe 22.3.0 - Payment processing (credit pack checkout)

**Infrastructure:**

- zod 4.4.3 - Runtime schema validation (environment, API schemas, shared types)
- @tanstack/react-query 5.101.2 - Async state/caching on frontend
- @tanstack/react-table 8.21.3 - Table rendering (opponent/match leaderboards)
- chart.js 4.5.1 + react-chartjs-2 5.3.1 - Data visualization (analytics charts)
- @hookform/resolvers 5.4.0 - Form validation integration
- react-hook-form 7.80.0 - Form state management
- i18next 26.3.4 + react-i18next 17.0.8 - Internationalization
- lucide-react 1.23.0 - Icon library
- radix-ui 1.6.1 - Accessible UI primitives
- sonner 2.0.7 - Toast notifications
- cmdk 1.1.1 - Command palette component
- grpc-web 2.0.2 - gRPC-Web transport (parry.gg client)
- xhr2 0.2.1 - XMLHttpRequest polyfill for Node (gRPC-Web in server context)
- google-protobuf 4.0.2 - Protocol Buffer runtime (parry.gg gRPC types)

## Configuration

**Environment:**

- Application Default Credentials: `firebase-admin` auto-detects from `GOOGLE_APPLICATION_CREDENTIALS` (file) or runtime metadata server (Cloud Run, GKE)
- API server configuration via `apps/api/src/config/env.ts` with Zod validation
- Web Firebase config via Vite env vars (VITE_FIREBASE_*), validated lazily in `apps/web/src/lib/firebase.ts`

**Build:**

- `apps/web/vite.config.ts`: React + Tailwind + path alias (`@/`)
- `apps/api/tsconfig.build.json`: Strips test files from server build output
- `Dockerfile`: Multi-stage build (deps → build → runtime) for Cloud Run, uses `pnpm deploy` for production optimization
- Firebase Hosting config: `firebase.json` (rewrites `/api/**` to Cloud Run service, SPA fallback to spa.html)

## Platform Requirements

**Development:**

- Node.js 24+
- pnpm 11.9.0
- Bash shell (for `pnpm` monorepo scripts)
- Optional: Firebase Emulator Suite for local RTDB/Auth testing

**Production:**

- Cloud Run (Firebase Hosting + Cloud Run rewrite) — image built via Dockerfile
- Firebase Realtime Database (requires `FIREBASE_DATABASE_URL`)
- Firebase Authentication (OAuth 2.0 with Google provider)
- Start.gg OAuth app (optional, for tournament data sync)
- Anthropic Claude API (optional, for AI reports)
- Stripe account (optional, for credit pack billing)
- parry.gg API key (optional, for parry.gg scouting data)

---

_Stack analysis: 2026-07-09_
