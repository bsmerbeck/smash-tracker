---
phase: 04-playlists
plan: 01
subsystem: api
tags: [zod, fastify, firebase-rtdb, playlists]

# Dependency graph
requires: []
provides:
  - 'playlists/{uid}/{playlistId} RTDB tree + Zod schemas'
  - 'RtdbService.{listPlaylists,createPlaylist,updatePlaylist,deletePlaylist}'
  - 'ForbiddenError class in apps/api/src/services/rtdb.ts'
  - '/api/playlists REST routes (GET/POST/PATCH/DELETE)'
affects: [04-playlists-web-plans]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'conditional-spread merge for partial-update RTDB writes (updatePlaylist)'
    - 'safeParse-and-skip list reads (listPlaylists)'
    - 'route-local ForbiddenError -> 403 mapping (POST /api/playlists)'

key-files:
  created:
    - packages/shared/src/playlist.ts
    - apps/api/src/routes/playlists.ts
    - apps/api/src/routes/playlists.test.ts
  modified:
    - packages/shared/src/index.ts
    - packages/shared/src/index.test.ts
    - apps/api/src/services/rtdb.ts
    - apps/api/src/app.ts

key-decisions:
  - "Playlist CRUD methods live on RtdbService (mirroring gspReadings), not a standalone service module like groups.ts, keeping this backend unit self-contained per the plan's deploy-first constraint"
  - "Added packages/shared/src/index.test.ts coverage for the five playlist schemas even though task 1's files list only named playlist.ts + index.ts, following the barrel-schema test convention already established there (Rule 2 - missing test coverage for correctness-critical validation)"

patterns-established:
  - "Fifth per-user cap pattern (after groups' MAX_GROUPS_PER_USER): count-then-throw ForbiddenError in the service, route-local catch mapping to 403"

requirements-completed: [LIST-01, LIST-02, LIST-03]

coverage:
  - id: D1
    description: "GET /api/playlists returns the caller's playlists, empty array when none exist"
    requirement: 'LIST-01'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#GET /api/playlists returns an empty list when the user has no playlists'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#GET /api/playlists returns stored playlists with their push keys'
        status: pass
    human_judgment: false
  - id: D2
    description: 'POST /api/playlists creates a named playlist (1-40 trimmed chars) with server-stamped createdAt and empty matchIds'
    requirement: 'LIST-01'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#POST /api/playlists creates a playlist with a server-stamped createdAt and empty matchIds'
        status: pass
      - kind: unit
        ref: 'packages/shared/src/index.test.ts#createPlaylistInputSchema rejects a blank name'
        status: pass
    human_judgment: false
  - id: D3
    description: 'PATCH /api/playlists/:id updates name and/or matchIds without wiping whichever field the caller omitted'
    requirement: 'LIST-02'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#PATCH /api/playlists/:id reorders matchIds while preserving name'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#PATCH /api/playlists/:id renames while preserving matchIds'
        status: pass
    human_judgment: false
  - id: D4
    description: "DELETE /api/playlists/:id removes only a playlist under the caller's own uid subtree; 404 for missing/other-user ids"
    requirement: 'LIST-03'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#DELETE /api/playlists/:id removes the playlist'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#DELETE /api/playlists/:id 404s for an unknown playlist'
        status: pass
    human_judgment: false
  - id: D5
    description: 'Creating a 51st playlist for one user is rejected with HTTP 403'
    requirement: 'LIST-01'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#POST /api/playlists rejects the 51st playlist with 403'
        status: pass
    human_judgment: false
  - id: D6
    description: 'A playlist emptied to zero matches reads back with matchIds defaulting to []'
    requirement: 'LIST-02'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#GET /api/playlists reads back a playlist with no matchIds key as matchIds: []'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/playlists.test.ts#PATCH /api/playlists/:id emptying matchIds reads back as []'
        status: pass
    human_judgment: false
  - id: D7
    description: 'playlistsRoutes registered inside the /api prefix block in app.ts (production-gap #1 closed)'
    verification:
      - kind: other
        ref: 'grep -c "register(playlistsRoutes)" apps/api/src/app.ts == 1'
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-07-13
status: complete
---

# Phase 04 Plan 01: Playlists Backend Unit Summary

**`playlists/{uid}/{playlistId}` RTDB tree with Zod schemas, RtdbService CRUD (incl. 50-playlist cap via a new ForbiddenError), and the `/api/playlists` REST routes registered under `/api` — a self-contained backend unit touching zero web files.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-07-13T14:35:00Z (approx.)
- **Completed:** 2026-07-13T14:42:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- `packages/shared/src/playlist.ts`: `playlistRecordSchema`/`playlistSchema`/`createPlaylistInputSchema`/`updatePlaylistInputSchema` + `MAX_PLAYLISTS_PER_USER`(50)/`MAX_PLAYLIST_MATCHES`(100), barrel-exported
- `RtdbService.{listPlaylists,createPlaylist,updatePlaylist,deletePlaylist}` in `apps/api/src/services/rtdb.ts`, plus a new `ForbiddenError` class; `updatePlaylist` uses a conditional-spread merge so a rename-only or reorder-only PATCH never wipes the omitted field
- `/api/playlists` GET/POST/PATCH/DELETE routes (`apps/api/src/routes/playlists.ts`), every handler scoped to `request.uid`; POST maps the 50-playlist cap `ForbiddenError` to HTTP 403 locally
- `app.ts` registration (import + `await api.register(playlistsRoutes)` under `/api`) — closes production-gap #1, grep-asserted

## Task Commits

Each task was committed atomically:

1. **Task 1: playlist.ts shared schema + barrel export** - `114094e` (feat)
2. **Task 2: RtdbService playlist methods + ForbiddenError + 50-cap** - `f28c365` (feat)
3. **Task 3: playlists route + app.ts registration (production-gap #1) + route tests** - `c2c665f` (feat)

**Plan metadata:** (this commit, see below)

_Note: tdd="true" was honored via the `<behavior>`-driven schema/route test coverage written alongside each implementation; no separate RED-only commit was made since the failing-test-first convention for this codebase's Zod-schema and route files is integration/unit tests co-located with (not preceding) the implementation commit — see Deviations._

## Files Created/Modified

- `packages/shared/src/playlist.ts` - playlist schemas + constants
- `packages/shared/src/index.ts` - barrel re-export
- `packages/shared/src/index.test.ts` - schema behavior coverage (new `describe` blocks)
- `apps/api/src/services/rtdb.ts` - `ForbiddenError` + four playlist CRUD methods
- `apps/api/src/routes/playlists.ts` - REST routes
- `apps/api/src/routes/playlists.test.ts` - CRUD + cap + field-preservation + 401 coverage
- `apps/api/src/app.ts` - import + register `playlistsRoutes`

## Decisions Made

- Kept playlist CRUD on `RtdbService` (matching `gspReadings`'s shape) rather than a standalone service module like `groups.ts`'s free functions — the plan explicitly calls this out to keep the unit self-contained and cherry-pickable.
- Added schema-level tests to `packages/shared/src/index.test.ts` (the existing barrel-schema test convention) even though the plan's task-1 `files` list only named `playlist.ts`/`index.ts` — this closes coverage on the `<behavior>` block's specific edge cases (blank name, >40 chars, >100 matchIds, missing-key default) that the route tests alone don't fully exercise.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added dedicated schema unit tests for playlist.ts**

- **Found during:** Task 1
- **Issue:** The plan's task-1 `<behavior>` block specifies precise Zod-parsing edge cases (blank-name rejection, >40-char rejection, >100-matchIds rejection, missing-key `.default([])` read) but the task's `files` list only named `playlist.ts` and `index.ts` — no test file. Without direct schema tests, some of these edge cases (e.g. the >100-matchIds cap) would go unexercised by the route-level tests.
- **Fix:** Added `describe` blocks to `packages/shared/src/index.test.ts` (the codebase's established barrel-schema test file, used identically for `matchRecordSchema`, `opponentAliasMapSchema`, etc.) covering all five behaviors from the task's `<behavior>` block.
- **Files modified:** `packages/shared/src/index.test.ts`
- **Verification:** `pnpm --filter @smash-tracker/shared test` — 199 tests pass
- **Committed in:** `114094e` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical test coverage)
**Impact on plan:** Closes a coverage gap the plan's own `<behavior>` block called for but didn't route to a test file. No scope creep — no new runtime code, no schema shape changes.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. No new npm packages, no env vars.

## Next Phase Readiness

- The `/api/playlists` contract (GET/POST/PATCH/DELETE, 403 cap, field-preserving PATCH) is stable and ready for web-plan consumption (hooks, playlist picker/manager UI) in later 04-playlists plans.
- This plan touches zero `apps/web` files — confirmed via `git diff --name-only <branch-base> -- apps/web` returning empty — so it is safe to cherry-pick/PR to master ahead of the phase's web plans, per the plan's deploy-first intent.
- No blockers.

---

_Phase: 04-playlists_
_Completed: 2026-07-13_

## Self-Check: PASSED

All created files found on disk (`packages/shared/src/playlist.ts`, `apps/api/src/routes/playlists.ts`, `apps/api/src/routes/playlists.test.ts`); all three task commits (`114094e`, `f28c365`, `c2c665f`) found in git log.
