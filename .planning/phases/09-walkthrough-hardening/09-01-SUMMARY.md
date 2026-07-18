---
phase: 09-walkthrough-hardening
plan: 01
subsystem: auth
tags: [react, tanstack-query, firebase-auth, vitest]

# Dependency graph
requires:
  - phase: 08-coaching-edit-sessions
    provides: Phase 8 walkthrough findings FB-01 (cross-account cache leakage) and FB-02 (wedged Google sign-in popup)
provides:
  - AuthProvider clears the entire TanStack Query cache on every authenticated-uid transition (sign-in, sign-out, account switch), never on the first app-boot callback
  - SignInCard's Google sign-in button set re-enables via a focus-return grace timer when the OAuth popup is abandoned, independent of Firebase's delayed/never-settling popup-close rejection
affects: [auth, vod-manager, playlists, notes, shares]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'uid-transition cache clear: previousUidRef + isFirstRunRef guard onAuthStateChanged, cancelQueries() before clear() to avoid a stale in-flight response resurrecting cleared cache'
    - 'focus-return grace timer: refs (not state) track settle/reset so an async catch block reads live values instead of a stale closure'

key-files:
  created: []
  modified:
    - apps/web/src/context/AuthContext.tsx
    - apps/web/src/context/AuthContext.test.tsx
    - apps/web/src/pages/Home/SignInCard.tsx
    - apps/web/src/pages/Home/SignInCard.test.tsx
    - apps/web/src/layouts/SidebarContent.test.tsx

key-decisions:
  - 'Cache clear keyed on uid transitions detected via refs, not a query-key refactor (locked decision from PLAN — lower risk, same outcome)'
  - 'Grace timer value locked at 1800ms (within the 1.5-2s band) for FB-02'
  - 'Toast suppression on late popup-closed rejection is conditioned on whether the grace timer already reset the buttons, not on error code alone'

patterns-established:
  - 'Any test file that renders AuthProvider bare now needs a QueryClientProvider ancestor (AuthProvider calls useQueryClient())'

requirements-completed: [FB-01, FB-02]

coverage:
  - id: D1
    description: 'AuthProvider clears the TanStack Query cache (cancelQueries then clear) on every authenticated-uid transition, but not on the first onAuthStateChanged callback or a same-uid repeat'
    requirement: 'FB-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/context/AuthContext.test.tsx#AuthContext — query cache clear on uid transition (FB-01)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Google sign-in buttons re-enable via a focus-return grace timer (1800ms) when the OAuth popup is abandoned, with no confusing toast for a late popup-closed/cancelled rejection, while an immediate popup-blocked rejection still toasts'
    requirement: 'FB-02'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/Home/SignInCard.test.tsx#SignInCard — Google popup abandonment grace timer (FB-02)'
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-07-18
status: complete
---

# Phase 9 Plan 01: Auth Hardening (FB-01/FB-02) Summary

**AuthProvider clears the TanStack Query cache on every authenticated-uid transition, and SignInCard's Google button re-enables via a focus-return grace timer when the OAuth popup is abandoned.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-18T09:44:26-04:00
- **Completed:** 2026-07-18T09:52:45-04:00
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Cross-account data leakage fixed: `AuthProvider` now cancels in-flight queries then clears the entire TanStack Query cache on every `uidA→null`, `null→uidB`, and `uidA→uidB` transition, while explicitly skipping the very first `onAuthStateChanged` callback (app boot / restored session) so normal page loads don't thrash the cache.
- Wedged Google sign-in fixed: `SignInCard.handleGoogleSignIn` now starts a 1800ms grace timer on window focus-return; if `signInWithGoogle()` is still pending when it fires, all four buttons re-enable without a page refresh, and a subsequent late `auth/popup-closed-by-user`/`auth/cancelled-popup-request` rejection produces no toast. An immediate rejection (e.g. `auth/popup-blocked`) still toasts as before.
- Both fixes are colocated-test-covered (TDD RED→GREEN for each) and the full web suite (1265 tests) plus lint/typecheck stay green.

## Task Commits

Each task was committed atomically (TDD RED then GREEN per task):

1. **Task 1: FB-01 — clear query cache on every authenticated-uid transition**
   - `5508b44` test(09-01): add failing test for FB-01 query cache clear on uid transition
   - `6b6a95d` feat(09-01): FB-01 clear query cache on every authenticated-uid transition
2. **Task 2: FB-02 — focus-return grace timer re-enables sign-in buttons on abandoned Google popup**
   - `29a4dc6` test(09-01): add failing test for FB-02 focus-return grace timer
   - `92f22d8` feat(09-01): FB-02 focus-return grace timer re-enables sign-in buttons

_Note: both tasks used the RED→GREEN TDD cycle; no REFACTOR commit was needed._

## Files Created/Modified

- `apps/web/src/context/AuthContext.tsx` - `AuthProvider` gains `useQueryClient()`, `previousUidRef`, `isFirstRunRef`; extends the existing `onAuthStateChanged` effect to cancel-then-clear the query cache on every uid transition
- `apps/web/src/context/AuthContext.test.tsx` - new describe block driving first-callback/sign-in/same-uid-repeat/account-switch/sign-out through the mocked auth listener, asserting `cancelQueries()` precedes `clear()`; existing FUNNEL-02 render harness updated to wrap `AuthProvider` in a `QueryClientProvider`
- `apps/web/src/pages/Home/SignInCard.tsx` - module constant `POPUP_FOCUS_GRACE_MS = 1800`; `handleGoogleSignIn` reworked with `settledRef`/`resetByGraceRef`/`graceTimeoutRef`/`popupCleanupRef`/`isMountedRef`, focus + visibilitychange listeners, and toast suppression logic
- `apps/web/src/pages/Home/SignInCard.test.tsx` - new describe block using vitest fake timers proving grace-timer re-enable, late-rejection toast suppression, and immediate-rejection toast still firing
- `apps/web/src/layouts/SidebarContent.test.tsx` - render harness updated to wrap `AuthProvider` in a `QueryClientProvider` (deviation, see below)

## Decisions Made

- Followed the PLAN's locked decision to detect uid transitions via refs rather than refactoring query keys to embed uid — lower risk, identical outcome (no cross-account leakage).
- `POPUP_FOCUS_GRACE_MS` set to 1800ms as specified (within the 1.5-2s band the PLAN required).
- Toast suppression is keyed on whether the grace timer already reset the buttons (`resetByGraceRef`), not on the specific error code — this correctly still toasts a late rejection with a different code (e.g. a genuine network error) that happens to arrive after the grace window, matching the "no confusing late toast" requirement rather than blanket-suppressing everything after a timeout.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `AuthProvider` now requires a `QueryClientProvider` ancestor**

- **Found during:** Task 1 (FB-01 implementation)
- **Issue:** Adding `useQueryClient()` to `AuthProvider` means any render tree that mounts `AuthProvider` without a `QueryClientProvider` ancestor throws `"No QueryClient set, use QueryClientProvider to set one"`. Two existing test render harnesses did this: `AuthContext.test.tsx`'s own FUNNEL-02 `renderWithProvider()`, and `SidebarContent.test.tsx`.
- **Fix:** Wrapped both render harnesses in a `QueryClientProvider` backed by a fresh `QueryClient({ defaultOptions: { queries: { retry: false } } })`, matching the pattern already used elsewhere in the codebase (e.g. `useScoutPlayer.test.tsx`, `SignInCard.test.tsx`).
- **Files modified:** `apps/web/src/context/AuthContext.test.tsx`, `apps/web/src/layouts/SidebarContent.test.tsx`
- **Verification:** Full web suite (`pnpm --filter @smash-tracker/web test`) went from 3 failing to 1265/1265 passing after the fix.
- **Committed in:** `6b6a95d` (Task 1 commit)

**2. [Environment, out of scope but noted] `@smash-tracker/shared` was unbuilt in this worktree**

- **Found during:** initial full-suite verification run
- **Issue:** This worktree's `packages/shared/dist` didn't exist (fresh worktree checkout of an untracked/gitignored `.planning` + no prior build step), causing ~76 unrelated test files across the web app to fail on `Failed to resolve import "@smash-tracker/shared"`. Not caused by this plan's changes.
- **Fix:** Ran `pnpm --filter @smash-tracker/shared build` (existing build script for an already-declared workspace dependency — not a new package install, so outside the Rule 3 package-install exclusion). Not committed (build output, gitignored).
- **Files modified:** none (build artifact only, not source)
- **Verification:** Full web suite went from 76 failed test files to 0 after the build.

---

**Total deviations:** 2 (1 Rule 3 blocking fix on test infrastructure, 1 pre-existing environment build gap resolved to unblock verification)
**Impact on plan:** Both were necessary to get an accurate green signal on the plan's own verification block; neither touched the two files the PLAN targeted for behavior changes (`AuthContext.tsx`, `SignInCard.tsx`).

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- FB-01 and FB-02 are both shipped and test-covered; this plan is one of several Phase 9 plans addressing the Phase 8 walkthrough's 5 findings — the other findings are covered by sibling plans in this phase.
- No blockers for subsequent Phase 9 plans; this plan touched only `AuthContext.tsx` and `SignInCard.tsx` per its `files_modified` frontmatter, with test-infrastructure-only edits elsewhere.

---

_Phase: 09-walkthrough-hardening_
_Completed: 2026-07-18_
