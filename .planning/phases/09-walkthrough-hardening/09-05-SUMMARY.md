---
phase: 09-walkthrough-hardening
plan: 05
subsystem: ui
tags: [react, i18n, tanstack-query, share-links, coaching-sessions]

# Dependency graph
requires:
  - phase: 09-walkthrough-hardening
    provides: "Plan 03's server 409 on name collision (POST /api/vod-shares/:token/notes) and the cascade-revoke of share links on clear-vod/delete-match"
provides:
  - "Plain-name attribution copy (no 'Coach' prefix) for coach-authored notes, both owner chip and share page"
  - "Client-side handling of the server's 409 name-collision: name-taken re-prompt with no state/localStorage persistence of the rejected name"
  - 'vodSharesQueryKey invalidation on clear-VOD and match-delete so revoked share links surface in My Shares immediately'
  - 'Always-shown share-revoke warning line in both the clear-VOD and match-delete confirm dialogs'
affects: [share-viewer, vod-manager, match-data]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Per-call TanStack Query mutation options ({ onSuccess, onError }) threaded through a deferred first-write action, so state is committed ONLY on server acceptance — never optimistically before the request resolves'

key-files:
  created: []
  modified:
    - apps/web/src/hooks/useCoachNotes.ts
    - apps/web/src/pages/Share/ShareViewPage.tsx
    - apps/web/src/pages/Share/ShareViewPage.test.tsx
    - apps/web/src/pages/VodManager/components/TimestampRow.test.tsx
    - apps/web/src/hooks/useVodNotes.ts
    - apps/web/src/hooks/useDeleteMatch.ts
    - apps/web/src/pages/MatchData/components/MatchTable.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - 'On a non-409 first-write failure, the name prompt closes without committing the name (the shared toastCoachWriteError toast already surfaced the error) — only a 409 keeps the deferred write pending and re-opens the prompt'
  - 'pendingWriteRef is deliberately NOT cleared on a 409 so the SAME write retries once an accepted name is submitted, instead of requiring the coach to re-trigger the original action'

requirements-completed: [FB-04, FB-05]

coverage:
  - id: D1
    description: "Contributor notes render a plain name (no 'Coach' prefix) on both the owner-side chip and the share page — chip styling alone marks it distinct"
    requirement: 'FB-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/components/TimestampRow.test.tsx#renders a plain-name chip for a note carrying a coach sub-object'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/Share/ShareViewPage.test.tsx#shows no edit/delete affordance for a note authored by a DIFFERENT coach session'
        status: pass
    human_judgment: false
  - id: D2
    description: "A 409 name-collision on a coach's first write re-opens the name prompt with a name-taken message, never persists the rejected name to state/localStorage, and never fires the generic save-failed toast"
    requirement: 'FB-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/Share/ShareViewPage.test.tsx#FB-04: a 409 on the first write re-opens the name prompt with the name-taken message and never persists the rejected name; a later accepted name commits and creates the note'
        status: pass
    human_judgment: false
  - id: D3
    description: 'Removing a VOD or deleting a match invalidates the vod-shares query so cascade-revoked links surface in My Shares without a manual refresh, and both confirm dialogs warn the owner beforehand'
    requirement: 'FB-05'
    verification:
      - kind: unit
        ref: 'grep -c vodSharesQueryKey apps/web/src/hooks/useVodNotes.ts apps/web/src/hooks/useDeleteMatch.ts (source-level check — no dedicated hook test file exists for these two hooks)'
        status: pass
    human_judgment: true
    rationale: "The invalidation call itself is verified via source inspection (no existing test harness for useClearVodAndNotes/useDeleteMatch to assert against invalidateQueries calls); the end-to-end 'My Shares refreshes after removing a VOD' behavior is a cross-page interaction best confirmed by a human walkthrough."

duration: 25min
completed: 2026-07-18
status: complete
---

# Phase 09 Plan 05: FB-04/FB-05 web hardening (attribution, 409 re-prompt, share-revoke UX) Summary

**Coach note attribution drops the "Coach" prefix everywhere, the share page now re-prompts (never silently drops) on a server-side 409 name collision, and clearing a VOD or deleting a match both invalidate the vod-shares query and warn the owner that share links will be revoked.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-18T10:20:30Z
- **Completed:** 2026-07-18T10:25:52Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- FB-04: `vodManager.notes.coachAttribution` and `share.coach.attribution` are plain-name interpolations (no "Coach" prefix) across all 6 locales — the chip's own styling (not the label) marks a coach-authored note as distinct.
- FB-04: `toastCoachWriteError` skips the generic save-failed toast on a 409, so `ShareViewPage`'s per-call mutation options are the sole 409 handler.
- FB-04: `ShareViewPage`'s first coach write is deferred behind the name prompt with per-call `{ onSuccess, onError }` mutation options — the candidate name commits to component state + localStorage ONLY once the server accepts it (never optimistically). A 409 re-opens the prompt showing the new `share.coach.nameTaken` message with the rejected name restored, and never persists it.
- FB-05: `useClearVodAndNotes` and `useDeleteMatch` both invalidate `vodSharesQueryKey` alongside `matchesQueryKey` on success, so a server-side cascade-revoked share link (Plan 03) surfaces in My Shares immediately.
- FB-05: The clear-VOD and match-delete confirm dialogs in `MatchTable.tsx` each gain an always-shown line (`removeVodConfirm.sharesNote` / `matchDelete.sharesNote`) warning that associated share links will be revoked, i18n'd across all 6 locales.

## Task Commits

Each task was committed atomically:

1. **Task 1: FB-04 web — plain-name attribution + 409 name-taken re-prompt (no persist-on-reject)** - `efd356b` (feat)
2. **Task 2: FB-05 web — invalidate vod-shares + confirm copy on VOD removal / match delete** - `aefbc70` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `apps/web/src/hooks/useCoachNotes.ts` - `toastCoachWriteError` skips the generic toast on a 409
- `apps/web/src/pages/Share/ShareViewPage.tsx` - `nameTaken` state, `ApiError` import, `CoachWriteOptions`-threaded deferred first write (commit-on-success, re-prompt-on-409)
- `apps/web/src/pages/Share/ShareViewPage.test.tsx` - updated attribution-copy assertion, updated first-write mutate-call assertions for the new per-call options arg, added a dedicated 409 re-prompt test
- `apps/web/src/pages/VodManager/components/TimestampRow.test.tsx` - updated the owner-side coach-chip assertions for the plain-name copy change
- `apps/web/src/hooks/useVodNotes.ts` - `useClearVodAndNotes` invalidates `vodSharesQueryKey` too
- `apps/web/src/hooks/useDeleteMatch.ts` - `useDeleteMatch` invalidates `vodSharesQueryKey` too
- `apps/web/src/pages/MatchData/components/MatchTable.tsx` - share-revoke note line added to both confirm dialogs
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `coachAttribution` → plain `{{name}}`; `share.coach.attribution` → "Note by {{name}}" equivalent; new `share.coach.nameTaken`, `matchData.table.removeVodConfirm.sharesNote`, `shared.matchDelete.sharesNote` keys

## Decisions Made

- On a non-409 first-write failure the name prompt closes without committing (the mutation's own `onError` toast already surfaced it) — retrying is a fresh write attempt, not a special-cased retry path. Only 409 rejections keep `pendingWriteRef` alive for a same-write retry.
- `withDisplayName`'s already-committed path calls `action(coachDisplayName)` with **no** second argument (rather than `mutate(payload, undefined)`), preserving the existing single-arg `mutate` call shape for every write after the first — this kept several pre-existing test assertions (`toHaveBeenCalledExactlyOnceWith(payload)`) valid unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed two pre-existing tests broken by the coachAttribution/attribution copy change**

- **Found during:** Task 1 (locale value swap for FB-04)
- **Issue:** `TimestampRow.test.tsx` asserted the old "Coach {name}" chip text, and `ShareViewPage.test.tsx` asserted the old "Coach note by {name}" attribution text — both would fail once the locale values dropped the "Coach" prefix, even though neither file is in this plan's `files_modified` list.
- **Fix:** Updated both tests' text assertions to the new plain-name / "Note by {name}" copy.
- **Files modified:** apps/web/src/pages/VodManager/components/TimestampRow.test.tsx, apps/web/src/pages/Share/ShareViewPage.test.tsx
- **Verification:** `pnpm --filter @smash-tracker/web exec vitest run src/pages/VodManager/components/TimestampRow.test.tsx src/pages/Share/ShareViewPage.test.tsx` — both pass
- **Committed in:** efd356b (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — pre-existing test breakage from a locale-value change)
**Impact on plan:** Necessary to keep the full test suite green per this plan's own `<verification>` section; no scope creep beyond fixing the two directly-broken assertions.

## Issues Encountered

- `pnpm --filter @smash-tracker/web typecheck` reports 5 pre-existing type errors in `src/context/AuthContext.test.tsx` and `src/pages/VodManager/MySharesDialog.test.tsx` (both unrelated to this plan's files, introduced in prior 09-01/09-04 commits per `git log`). Out of scope per the deviation rules' scope boundary (pre-existing issues in unrelated files) — not fixed here, documented for awareness. `vitest run` and `eslint` (0 errors) both pass regardless, since these are `tsc -b` project-reference errors in test files, not runtime failures.

## Next Phase Readiness

- FB-04 and FB-05 web-side work is complete and depends only on Plan 03's already-shipped server 409 + cascade-revoke.
- Full web suite green: `pnpm --filter @smash-tracker/web test` → 135 files / 1275 tests passed. `pnpm --filter @smash-tracker/web lint` → 0 errors (40 pre-existing warnings, none introduced by this plan).
- No blockers for the phase's combined re-walkthrough.

---

_Phase: 09-walkthrough-hardening_
_Completed: 2026-07-18_
