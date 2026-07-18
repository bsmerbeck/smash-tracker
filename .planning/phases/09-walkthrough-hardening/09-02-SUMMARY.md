---
phase: 09-walkthrough-hardening
plan: 02
subsystem: api
tags: [rtdb, zod, fastify, shares, bulk-operations]

# Dependency graph
requires:
  - phase: 05-share-foundation-owner-controls
    provides: shareTokens/shareSnapshots/sharesByUser three-way share data model, RtdbService.createShare/revokeShare/deleteShare, POST/GET/revoke/DELETE /api/vod-shares routes
provides:
  - 'RtdbService.deleteShare loosened — an ACTIVE share is now hard-deletable in one call (no revoke-first requirement)'
  - 'RtdbService.bulkUpdateShares(uid, action, shareIds) — batch revoke/delete up to 100 shares in ONE atomic RTDB multi-path update, skip-not-fail semantics'
  - 'packages/shared/src/shares.ts bulkShareActionSchema/bulkShareRequestSchema/bulkShareResponseSchema wire contracts'
  - 'POST /api/vod-shares/bulk authenticated route'
affects: [09-04 (web UI for My Shares management overhaul consumes this API)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    [
      skip-not-fail batch RTDB writes,
      single atomic root-level multi-path update for bulk operations,
    ]

key-files:
  created: []
  modified:
    - packages/shared/src/shares.ts
    - apps/api/src/services/rtdb.ts
    - apps/api/src/services/rtdb.test.ts
    - apps/api/src/routes/vodShares.ts
    - apps/api/src/routes/vodShares.test.ts

key-decisions:
  - "Owner's walkthrough feedback overrides the Phase 5 'no hard delete without revoke first' decision — deleteShare on an ACTIVE share now resolves directly (deleting shareTokens/{token} kills anonymous access atomically)."
  - 'bulkUpdateShares is its OWN method (not N calls to revokeShare/deleteShare) — resolves every requested shareId in parallel via the sharesByUser->shareTokens two-hop join, then issues exactly ONE database.ref().update() across the actionable set.'
  - "Bulk delete inherits the same active-deletable relaxation as single delete — for 'delete', actionable = token record exists (active OR revoked); for 'revoke', actionable = token exists AND not already revoked."
  - "bulkShareRequestSchema/bulkShareResponseSchema are wire-only contracts (never persisted to RTDB) — the module doc's conditional-spread + .nullish() null-stripping rule does not apply to them; documented inline so a future reader doesn't add .nullish() reflexively."

patterns-established:
  - 'Skip-not-fail batch operations: resolve all requested ids in parallel, partition into actionable/skipped by per-id scope+state checks, then a single conditional multi-path write. Never throws for an unresolvable id; returns { processed, skipped } counts instead.'

requirements-completed: [FB-03]

coverage:
  - id: D1
    description: 'deleteShare removes an ACTIVE share in one call (409-while-active guard dropped)'
    requirement: 'FB-03'
    verification:
      - kind: unit
        ref: 'apps/api/src/services/rtdb.test.ts#FB-03: deleteShare active-removal + bulkUpdateShares > deleteShare on an ACTIVE share resolves (no ConflictError) and nulls token + snapshot + index'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/vodShares.test.ts#DELETE /api/vod-shares/:id > FB-03: 204s for an ACTIVE share — revoke-first is no longer required, and the link dies immediately'
        status: pass
    human_judgment: false
  - id: D2
    description: 'bulkUpdateShares revoke/delete return correct processed/skipped counts with exactly ONE atomic RTDB update, skip-not-fail for foreign/missing/already-revoked ids'
    requirement: 'FB-03'
    verification:
      - kind: unit
        ref: 'apps/api/src/services/rtdb.test.ts#FB-03: deleteShare active-removal + bulkUpdateShares (4 tests: revoke skip-not-fail, delete skip-not-fail, empty-actionable no-write, ACTIVE 404 for missing)'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/vodShares.test.ts#POST /api/vod-shares/bulk (6 tests: revoke mix, >100 ids 400, empty array 400, invalid action 400, foreign id skipped, unauthenticated 401)'
        status: pass
    human_judgment: false
  - id: D3
    description: 'POST /api/vod-shares/bulk registered, inherits file-wide auth, enforces the 100-id cap via Zod body schema'
    requirement: 'FB-03'
    verification:
      - kind: unit
        ref: 'pnpm --filter @smash-tracker/api exec vitest run src/routes/vodShares.test.ts (43 passed)'
        status: pass
    human_judgment: false

# Metrics
duration: 5min
completed: 2026-07-18
status: complete
---

# Phase 09 Plan 02: FB-03 Server — My Shares Bulk Management Summary

**Loosened RtdbService.deleteShare to hard-delete an ACTIVE share in one call, and added RtdbService.bulkUpdateShares + POST /api/vod-shares/bulk for skip-not-fail batch revoke/delete over up to 100 shares in one atomic RTDB update.**

## Performance

- **Duration:** ~5 min (commit-to-commit)
- **Started:** 2026-07-18T09:47:56-04:00
- **Completed:** 2026-07-18T09:52:35-04:00
- **Tasks:** 2 completed
- **Files modified:** 5

## Accomplishments

- `RtdbService.deleteShare` no longer requires a revoke-first step — deleting an ACTIVE share now nulls `shareTokens/{token}`, `shareSnapshots/{shareId}`, and `sharesByUser/{uid}/{shareId}` in one atomic multi-path update, killing anonymous access immediately.
- New `RtdbService.bulkUpdateShares(uid, action, shareIds)`: resolves every requested id in parallel via the existing `sharesByUser/{uid}/{shareId}` → `shareTokens/{token}` two-hop join (scoped to the caller's uid only), partitions into actionable/skipped, and writes the whole actionable set in exactly ONE `database.ref().update()` call. Never throws for a foreign, missing, or already-revoked id — returns `{ processed, skipped }` counts instead.
- New `POST /api/vod-shares/bulk` route: authenticated (inherits the file-wide `authenticate` preHandler), body validated by `bulkShareRequestSchema` (action enum + 1-100 shareIds), `uid` sourced only from `request.uid`.
- New shared wire schemas: `bulkShareActionSchema`, `bulkShareRequestSchema` (+`BulkShareRequest`), `bulkShareResponseSchema` (+`BulkShareResponse`) in `packages/shared/src/shares.ts`.

## Task Commits

Each task followed RED → GREEN TDD:

1. **Task 1: FB-03 service — loosen deleteShare, add bulkUpdateShares + shared schemas**
   - `0e2b357` - test(09-02): add failing tests for deleteShare active-removal + bulkUpdateShares (RED)
   - `9c1fbfb` - feat(09-02): FB-03 service — loosen deleteShare, add bulkUpdateShares + shared schemas (GREEN)
2. **Task 2: FB-03 route — POST /api/vod-shares/bulk + refresh DELETE doc**
   - `cd5123d` - test(09-02): add failing tests for POST /api/vod-shares/bulk + DELETE-on-active 204 (RED)
   - `04136ba` - feat(09-02): FB-03 route — POST /api/vod-shares/bulk + refresh DELETE doc (GREEN, includes a `tsc --noEmit` type-predicate fix caught after the test-green state — no behavior change)

_Note: no plan-metadata commit — `.planning/` is gitignored and `commit_docs: false` in this project's config, so docs-only commits are intentionally skipped (not a deviation)._

## Files Created/Modified

- `packages/shared/src/shares.ts` - Added `bulkShareActionSchema`, `bulkShareRequestSchema`, `bulkShareResponseSchema` + inferred types
- `apps/api/src/services/rtdb.ts` - Loosened `deleteShare` (dropped 409-while-active `ConflictError` guard); added `bulkUpdateShares`
- `apps/api/src/services/rtdb.test.ts` - Added `FB-03: deleteShare active-removal + bulkUpdateShares` describe block (5 tests)
- `apps/api/src/routes/vodShares.ts` - Registered `POST /vod-shares/bulk`; updated DELETE doc comment; refreshed the `.../:id` DELETE doc comment
- `apps/api/src/routes/vodShares.test.ts` - Added `POST /api/vod-shares/bulk` describe block (6 tests); updated the DELETE-on-ACTIVE-share test from expecting 409 to expecting 204

## Decisions Made

- Followed the plan's explicit instruction to implement `bulkUpdateShares` as its own method rather than looping `revokeShare`/`deleteShare` per id — this is what makes the "ONE atomic update" guarantee possible (RESEARCH Pitfall 6).
- Kept `ConflictError`'s import in `rtdb.ts` since it's still used by two other methods (`updateMatch`/similar guards at lines 430 and 555) even though `deleteShare` no longer throws it.
- Left `packages/shared/src/shares.test.ts` untouched — the plan's `files_modified` list didn't include it, and the new schemas are exercised indirectly through the rtdb/route tests (grep-based acceptance criteria confirm the schemas exist and typecheck).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a `tsc --noEmit` type-predicate mismatch in `bulkUpdateShares`'s filter**

- **Found during:** Post-Task-2 full verification pass (the plan's `<verification>` block requires `pnpm --filter @smash-tracker/api lint` to pass, and I additionally ran `tsc --noEmit` as a stronger check since Vitest's esbuild transpile doesn't type-check)
- **Issue:** The `resolved.filter((entry): entry is {...; revokedAt?: number | null} => ...)` type predicate declared `revokedAt` as an optional property (`revokedAt?:`), but the mapped array always includes the key (with a possibly-`undefined` value) — TS2677 "type predicate's type must be assignable to its parameter's type"
- **Fix:** Changed the predicate's `revokedAt` field from optional (`revokedAt?: number | null`) to required-with-undefined (`revokedAt: number | null | undefined`), matching the actual shape returned by the `Promise.all` map
- **Files modified:** `apps/api/src/services/rtdb.ts`
- **Verification:** `pnpm --filter @smash-tracker/api exec tsc --noEmit` exits 0; re-ran `rtdb.test.ts` + `vodShares.test.ts` (103 tests) to confirm no behavior regression
- **Committed in:** `04136ba` (part of Task 2 GREEN commit — the fix landed before commit, so no separate commit was needed)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** No scope creep — a type-safety fix required for a clean `tsc --noEmit`, which the plan's overall verification block implicitly requires (lint alone doesn't catch this class of error; `tsc --noEmit` was run proactively as a stronger correctness check).

## Issues Encountered

**Worktree `.planning/` staleness:** This worktree's `.planning/` directory (gitignored, filesystem-copied at worktree-creation time) only contained phases 01-04 — it predates phases 05-09 entirely, including the phase 09 PLAN.md/CONTEXT.md/STATE.md/config.json this task needed. Since `.planning/` is gitignored (`git check-ignore` confirms `.gitignore:26:.planning/`) and not part of any git ref, these files exist only on the main checkout's filesystem, not via any git history this worktree could pull from. I read the plan/context/config files directly from the main repo's absolute path (`/Users/bsmerbeck/git/smash-tracker/.planning/...`) since they're local-only docs shared by filesystem convention, not git — all actual code changes were made and committed entirely within this worktree's tracked files as normal. This SUMMARY.md is written into this worktree's `.planning/phases/09-walkthrough-hardening/` (newly created here) per the worktree-mode instructions; the orchestrator is responsible for reconciling/copying it back to the main checkout's `.planning/` tree since `.planning/` commits are skipped (gitignored + `commit_docs: false`).

## User Setup Required

None - no external service configuration required. This is a deploy-first, backend-only, additive/loosening API change — safe for old web clients (which never call `/bulk` and never delete an active share via the old flow).

## Next Phase Readiness

- The API surface FB-03's web UI (Plan 09-04, My Shares management overhaul) needs is complete and tested: `bulkShareRequestSchema`/`bulkShareResponseSchema` for the bulk-select UI, and DELETE now returning 204 for an active share so the per-row Delete button can drop its "revoke first" gating.
- No blockers. Full API suite (738 tests, up from the 727 baseline) and shared suite (354 tests) both green; `pnpm --filter @smash-tracker/api lint`, `pnpm --filter @smash-tracker/shared lint`, and `pnpm --filter @smash-tracker/api exec tsc --noEmit` all clean.

## Self-Check: PASSED

All key files confirmed present on disk (`packages/shared/src/shares.ts`, `apps/api/src/services/rtdb.ts`, `apps/api/src/services/rtdb.test.ts`, `apps/api/src/routes/vodShares.ts`, `apps/api/src/routes/vodShares.test.ts`, this SUMMARY.md). All 5 task/summary commit hashes (`0e2b357`, `9c1fbfb`, `cd5123d`, `04136ba`, `7d9d0dc`) confirmed present in `git log --oneline --all`.

---

_Phase: 09-walkthrough-hardening_
_Completed: 2026-07-18_
