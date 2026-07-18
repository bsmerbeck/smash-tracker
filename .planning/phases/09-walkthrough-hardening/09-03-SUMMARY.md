---
phase: 09-walkthrough-hardening
plan: 03
subsystem: api
tags: [firebase-rtdb, transactions, zod, fastify, coaching-shares, security]

# Dependency graph
requires:
  - phase: 09-walkthrough-hardening (plan 02)
    provides: FB-03 deleteShare/bulkUpdateShares changes to rtdb.ts that this plan builds on top of (deploy-first Wave 2)
provides:
  - Server-enforced coach display-name uniqueness inside createNote's transaction (FB-04)
  - A distinct, static 409 on POST /vod-shares/:token/notes for a colliding name, without weakening the anonymous no-oracle 404 discipline
  - clearVodAndNotes/deleteMatch cascade soft-revoke of every active review share for the match (FB-05)
affects: [09-04, 09-05, share-management, coaching-edit-sessions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CR-01 reset-per-run transaction discipline extended to a new nameConflict flag inside createNote's notesRef.transaction() closure"
    - "Two-hop join (sharesByUser -> shareSnapshots -> shareTokens) reused for a cascade-revoke helper, matching listSharesForUser's proven shape"
    - 'Route-local static-message error catches (never err.message) for anonymous-surface no-oracle discipline, now covering ConflictError alongside ForbiddenError/NotFoundError'

key-files:
  created: []
  modified:
    - apps/api/src/services/rtdb.ts
    - apps/api/src/services/rtdb.test.ts
    - apps/api/src/routes/coachNotes.ts
    - apps/api/src/routes/coachNotes.test.ts

key-decisions:
  - "Uniqueness check runs INSIDE createNote's existing transaction, reading entries computed on that run only (CR-01) — no separate pre-flight read"
  - "Owner-name collision check uses the same normalizeCoachName transform as cross-session collision, so a coach can never case-fold/whitespace-vary into the owner's shared name"
  - 'resolveActiveReviewShareTokens reads matchId from shareSnapshots (never shareTokens, which has no such field) — verified with a test that seeds a spurious matchId directly on the token record'
  - 'Cascade is soft-revoke only (stamps revokedAt in the same multi-path update as the clear/delete write) — never a hard delete of the share'

requirements-completed: [FB-04, FB-05]

coverage:
  - id: D1
    description: 'Coach display-name uniqueness: cross-session and owner-name collisions are rejected 409; same-session reuse and genuinely unique names succeed; the 404 no-oracle gate still runs first'
    requirement: FB-04
    verification:
      - kind: unit
        ref: 'apps/api/src/services/rtdb.test.ts#RtdbService.createCoachNote — FB-04 display-name uniqueness (server-enforced)'
        status: pass
      - kind: integration
        ref: 'apps/api/src/routes/coachNotes.test.ts#POST /api/vod-shares/:token/notes'
        status: pass
    human_judgment: false
  - id: D2
    description: 'clearVodAndNotes and deleteMatch cascade-revoke every active review share for the match in one call; recap/other-match/already-revoked shares are untouched'
    requirement: FB-05
    verification:
      - kind: unit
        ref: 'apps/api/src/services/rtdb.test.ts#RtdbService.clearVodAndNotes / deleteMatch — FB-05 share-cascade revoke'
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-07-18
status: complete
---

# Phase 9 Plan 3: Coach name uniqueness + VOD-removal share cascade Summary

**Server-enforced coach display-name uniqueness (transaction-scoped, 409-on-collision) plus a soft-revoke cascade that kills every active review share when a VOD is cleared or a match is deleted**

## Performance

- **Duration:** 40 min
- **Started:** 2026-07-18T13:31:00Z
- **Completed:** 2026-07-18T14:11:05Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `createNote` now rejects (409, via `ConflictError`) a coach note whose normalized display name (trim/collapse-whitespace/case-fold) already belongs to a DIFFERENT session on the same match, or collides with the share owner's shared display name — same-session reuse of its own name is always allowed.
- The uniqueness decision is computed fresh inside `notesRef.transaction()`'s callback on every invocation (CR-01 discipline, mirroring the existing `capExceeded`/`carriedOpaqueKeys` reset), proven against `FakeDatabase`'s null-first-run/real-data-retry emulation.
- `coachNotes.ts`'s POST `/vod-shares/:token/notes` route catches `ConflictError` with a static, private-data-free 409 body — reachable only AFTER `resolveEditSession` already succeeded, so a revoked/expired/unknown token with a colliding name still returns the identical canonical 404.
- New private `resolveActiveReviewShareTokens(uid, matchId)` resolves every ACTIVE review-kind share for a match via the same two-hop join `listSharesForUser` already proves — reading `matchId` from `shareSnapshots`, never `shareTokens` (which has no such field).
- `clearVodAndNotes` and `deleteMatch` fold a soft-revoke (`shareTokens/{token}/revokedAt` stamp) of every resolved active token into the SAME root-level multi-path `database.ref().update()` as the existing clear/delete write — atomic in one server call.
- Recap shares (`kind: 'recap'`, no `matchId`), shares for a different match, and already-revoked shares are all left untouched by the cascade.

## Task Commits

Each task was committed atomically:

1. **Task 1: FB-04 — coach display-name uniqueness inside createNote + 409 route catch** - `1d2b7fa` (feat)
2. **Task 2: FB-05 — VOD removal (clear-VOD + delete-match) cascade-revokes active review shares** - `d7ed129` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified

- `apps/api/src/services/rtdb.ts` - `normalizeCoachName` helper; `createNote` gains an optional `ownerDisplayName` param + in-transaction `nameConflict` check throwing `ConflictError`; `createCoachNote` threads `snapshot.ownerDisplayName`; new private `resolveActiveReviewShareTokens`; `clearVodAndNotes`/`deleteMatch` cascade-revoke via multi-path update
- `apps/api/src/services/rtdb.test.ts` - New describe blocks: coach display-name uniqueness (cross-session, whitespace/case folding, same-session reuse, owner-name collision, CR-01 retry proof) and the FB-05 cascade (active revoke on clear/delete, recap/other-match/already-revoked exclusions, token-only-matchId negative control)
- `apps/api/src/routes/coachNotes.ts` - Imports `ConflictError`; POST `/notes` response schema gains `409: errorResponseSchema`; new catch branch returns the static 409 body after the existing 404/403 branches
- `apps/api/src/routes/coachNotes.test.ts` - New tests: 409 static body on a colliding name; 404 (never 409) for a revoked token even with a colliding name

## Decisions Made

- Placed the owner-name-collision check ahead of the cross-session-entries scan inside the transaction closure (both use the same `normalizeCoachName` normalization) since it doesn't depend on `entries` and can short-circuit on the very first (null) transaction run.
- `resolveActiveReviewShareTokens` is a private instance method (not a free function) since it uses `this.database`, consistent with the rest of `RtdbService`'s private helpers (`writeNoteUpdate`, `removeNote`).
- Test seeding for FB-05 constructs shares as TWO separate records (snapshot + token), exactly the shape `createShare` produces, never a synthetic `matchId` on the token — including one explicit negative-control test that injects a spurious `matchId` field directly onto a token record to prove the cascade never reads it from there.

## Deviations from Plan

None - plan executed exactly as written. The plan's exact code shapes (helper signatures, transaction structure, multi-path update idiom) matched what RESEARCH.md and 09-PATTERNS.md specified, and both were implemented as described.

## Issues Encountered

None. One self-correction during implementation: an early draft of `resolveActiveReviewShareTokens` had a copy-paste error (looked up `shareSnapshots` keyed by the token value instead of the shareId); caught and fixed before running any tests, so no test ever observed the bug.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- API-side FB-04/FB-05 hardening is deploy-ready (Wave 2, after 09-02's rtdb.ts changes) — no migration needed, forward-only enforcement.
- Web-side work remains for Plan 05: coach attribution string changes (`Coach {{name}}` → plain `{{name}}`), the 409 re-prompt UX on `ShareViewPage`'s name-collision, and confirm-dialog copy noting that clear-VOD/delete-match revokes associated share links.
- Full API suite (753 tests, 43 files) and lint stay green; no regressions in existing coach-note or share tests.

---

_Phase: 09-walkthrough-hardening_
_Completed: 2026-07-18_

## Self-Check: PASSED

All modified files and both task commit hashes (`1d2b7fa`, `d7ed129`) verified present on disk / in git log.
