---
phase: 03-tags
plan: 01
subsystem: api
tags: [zod, firebase-rtdb, fastify, vitest]

# Dependency graph
requires: []
provides:
  - 'Optional `tags: string[]` on `matchRecordSchema` (match-level, ≤10, per-tag ≤24 chars)'
  - 'Optional `tags: string[]` on `vodTimestampSchema` (note-level, ≤5, per-tag ≤24 chars)'
  - 'Optional `tags` on `createMatchInputSchema`/`updateMatchInputSchema`'
  - 'Conditional-spread tags passthrough in `RtdbService.createMatch`/`updateMatch`'
  - 'API test coverage proving tag store/omit/empty-drop/synced-edit behavior'
affects: [03-02, 03-03, 03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Schema-evolution playbook (optional field + conditional-spread write) applied to a third field family (tags), mirroring vodStartSeconds/vodTimestamps'

key-files:
  created: []
  modified:
    - packages/shared/src/match.ts
    - apps/api/src/services/rtdb.ts
    - apps/api/src/routes/matches.test.ts
    - apps/api/src/test-support/fakeDatabase.ts

key-decisions:
  - 'tags fields use .optional(), not .default([]) — absence is a meaningful, valid state for pre-tag records, mirroring every other optional field on matchRecordSchema (vodStartSeconds, vodTimestamps) rather than the stageFavoritesSchema always-present-document case'
  - 'tags intentionally excluded from changesSyncOwnedFields — tags are user annotations, not sync-owned game facts, so synced matches stay taggable'
  - 'note-level tags require zero rtdb.ts changes beyond the schema update — they ride inside the already-wholesale-passthrough vodTimestamps array'
  - "FakeDatabase.setAtPath now strips empty-array values recursively on write (Rule 1 auto-fix), so the mock accurately simulates real RTDB's documented empty-array-drop behavior instead of silently persisting `tags: []` forever"

patterns-established:
  - 'Third-generation proof that the vodStartSeconds conditional-spread playbook generalizes cleanly to new annotation fields without touching route handlers'

requirements-completed: [TAG-01, TAG-02]

coverage:
  - id: D1
    description: 'matchRecordSchema, vodTimestampSchema, and createMatchInputSchema accept an optional, validated tags: string[] (per-tag ≤24 chars, ≤10/match, ≤5/note)'
    requirement: 'TAG-01'
    verification:
      - kind: unit
        ref: 'pnpm --filter @smash-tracker/shared build (type compile)'
        status: pass
      - kind: unit
        ref: 'pnpm --filter @smash-tracker/shared test (189 tests)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'POST/PATCH /api/matches store match-level and note-level tags verbatim; omitting or clearing tags leaves no tags key on the stored record; tags remain editable on synced matches'
    requirement: 'TAG-02'
    verification:
      - kind: integration
        ref: 'apps/api/src/routes/matches.test.ts#accepts and stores match-level tags'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/matches.test.ts#accepts and stores note-level tags inside vodTimestamps entries'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/matches.test.ts#omits tags from the stored record when not provided'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/matches.test.ts#drops tags from the stored record when the update payload sends an explicit empty array'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/matches.test.ts#allows a tags-only update on a synced match (tags are not sync-owned)'
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-07-13
status: complete
---

# Phase 3 Plan 1: Tag Data Model (Schema + Passthrough) Summary

**Optional `tags: string[]` on match records and VOD-timestamp notes, following the vodStartSeconds conditional-spread playbook exactly — schema validation, RTDB passthrough, and API test coverage, zero web files touched.**

## DEPLOY-ORDERING FLAG

**This plan's diff must be cherry-picked to `master` and deployed to the prod API BEFORE any preview-channel human check in this phase** (03-04's final task). Per the twice-learned production lesson (2026-07-10), preview channels hit the PROD API and zod silently strips unknown keys — so until this schema reaches prod, any preview-channel PATCH containing `tags` will have them dropped by the deployed API, even though the preview's own frontend/shared code accepts them locally. The entire diff is web-file-free (`packages/shared` + `apps/api` only) by design, making it a clean, self-contained cherry-pick unit.

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-13T12:40:00Z
- **Completed:** 2026-07-13T13:05:00Z
- **Tasks:** 3
- **Files modified:** 4 (3 planned + 1 deviation: `fakeDatabase.ts`)

## Accomplishments

- `tags` accepted, validated, and persisted at both match level (≤10 tags) and VOD-timestamp-note level (≤5 tags), per-tag capped at 24 chars
- `createMatch`/`updateMatch` pass tags through via the same conditional-spread convention as `vodTimestamps`/`vodStartSeconds`/`gsp`
- Tags confirmed editable on synced matches (excluded from `changesSyncOwnedFields`)
- Full test coverage: store/omit/empty-array-drop/synced-match-edit, including a fix to the RTDB test double so it accurately simulates production's empty-array-drop-on-write behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Add optional tags fields to the shared match schemas** - `ec503b0` (feat)
2. **Task 2: Pass tags through createMatch and updateMatch in RtdbService** - `a921830` (feat)
3. **Task 3: API route tests for tag store/omit/empty-array-drop** - `33f30f0` (test)

**Plan metadata:** committed alongside this SUMMARY (see final commit)

## Files Created/Modified

- `packages/shared/src/match.ts` - Added `tags` to `vodTimestampSchema` (max 5), `matchRecordSchema` (max 10), `createMatchInputSchema` (max 10, covers `updateMatchInputSchema`), all `.optional()`, per-tag `.trim().min(1).max(24)`
- `apps/api/src/services/rtdb.ts` - Added `...(input.tags !== undefined ? { tags: input.tags } : {})` conditional spread to both `createMatch` and `updateMatch`; extended the full-overwrite clearing-semantics comment to name `tags`
- `apps/api/src/routes/matches.test.ts` - 5 new test cases: match-tag store, note-tag store (inside `vodTimestamps`), tags-omitted-on-create, tags-empty-array-drop-on-update, tags-only-edit-on-synced-match
- `apps/api/src/test-support/fakeDatabase.ts` - Added `stripEmptyArrays()` helper applied in `setAtPath`, so the in-memory RTDB test double drops empty-array values on write, matching real RTDB's documented behavior

## Decisions Made

- `tags` fields use `.optional()`, not `.default([])` — matches the existing convention for evolving per-record optional fields (`vodStartSeconds`, `vodTimestamps`) rather than the `stageFavoritesSchema` single-document case
- No preset-tag-list constants added to the shared package — those are web-side concerns for 03-02, per the plan's explicit scope boundary
- No new endpoints or separate tags tree — tags ride the existing full-overwrite PATCH exactly as specified

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] FakeDatabase didn't simulate RTDB's documented empty-array-drop-on-write behavior**

- **Found during:** Task 3 (writing the PATCH-with-empty-tags-array test)
- **Issue:** The plan's acceptance criteria require a test proving that PATCHing with an explicit `tags: []` results in a persisted record with no `tags` key — "confirming RTDB's empty-array-drop rather than relying on `.optional()` alone." `apps/api/src/test-support/fakeDatabase.ts` is a plain in-memory object store; it stores exactly what's `.set()`, including literal `[]` values, and had no logic to strip them. Real RTDB's empty-array-drop behavior is already documented elsewhere in the codebase (`RtdbService.getStageFavorites` comment) but was never actually implemented in the test double — prior tests worked around this by manually `seed()`-ing the already-dropped end state rather than exercising a real write.
- **Fix:** Added a `stripEmptyArrays()` helper to `fakeDatabase.ts`, applied in `setAtPath` for both root and child writes, that recursively removes any object key whose value is `[]`. This makes the mock accurately reflect production RTDB behavior for every field (not just tags), matching the doc comment already in `rtdb.ts`.
- **Files modified:** `apps/api/src/test-support/fakeDatabase.ts`
- **Verification:** Full API suite (453 tests) still green after the change; the new tags-empty-array-drop test passes; no other test's assertions changed behavior.
- **Committed in:** `33f30f0` (part of Task 3 commit)

**2. [Test design correction, no plan deviation] Immediate PATCH response reflects request body verbatim, not the post-write persisted state**

- **Found during:** Task 3, same test as above
- **Issue:** `updateMatch` returns `{ id, ...record }` built in-memory from the request — it never re-reads from RTDB before responding — so a PATCH with `tags: []` correctly returns `tags: []` in the immediate response body, even though the _persisted_ record (and any subsequent read) will have the key dropped. The initial test draft asserted `.not.toHaveProperty('tags')` on the response body itself, which is not actually true of the system's behavior.
- **Fix:** Split the assertions: response body is asserted to `toMatchObject({ tags: [] })` (documenting the synchronous echo), while `database.dump()` and a follow-up `GET /api/matches` read-back are asserted to lack the `tags` key (proving the true persisted/read-back state).
- **Files modified:** `apps/api/src/routes/matches.test.ts`
- **Committed in:** `33f30f0` (part of Task 3 commit)

---

**Total deviations:** 2 (1 Rule-1 test-infra fix, 1 test-design correction discovered while writing the same test)
**Impact on plan:** Both changes stayed within `apps/api` (no web files, no architectural change) and strengthened test fidelity to actual production RTDB behavior. No scope creep beyond making the plan's own acceptance criteria genuinely provable.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backend tag data model is complete and tested; 03-02 (match tagging UI) can build directly on `Match.tags`/`VodTimestamp.tags` types exported from `@smash-tracker/shared`
- **Blocker for the phase's preview-channel human check:** this plan's diff (4 files, all in `packages/shared`/`apps/api`) must be cherry-picked to `master` and deployed to the prod Cloud Run API before 03-04's preview-channel verification step, or preview-channel PATCH/POST calls with `tags` will silently have them stripped by the still-old prod schema

---

_Phase: 03-tags_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified files exist on disk and all three task commits (`ec503b0`, `a921830`, `33f30f0`) are present in git history.
