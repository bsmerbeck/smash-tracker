# syntax=docker/dockerfile:1

# Builds and runs apps/api (Fastify) for Cloud Run.
#
# Workspace-aware multi-stage build:
#   1. `deps`    - installs the full pnpm workspace (needs every member's
#                  package.json to resolve the lockfile, even though only
#                  apps/api and packages/shared are built/run afterward).
#   2. `build`   - builds packages/shared, then apps/api, then uses
#                  `pnpm deploy` to assemble a self-contained, production-only
#                  copy of apps/api (with packages/shared's built dist/
#                  resolved alongside it, no devDependencies, no apps/web).
#   3. `runtime` - slim image containing only that deployed output.
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS deps

# Manifests only, so this layer is cached unless dependencies change.
# pnpm needs every workspace member's package.json to resolve the lockfile,
# even though the runtime image only needs apps/api + packages/shared.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# pnpm-workspace.yaml's patchedDependencies reference files in patches/;
# install fails with ENOENT if they aren't present alongside the manifests.
COPY patches ./patches

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM base AS build

COPY --from=deps /repo /repo
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm --filter @smash-tracker/shared build \
  && pnpm --filter @smash-tracker/api build

# Assemble a self-contained, production-only copy of apps/api (workspace
# dependency on packages/shared included, devDependencies excluded, apps/web
# excluded). `--legacy` avoids requiring `inject-workspace-packages=true`.
RUN pnpm --filter @smash-tracker/api deploy --prod --legacy /repo/deploy

# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/deploy/dist ./dist
COPY --from=build /repo/deploy/node_modules ./node_modules
COPY --from=build /repo/deploy/package.json ./package.json

# Cloud Run injects PORT at runtime; the app defaults to 3001 for local use.
EXPOSE 3001

CMD ["node", "dist/index.js"]
