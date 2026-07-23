## grandfinals.gg

**Use it live → https://grandfinals.gg**
alternative link: https://smash-tracker-f97b7.web.app

grandfinals.gg is a match-tracking app for **Super Smash Bros. Ultimate**. Sign in, pick a
primary/secondary fighter, log wins and losses (opponent, stage, match type, notes) after each
set, and review your results: win/loss trends, best/worst matchups, per-stage performance,
per-opponent history, and a per-fighter GSP (Global Smash Power) tracker with an Elite Smash
projection.

This repo is a full rewrite of an older Create React App + Redux + Firebase client-only app into
a typed monorepo with a real API layer in front of Firebase, kept as a portfolio piece.

### Tech stack

**Monorepo**

- pnpm workspaces (managed via corepack), Node 24
- TypeScript 6, strict mode, everywhere
- ESLint 9 (flat config) + typescript-eslint, Prettier 3
- husky + lint-staged (pre-commit formatting)
- Vitest across all three packages (126 tests)

**apps/web**

- Vite 8 + React 19 + React Router 8
- Tailwind CSS v4 + shadcn/ui (Radix primitives)
- TanStack Query 5 (server state/caching) + TanStack Table 8 (match table)
- react-hook-form + zod resolvers (forms)
- chart.js 4 + react-chartjs-2 (win/loss and matchup charts)
- firebase (modular v12) — **Auth only**, for sign-in
- sonner (toasts), lucide-react (icons)

**apps/api**

- Fastify 5 + fastify-type-provider-zod (schema-validated routes, typed end to end)
- firebase-admin 14 — verifies Firebase ID tokens and reads/writes Realtime Database
- zod 4

**packages/shared**

- Zod schemas + inferred TypeScript types shared by both apps, locked to the exact shapes already
  written to production Realtime Database by the legacy app (see
  [`packages/shared/README.md`](./packages/shared/README.md))

### Architecture

The browser talks to the Fastify API over HTTPS with a Firebase ID token as a Bearer credential;
the API is the only thing that touches Realtime Database. The one exception is sign-in itself —
the SPA calls Firebase Auth directly to obtain that ID token, then uses it for every API call.

```mermaid
flowchart LR
    Browser["Browser<br/>(React SPA)"]
    API["Fastify API<br/>(verifies Firebase ID tokens)"]
    Admin["firebase-admin"]
    RTDB[("Firebase Realtime Database")]
    Auth["Firebase Auth"]

    Browser -- "Bearer ID token<br/>REST/JSON" --> API
    API -- "verify + read/write" --> Admin
    Admin --> RTDB
    Browser -. "sign in / sign up<br/>(SDK, direct)" .-> Auth
    Auth -. "ID token" .-> Browser
```

> Note: `database.rules.json` still allows a user to read/write their own `uid`-scoped paths
> directly, because the legacy CRA app (still the deployed production app) talks to Realtime
> Database directly and needs those rules. Once this rewrite is cut over as the deployed app, the
> rules can be locked down to admin-only (service-account) access, since all reads/writes would
> then go exclusively through the API. See `firebase.json` / `database.rules.json`.

### Monorepo layout

```
smash-tracker/
├── apps/
│   ├── web/                 # Vite + React 19 SPA
│   │   ├── src/
│   │   │   ├── pages/       # Home, Dashboard, CharacterSelect, Matchups, MatchData, FighterAnalysis, NotFound
│   │   │   ├── layouts/     # Main layout: Sidebar, Topbar, Footer
│   │   │   ├── components/  # Shared UI (shadcn primitives, match-form)
│   │   │   ├── context/     # Auth context (onAuthStateChanged)
│   │   │   ├── providers/   # QueryClientProvider, AuthProvider, Toaster
│   │   │   ├── routes/      # react-router routes, ProtectedRoute
│   │   │   ├── lib/         # API client, Firebase SDK init, stats helpers
│   │   │   └── data/        # Static sprite/stage reference data
│   │   └── public/assets/   # Fighter sprites, stage images
│   └── api/                  # Fastify 5 API
│       └── src/
│           ├── routes/      # users, matches, opponents
│           ├── plugins/     # auth (Bearer ID-token verification), cors
│           ├── firebase/    # firebase-admin init
│           ├── config/      # env validation (zod)
│           └── services/    # RTDB access
├── packages/
│   └── shared/               # Zod schemas + types shared by web and api
│       └── README.md         # RTDB data-model documentation
├── legacy/                   # (removed in Phase 5 — see git history for the original CRA app)
├── database.rules.json
├── storage.rules
├── firebase.json
└── .github/workflows/ci.yml
```

### Getting started

**Prerequisites**: Node 24 and [corepack](https://nodejs.org/api/corepack.html) (ships with Node
≥ 16.10; enable with `corepack enable` if it's not already active). Corepack reads this repo's
pinned `packageManager` field and provisions the exact pnpm version automatically — no separate
pnpm install needed.

```bash
git clone https://github.com/bsmerbeck/smash-tracker.git
cd smash-tracker
pnpm install
```

#### 1. Firebase project

You'll need a Firebase project with **Authentication** (email/password + Google providers) and
**Realtime Database** enabled. See the [Firebase web setup docs](https://firebase.google.com/docs/web/setup)
if you're starting from scratch.

- **Web SDK config** (public, safe to expose client-side): Firebase console → Project settings →
  General → Your apps → SDK setup and configuration.
- **API credentials**: a service account JSON key (Project settings → Service accounts → Generate
  new private key) for `firebase-admin`, or point at the local RTDB emulator instead (see below).

#### 2. Environment variables

Each app has a `.env.example` — copy it and fill in your values:

```bash
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
```

- `apps/web/.env.example` — Firebase Web SDK config (`VITE_FIREBASE_*`) and `VITE_API_BASE_URL`
  (the Fastify API's address, defaults to `http://localhost:3001`).
- `apps/api/.env.example` — server port/host, `FIREBASE_DATABASE_URL`, credentials
  (`GOOGLE_APPLICATION_CREDENTIALS` or RTDB emulator vars), and `CORS_ORIGIN`.

`.env` files are gitignored; only the `.env.example` templates are committed.

#### 3. Run the dev servers

```bash
pnpm dev
```

Runs `apps/web` (Vite, default `http://localhost:5173`) and `apps/api` (Fastify with `tsx watch`,
default `http://localhost:3001`) in parallel. Or run one at a time with
`pnpm --filter @smash-tracker/web dev` / `pnpm --filter @smash-tracker/api dev`.

#### Optional: Realtime Database emulator

To develop without touching production data, run the RTDB emulator (needs the
[Firebase CLI](https://firebase.google.com/docs/cli)):

```bash
firebase emulators:start --only database
```

Then set `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000` in `apps/api/.env` — `firebase-admin`
will connect to the emulator and no real service-account credentials are required.

### Scripts

Run from the repo root; each fans out to the relevant workspace package(s) via pnpm.

| Script              | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`          | Runs `apps/web` and `apps/api` dev servers in parallel                      |
| `pnpm build`        | Builds all packages (`packages/shared` first, via pnpm's topological order) |
| `pnpm test`         | Builds `packages/shared`, then runs Vitest across all packages              |
| `pnpm lint`         | ESLint across all packages                                                  |
| `pnpm typecheck`    | Builds `packages/shared`, then `tsc` typechecks all packages                |
| `pnpm format`       | Prettier — writes                                                           |
| `pnpm format:check` | Prettier — check only (used in CI)                                          |

### Testing

Vitest across the board: `@testing-library/react` + `@testing-library/user-event` + jsdom for
`apps/web`, Fastify's `inject()` for `apps/api`, plain unit tests for `packages/shared`.
**126 tests** total (21 shared + 30 api + 75 web), including coverage of the critical user flows:
submitting a new match, editing a match, saving a character (fighter) selection, and redirecting
unauthenticated users away from protected routes.

```bash
pnpm test
```

### Deployment

Production serves the web app from Firebase Hosting and the API from Cloud Run, same-origin —
Hosting rewrites `/api/**` to the Cloud Run service, so the SPA never makes cross-origin requests
and the API's CORS config is just a belt-and-braces fallback.

**1. Deploy the API to Cloud Run**

The root `Dockerfile` builds `apps/api` (and its `packages/shared` dependency) into a slim
production image and runs `node dist/index.js`, listening on `process.env.PORT` (Cloud Run injects
this) with `HOST=0.0.0.0`. It authenticates via Application Default Credentials — no
`GOOGLE_APPLICATION_CREDENTIALS` needed in production; Cloud Run's runtime service account
provides ADC automatically, and that service account needs Realtime Database access.

```sh
gcloud run deploy smash-tracker-api \
  --source . \
  --region us-central1 \
  --set-env-vars FIREBASE_DATABASE_URL=https://smash-tracker-f97b7.firebaseio.com
```

The service name (`smash-tracker-api`) and region (`us-central1`) must match `firebase.json`'s
`hosting.rewrites` entry for `/api/**`.

**Running `scripts/` locally (e.g. the `seed:demo` seeder)** needs RTDB admin access beyond a
plain `gcloud auth application-default login` — Application Default Credentials must be scoped for
the Realtime Database, or you'll hit permission errors on every write. Either run
`gcloud auth application-default login --scopes=cloud-platform,firebase.database,userinfo.email`,
or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key with RTDB access.

**AI scouting reports (optional)**

V7-B's AI-generated pre-bracket scouting reports (`/api/reports`) are powered by the Claude API and
gated behind two env vars, both required together:

- `ANTHROPIC_API_KEY` — a Claude API key.
- `REPORTS_ALLOWED_UIDS` — a comma-separated list of Firebase uids allowed to generate reports (this
  is a paid, per-token feature, so it's opt-in per uid even once a key is configured).

```sh
gcloud run deploy smash-tracker-api \
  --source . \
  --region us-central1 \
  --set-env-vars FIREBASE_DATABASE_URL=https://smash-tracker-f97b7.firebaseio.com,ANTHROPIC_API_KEY=sk-ant-...,REPORTS_ALLOWED_UIDS=uid1,uid2
```

Until both vars are set, every `/api/reports*` route answers `503` and the web app's "Generate AI
report" button never renders — the rest of the app (including `/api/scout`) is unaffected.

**V7-C: Stripe-powered credit packs (optional)**

By default, `REPORTS_ALLOWED_UIDS` above is the only way to generate reports — everyone else gets a
`403`. Configuring Stripe additionally lets non-allowlisted users buy credit packs and generate
reports themselves (uids in `REPORTS_ALLOWED_UIDS` always stay free/unlimited; the paywall exists
purely to cover the cost of everyone else's Claude API usage). Two more env vars, both required
together:

- `STRIPE_SECRET_KEY` — a Stripe secret key (`sk_test_...` in test mode, `sk_live_...` in
  production), from <https://dashboard.stripe.com/apikeys>.
- `STRIPE_WEBHOOK_SECRET` — the signing secret for the `/api/billing/webhook` endpoint below, from
  the webhook's settings in the Stripe dashboard.

```sh
gcloud run deploy smash-tracker-api \
  --source . \
  --region us-central1 \
  --set-env-vars FIREBASE_DATABASE_URL=https://smash-tracker-f97b7.firebaseio.com,ANTHROPIC_API_KEY=sk-ant-...,REPORTS_ALLOWED_UIDS=uid1,uid2,STRIPE_SECRET_KEY=sk_live_...,STRIPE_WEBHOOK_SECRET=whsec_...
```

Register a webhook endpoint in the Stripe dashboard (<https://dashboard.stripe.com/webhooks>)
pointing at:

```
https://<your-cloud-run-service>/api/billing/webhook
```

subscribed to at least the `checkout.session.completed` event — this is what credits a purchased
pack onto the buyer's balance. Until both `STRIPE_*` vars are set, every `/api/billing*` route
answers `503` and non-allowlisted uids get exactly the pre-V7-C `403` on report generation (no
behavior change; this is an allowlist-only deployment by default).

Credit pack contents and prices (`pack5` = 5 credits / $8.00, `pack15` = 15 credits / $20.00) are a
single constant, `CREDIT_PACKS` in `packages/shared/src/billing.ts` — edit that one array to change
pricing or add a pack; both the checkout endpoint and the credits-status endpoint read from it, so
nothing else needs to change.

**V8-A: parry.gg integration (optional)**

A second tournament-site integration alongside start.gg, gated behind one env var:

- `PARRYGG_API_KEY` — a parry.gg API key, sent as the `X-API-KEY` gRPC-Web call metadata header on
  every request to `https://grpcweb.parry.gg`. Unlike start.gg, parry.gg has no OAuth app to
  register, so there's no redirect URI/client secret to configure.

```sh
gcloud run deploy smash-tracker-api \
  --source . \
  --region us-central1 \
  --set-env-vars FIREBASE_DATABASE_URL=https://smash-tracker-f97b7.firebaseio.com,PARRYGG_API_KEY=...
```

Until `PARRYGG_API_KEY` is set, every `/api/integrations/parrygg/*` route answers `503` and the rest
of the app (including start.gg) is unaffected. Because parry.gg has no OAuth grant to prove account
ownership, linking is a two-step flow: `POST /link` claims a parry.gg account by id (rejecting a
409 if another smash-tracker account already claimed it), and an optional bio-text challenge code
(`POST /verify/start` + `/verify/complete`) upgrades the link to "verified" once the user pastes the
code into their public parry.gg bio. Verification is NOT required to sync — syncing a linked
account only reads the same public match data start.gg's sync reads with its own server token, so
the trust bar for syncing is "you found the right profile" (enforced by the reverse-index
uniqueness check), not "you cryptographically proved you own it".

**2. Configure `apps/web/.env.production`**

```sh
# From `firebase apps:sdkconfig web`
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...

# Empty — same-origin in production, requests go to /api/** on this origin
VITE_API_BASE_URL=

# Cloud Run service URL — used only by requests that can outlive Firebase
# Hosting's hard 60-second rewrite timeout (AI report generation goes direct
# to this origin). Requires the API's CORS_ORIGIN env var to allow the
# Hosting origin, e.g. CORS_ORIGIN=https://your-project.web.app
VITE_API_DIRECT_URL=https://smash-tracker-api-XXXX.us-central1.run.app
```

**3. Build and deploy the web app to Firebase Hosting**

```sh
pnpm --filter @smash-tracker/web build
pnpm --filter @smash-tracker/web prerender
firebase deploy --only hosting
```

`prerender` snapshots the public routes (`/`, `/faq`, `/gsp-calculator`) to static HTML in `dist/`
with puppeteer so crawlers get full content without executing JS — run it after every build,
before deploying. `firebase.json` points `hosting.public` at `apps/web/dist` and rewrites
`/api/**` to the `smash-tracker-api` Cloud Run service before falling back to `/spa.html` (the
un-prerendered SPA shell, emitted by the build) for client-side routing on auth-gated paths.

**4. Lock down the Realtime Database rules**

`database.rules.json` denies all direct client read/write access (`{"rules": {".read": false,
".write": false}}`) — only `apps/api`'s firebase-admin SDK talks to the database, and the Admin SDK
bypasses these rules entirely. Deploy this **after** the hosting cutover above is live and verified,
so the legacy client-only app (if still pointed at the same database) isn't cut off mid-migration:

```sh
firebase deploy --only database
```

### Data model

`packages/shared` holds the Zod schemas for every Realtime Database shape this app reads and
writes (`users/{uid}`, `primaryFighters/{uid}`, `secondaryFighters/{uid}`, `matches/{uid}/{id}`,
`opponents/{uid}`), reverse-engineered field-for-field from the legacy app so existing production
data keeps working. See [`packages/shared/README.md`](./packages/shared/README.md) for the full
shape reference and provenance notes.

GSP (Global Smash Power) tracking works the same way: matches optionally carry a `gsp` reading,
and the per-fighter Elite Smash entry threshold (`gspSettings/{uid}`) is **user-maintained** —
there is no public Elite Smash API, so the GSP page links out to
[elitegsp.com](https://elitegsp.com)'s crowd-sourced estimate for reference and lets you type in
(and update) the number yourself.

### Disclaimer

I do not claim any rights to the content of the application. All rights belong to Nintendo, and
are not used for any commercial purpose.
