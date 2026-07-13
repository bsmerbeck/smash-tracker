---
phase: 04-playlists
plan: 03
subsystem: ui
tags: [react, tanstack-query, cmdk, radix, i18next, playlists]

# Dependency graph
requires:
  - phase: 04-playlists (04-01)
    provides: '/api/playlists REST routes (GET/POST/PATCH/DELETE), playlistSchema/CreatePlaylistInput/UpdatePlaylistInput, MAX_PLAYLISTS_PER_USER'
  - phase: 04-playlists (04-02)
    provides: 'usePlaylists hook family, api.playlists client, resolvePlaylistMatches/addMatchToPlaylistIds/movePlaylistItem, PlaylistSelector, ?playlist= browse view'
provides:
  - 'AddToPlaylistMenu (inline in SelectedMatchMeta.tsx) — idempotent add-to-playlist, TagAddCombobox Popover+Command shape'
  - 'PlaylistRow.tsx — select + isPending-gated up/down reorder + remove-from-playlist'
  - 'VodMatchList onMoveMatch/onRemoveFromPlaylist/reorderPending props, PlaylistRow wired in for isPlaylistView'
  - 'VodManagerPage handleMoveMatch/handleRemoveFromPlaylist/handleCommitRename/handleConfirmDeletePlaylist, inline rename input + AlertDialog delete on the selector row'
affects: [04-playlists-04-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Reorder/remove arrays are computed from the RESOLVED present-only set (playlistMatches, not raw stored matchIds) before every useUpdatePlaylist PATCH — prunes soft-orphans on save (T-04-07)'
    - 'Reorder buttons gated on updatePlaylist.isPending in addition to their own boundary — the full-array-PATCH race guard for rapid clicks (RESEARCH.md Pitfall 3)'
    - 'Inline rename input uses the same "adjusting state when a prop changes" reset-during-render pattern as trackedMatchId, keyed on selectedPlaylistId — commits on Enter/blur, reverts the draft on an empty/oversized/no-op submit or a failed PATCH'

key-files:
  created:
    - apps/web/src/pages/VodManager/components/PlaylistRow.tsx
  modified:
    - apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx
    - apps/web/src/pages/VodManager/components/VodMatchList.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "Threaded playlists into SelectedMatchMeta from VodManagerPage as part of Task 1's own commit (not deferred to Task 3 as the plan's task split implied) — Task 1 makes `playlists` a required prop, and leaving the call site unwired would have broken typecheck between the Task 1 and Task 3 commits. VodManagerPage already held the `playlists` array in scope from 04-02, so this was a one-line prop pass, not new membership/reorder/rename/delete logic (that full wiring still lands in Task 3 as planned)."
  - "AddToPlaylistMenu is a local (unexported) component defined inline in SelectedMatchMeta.tsx, not a new file — the plan's Task 1 files list only names SelectedMatchMeta.tsx, and 'reuse the TagAddCombobox shape' reads as structural reuse (Popover+Command+CommandItem+stable-value+manual-filter), not literal reuse of the tag-specific component"
  - "vodManager.playlists.rename used as the rename Input's aria-label and vodManager.playlists.renamePlaceholder as its placeholder text — both plan-specified keys land on the same control with distinct roles rather than one going unused"

patterns-established: []

requirements-completed: [LIST-02, LIST-03]

coverage:
  - id: D1
    description: "Add to playlist" menu on SelectedMatchMeta lists existing playlists plus a create-new row, and adding is idempotent (re-adding an already-member match is a no-op PATCH)
    requirement: 'LIST-02'
    verification:
      - kind: other
        ref: 'grep -c "addMatchToPlaylistIds" apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx >= 1'
        status: pass
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#addMatchToPlaylistIds is idempotent — skips an id already present (04-02, underlying helper)'
        status: pass
    human_judgment: true
    rationale: "No new automated test exercises the AddToPlaylistMenu component's own render/select/create flow end-to-end (Popover open, playlist select, create-new submit, success toast) — verification for this task was grep-asserted usage of the idempotent helper plus typecheck/i18n parity, not a new component test."
  - id: D2
    description: 'PlaylistRow renders select + up/down reorder + remove; arrow buttons are disabled while a reorder mutation is in flight (reorderPending) in addition to their own boundary'
    requirement: 'LIST-02'
    verification:
      - kind: other
        ref: 'grep -cE "reorderPending|isPending" apps/web/src/pages/VodManager/components/PlaylistRow.tsx >= 1'
        status: pass
      - kind: other
        ref: 'grep -c "border-l-2 border-primary" apps/web/src/pages/VodManager/components/PlaylistRow.tsx >= 1'
        status: pass
    human_judgment: true
    rationale: "Visual reorder/remove interaction (arrow click ordering, disabled state during a real in-flight mutation, remove button removing the correct row) is not exercised by an automated test in this plan — needs a human look at the running page, same rationale 04-02 gave for PlaylistSelector's visual selection tokens."
  - id: D3
    description: 'Reorder and remove both persist via a single useUpdatePlaylist PATCH whose matchIds array is derived from the resolved (present-only) playlistMatches set, pruning any soft-orphaned id on save'
    requirement: 'LIST-02'
    verification:
      - kind: other
        ref: 'grep -c "playlistMatches" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 2'
        status: pass
      - kind: other
        ref: 'grep -c "movePlaylistItem" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 1'
        status: pass
    human_judgment: false
  - id: D4
    description: 'User can rename a playlist inline (1-40 trim, commits on Enter/blur) and delete it via an AlertDialog confirmation; deleting never touches member matches and falls back to Library if the deleted playlist was selected'
    requirement: 'LIST-03'
    verification:
      - kind: other
        ref: 'grep -c "AlertDialog" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 1'
        status: pass
      - kind: other
        ref: 'grep -cE "useDeletePlaylist|useUpdatePlaylist" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 1'
        status: pass
    human_judgment: true
    rationale: "No new automated test exercises the rename-commit/delete-confirm/fallback-to-Library flow end-to-end — the existing VodManagerPage test suite (19 pre-existing tests) all still pass unchanged after this plan's additions, but none of them cover the new rename/delete UI itself."
  - id: D5
    description: 'Full-suite regression: shared build, web test/typecheck/lint/build, and i18n parity all pass after all three tasks'
    verification:
      - kind: unit
        ref: 'apps/web (vitest): 124 test files / 1094 tests passing'
        status: pass
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web typecheck && pnpm --filter @smash-tracker/web lint (0 errors, 40 pre-existing warnings) && pnpm --filter @smash-tracker/web build'
        status: pass
    human_judgment: false

# Metrics
duration: 50min
completed: 2026-07-13
status: complete
---

# Phase 04 Plan 03: Playlist Fill + Organize (Add/Reorder/Remove/Rename/Delete) Summary

**"Add to playlist" menu on SelectedMatchMeta, `PlaylistRow` with isPending-gated up/down reorder + remove, and `VodManagerPage` handlers for add/reorder/remove/rename/delete — all membership writes go through a single `useUpdatePlaylist` PATCH whose `matchIds` array is always derived from the resolved present-only match set, pruning soft-orphans on save.**

## Performance

- **Duration:** 50 min
- **Started:** 2026-07-13T15:11:00Z (approx.)
- **Completed:** 2026-07-13T16:01:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 10 (1 created, 9 modified)

## Accomplishments

- `SelectedMatchMeta.tsx`: an inline `AddToPlaylistMenu` (Popover+Command, `TagAddCombobox`-shaped) as a sibling row to the tag row — existing playlists as `CommandItem`s keyed by `id`, a "create new" sentinel row that chains `useCreatePlaylist` → `useUpdatePlaylist`, idempotent add via `addMatchToPlaylistIds`, success toast, and the 403-cap toast on create
- `PlaylistRow.tsx` (new): select + up/down reorder arrows (lucide `ArrowUp`/`ArrowDown`, `size="icon-sm"`) + remove button, D-13 selection tokens on the active row, arrows `disabled={reorderPending || !canMove...}` — the race guard for rapid clicks (RESEARCH.md Pitfall 3)
- `VodMatchList.tsx`: renders `PlaylistRow` (instead of the normal `MatchRow`) in playlist view, threading new `onMoveMatch`/`onRemoveFromPlaylist`/`reorderPending` props
- `VodManagerPage.tsx`: `handleMoveMatch`/`handleRemoveFromPlaylist` derive their next `matchIds` from `playlistMatches` (the resolved present-only set) rather than raw stored ids; inline rename `Input` on the selector row (1-40 trim, commit on Enter/blur, reverts the draft on failure); `AlertDialog`-confirmed delete via `useDeletePlaylist` that falls back to Library if the deleted playlist was the active selection
- `vodManager.playlists.*` i18n keys (`addToPlaylist`, `addToPlaylistAria`, `added`, `moveUp`, `moveDown`, `removeFromPlaylist`, `rename`, `renamePlaceholder`, `delete`, `deleteConfirmTitle`) shipped identically across all 6 locales; i18n parity test green

## Task Commits

Each task was committed atomically:

1. **Task 1: "Add to playlist" menu on SelectedMatchMeta (idempotent)** - `5b45520` (feat)
2. **Task 2: PlaylistRow — reorder arrows (isPending-gated) + remove-from-playlist** - `82eba4b` (feat)
3. **Task 3: VodManagerPage membership handlers + inline rename + AlertDialog delete** - `80341d7` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified

- `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx` - `AddToPlaylistMenu` inline component + `playlists` prop
- `apps/web/src/pages/VodManager/components/PlaylistRow.tsx` - select + reorder + remove row for playlist view
- `apps/web/src/pages/VodManager/components/VodMatchList.tsx` - renders `PlaylistRow` in playlist mode; `onMoveMatch`/`onRemoveFromPlaylist`/`reorderPending` props
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - `handleMoveMatch`/`handleRemoveFromPlaylist`/`handleCommitRename`/`handleConfirmDeletePlaylist`, inline rename input + `AlertDialog` delete, prop threading into `SelectedMatchMeta`/`VodMatchList`
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - 10 new `vodManager.playlists.*` keys

## Decisions Made

- Threaded `playlists={playlists}` into the `SelectedMatchMeta` mount as part of Task 1's commit (VodManagerPage already held `playlists` in scope from 04-02) rather than leaving it for Task 3 as the plan's task split literally implied — Task 1 makes the prop required, and skipping the one-line wire would have broken `pnpm typecheck` (Task 1's own stated verification) between the Task 1 and Task 3 commits. This is prop wiring only; the membership/reorder/rename/delete logic Task 3 owns is untouched.
- Built the "Add to playlist" affordance as a local, unexported `AddToPlaylistMenu` function inside `SelectedMatchMeta.tsx` rather than a new component file — the plan's Task 1 `files` list names only `SelectedMatchMeta.tsx`, and "reuse the `TagAddCombobox` shape" is satisfied structurally (same Popover+Command+stable-value+manual-filter pattern) without importing the tag-specific component itself.
- Used both `vodManager.playlists.rename` (aria-label) and `.renamePlaceholder` (placeholder text) on the same rename `Input`, giving each of the plan's two specified keys a distinct, non-redundant role instead of leaving one unused.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wired `playlists` prop into the `SelectedMatchMeta` mount during Task 1**

- **Found during:** Task 1 (typecheck verification)
- **Issue:** Task 1 makes `playlists: Playlist[]` a required prop on `SelectedMatchMeta`, but the plan assigns the actual prop-threading to Task 3. Running Task 1's own stated verification (`pnpm --filter @smash-tracker/web typecheck`) in isolation would fail with a missing-required-prop error at the existing `VodManagerPage` mount site.
- **Fix:** Added `playlists={playlists}` to the existing `SelectedMatchMeta` mount in `VodManagerPage.tsx` — a one-line pass of an array already in scope, not new logic.
- **Files modified:** `apps/web/src/pages/VodManager/VodManagerPage.tsx`
- **Verification:** `pnpm --filter @smash-tracker/web typecheck` — 0 errors
- **Committed in:** `5b45520` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking type error from a cross-task required-prop dependency)
**Impact on plan:** No scope creep — a one-line prop pass using data already fetched in `VodManagerPage`. Task 3's actual membership/reorder/rename/delete logic is unaffected and lands exactly as planned.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. No new npm packages, no env vars.

## Next Phase Readiness

- LIST-02 (add/remove/reorder, all persisting through the single `useUpdatePlaylist` PATCH) and LIST-03 (rename/delete) are both complete for the web vertical slice; playlists are now genuinely fillable and organizable end-to-end.
- The soft-orphan-pruning-on-save pattern (derive the next `matchIds` from `playlistMatches`, never raw stored ids) and the `reorderPending` race-guard convention are established for any further playlist-mutation work (e.g. playback auto-advance in a later plan).
- No blockers. `pnpm --filter @smash-tracker/shared build && pnpm --filter @smash-tracker/web test/typecheck/lint/build` all green (1094 tests, 0 lint errors, 40 pre-existing warnings, i18n parity green).

---

_Phase: 04-playlists_
_Completed: 2026-07-13_

## Self-Check: PASSED

All created/modified files found on disk (`apps/web/src/pages/VodManager/components/PlaylistRow.tsx`, `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx`, `apps/web/src/pages/VodManager/components/VodMatchList.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`); all three task commits (`5b45520`, `82eba4b`, `80341d7`) found in git log.
