---
phase: 02-inline-annotation-match-editing
plan: 02
subsystem: ui
tags: [react, vod, i18n, radix, alert-dialog]

requires:
  - phase: 02-inline-annotation-match-editing (plan 01)
    provides: NoteComposer, TimestampList onUpdateTimestamps wiring, VodManagerPage handleUpdateTimestamps single-PATCH site, getCurrentTimeRef
  - phase: 01-vod-manager-core-list-embed-seek
    provides: VOD Manager master-detail page, useVodPlayer ready-gated seek, click-to-seek TimestampList rows (D-13/D-14)
provides:
  - TimestampRow component — per-row view/edit state machine with in-place time+text inputs (Enter/check saves, Esc/X cancels) and AlertDialog-confirmed delete
  - TimestampList editingIndex ownership (one row edits at a time) + commit/delete -> next-array translation for the single onUpdateTimestamps PATCH
  - i18n keys shared.vod.editTimestamp + vodManager.notes.{saveEdit,cancelEdit,deleteConfirmTitle,editTimeAria,editNoteAria} across all 6 locales
affects: [02-03-inline-annotation-match-editing]

tech-stack:
  added: []
  patterns:
    - 'In-place row edit state machine: parent owns editingIndex (single-editor invariant), row seeds draft state on edit-mode entry via render-time state adjustment (not an effect)'
    - "Destructive row action = AlertDialog confirm (MatchTable's title/cannotBeUndone/cancel/remove shape), never one-click delete"

key-files:
  created:
    - apps/web/src/pages/VodManager/components/TimestampRow.tsx
  modified:
    - apps/web/src/pages/VodManager/components/TimestampList.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "Edit-mode draft state is re-seeded via React's render-time 'adjusting state when a prop changes' pattern (mirrors VodManagerPage.trackedMatchId) rather than a useEffect — the react-hooks/set-state-in-effect lint rule rejects the effect form"
  - 'Row view-mode markup restructured from one full-width button to button + sibling pencil/trash icon buttons in a flex row — the seek/select button remains the ONLY element wired to onSeek/onSelect (D-13/D-14 preserved by construction)'
  - 'Reused shared.vod.deleteTimestamp / timeFormatError / noteRequired and common.cancel/remove/cannotBeUndone; added only the genuinely-new keys (editTimestamp, vodManager.notes.*) across all 6 locales'

patterns-established:
  - 'Single-editor list rows: parent owns editingIndex: number | null, children receive isEditing + onStartEdit/onCommitEdit/onCancelEdit and never self-toggle — reusable by 02-03 match-detail editing'

requirements-completed: [NOTE-02, NOTE-03]

coverage:
  - id: D1
    description: 'Pencil affordance swaps a note row into inline time+text inputs prefilled with current values; Enter commits via a single full-carry-through PATCH with the array re-sorted ascending; Escape discards with no mutation'
    requirement: 'NOTE-02'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#edits a timestamp note in place (no dialog), re-sorting ascending, via a single full-carry-through PATCH'
        status: pass
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#discards an in-place edit on Escape without mutating'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Trash affordance opens an AlertDialog confirm (never an immediate delete); confirming removes the note via the same PATCH; canceling closes with no mutation'
    requirement: 'NOTE-03'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#removes a note via an AlertDialog confirm (not an immediate delete), via a single full-carry-through PATCH'
        status: pass
    human_judgment: false
  - id: D3
    description: 'D-13/D-14 non-regression: row-body click still seeks the live player and highlights the row; edit/delete affordances never change the selected index or re-seek'
    requirement: 'NOTE-02'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#seeks the live player and highlights the clicked row body; edit/delete on another row do not change the selection (D-13/D-14)'
        status: pass
    human_judgment: false
  - id: D4
    description: 'All 6 locales carry an identical key set including the new edit/delete-confirm keys'
    verification:
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-10
status: complete
---

# Phase 2 Plan 2: Inline Timestamp Edit + Confirmed Delete Summary

**Extracted TimestampRow with a from-scratch in-place edit state machine (pencil -> inline time+text inputs, Enter saves and re-sorts, Esc cancels) and an AlertDialog-confirmed delete — both persisting through plan 01's single full-carry-through PATCH, with row-body click-to-seek untouched.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-10T19:56:00Z
- **Completed:** 2026-07-10T20:05:04Z
- **Tasks:** 2
- **Files modified:** 9 (1 created, 8 modified)

## Accomplishments

- New `TimestampRow` component: view mode preserves plan 01's click-to-seek/highlight button exactly; pencil and trash icon buttons (GspMatchLog's visual pairing — `Pencil`/`Trash2`, `variant="outline"`, `size="icon-sm"`) are siblings that never call `onSeek`/`onSelect` (D-13/D-14 by construction).
- In-place edit (NOTE-02): pencil swaps the row into a time `Input` (defaulted to `formatTimestamp(seconds)`) and note `Input` (defaulted to the note, `maxLength=200`) with check/X controls; Enter or check parses via `parseFlexibleTimestamp` (>= 0, no upper bound), rejects null time / empty note with an inline error, then produces the index-replaced, re-sorted-ascending array; Escape or X discards with no mutation.
- Confirmed delete (NOTE-03): trash opens an `AlertDialog` (MatchTable's structural shape — new `deleteConfirmTitle` + reused `common.cannotBeUndone`/`cancel`/`remove`); only the confirm action produces the index-filtered array. Mitigates T-02-06 (no one-click destructive action).
- `TimestampList` owns `editingIndex` (one row edits at a time) and is the sole translator of row commits/deletes into full next arrays for `onUpdateTimestamps` — plan 01's single PATCH mutation site in `VodManagerPage` is unchanged.
- Four new E2E cases (edit-commit + re-sort + carry-through, Escape-discard, delete-confirm/cancel, D-13/D-14 non-regression) written RED first, all GREEN after implementation.

## Task Commits

Each task was committed atomically (Task 2 is `tdd="true"` — its RED tests are Task 1's commit):

1. **Task 1: Failing E2E tests for inline edit and confirmed delete** - `a9d6344` (test) — 4 new cases, all RED (missing affordances, not harness errors)
2. **Task 2: Extract TimestampRow with in-place edit state machine + AlertDialog delete** - `681ca80` (feat) — makes Task 1's cases pass (GREEN); includes TimestampList editingIndex ownership and i18n across all 6 locales

**Plan metadata:** (this commit, appended after SUMMARY.md)

## Files Created/Modified

- `apps/web/src/pages/VodManager/components/TimestampRow.tsx` - New per-row component: view mode (seek button + pencil/trash siblings), edit mode (inline inputs + save/cancel), AlertDialog delete confirm (create)
- `apps/web/src/pages/VodManager/components/TimestampList.tsx` - Renders `TimestampRow` per note; owns `editingIndex`; `handleCommitEdit` (replace + re-sort) and `handleDelete` (filter) feed `onUpdateTimestamps`
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - 4 new E2E cases (edit, Escape-discard, delete confirm/cancel, D-13/D-14 non-regression)
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - New `shared.vod.editTimestamp` + `vodManager.notes.{saveEdit,cancelEdit,deleteConfirmTitle,editTimeAria,editNoteAria}` in all 6 locales

## Decisions Made

- Re-seeded edit-mode draft state via React's render-time "adjusting state when a prop changes" pattern (a `trackedIsEditing` state mirror, same idiom as `VodManagerPage.trackedMatchId`) instead of a `useEffect` — the project's `react-hooks/set-state-in-effect` lint rule (error-level) rejects synchronous setState in effects, and the render-time form also avoids a one-frame stale-draft flash.
- Restructured the view-mode row from a single full-width `<button>` (inside `<li>`) to a flex row of seek-button + pencil + trash — keeping the seek/select handler exclusively on the row-body button rather than adding stopPropagation-style nesting, so the D-13/D-14 invariant holds structurally.
- Added two additional aria-label i18n keys beyond the plan's named set (`vodManager.notes.editTimeAria`/`editNoteAria`) — the edit inputs need distinct accessible names from the composer's `shared.vod.timeAria`/`noteAria` (both are on screen at once; reusing them would create duplicate-label ambiguity for both users and testing-library queries).

## Deviations from Plan

None - plan executed exactly as written. (The two extra aria i18n keys above are within the plan's own "add new keys for the edit affordance aria-label … e.g." latitude, not a scope change.)

## Issues Encountered

- First implementation pass used a `useEffect` to re-seed edit-draft state on edit-mode entry, which tripped the error-level `react-hooks/set-state-in-effect` lint rule. Switched to the render-time state-adjustment pattern already established in `VodManagerPage`; all tests stayed green.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The single-editor `editingIndex` + `onStartEdit`/`onCommitEdit`/`onCancelEdit` row pattern is reusable by 02-03's match-detail editing.
- `handleUpdateTimestamps` remains the single PATCH mutation site — 02-03's "Use current player time" (NOTE-04) plugs into the same seam with `getCurrentTimeRef` already plumbed.
- No blockers for 02-03.

## Known Stubs

None — no placeholder values, empty-data wirings, or TODO/FIXME markers in the files created/modified by this plan.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surface beyond the plan's threat model (T-02-04/05/06 mitigations all implemented: `maxLength={200}` edit input, `parseFlexibleTimestamp` client-side validation with server schema authoritative, AlertDialog delete confirm).

---

## Self-Check: PASSED

All 9 key files confirmed present on disk; both task commits (a9d6344, 681ca80) confirmed present in git log.

---

_Phase: 02-inline-annotation-match-editing_
_Completed: 2026-07-10_
