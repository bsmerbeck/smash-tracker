---
phase: 02-inline-annotation-match-editing
plan: 03
subsystem: ui
tags: [react, vod, i18n, react-hook-form, sync-lock]

requires:
  - phase: 02-inline-annotation-match-editing (plan 01)
    provides: getCurrentTimeRef plumbing (VodPlayer -> VodManagerPage), single-PATCH carry-through discipline
  - phase: 02-inline-annotation-match-editing (plan 02)
    provides: TimestampRow in-place edit pattern, single-editor list rows
  - phase: 01-vod-manager-core-list-embed-seek
    provides: VOD Manager master-detail page, SelectedMatchMeta read-only dl block, useVodPlayer no-remount identity handling
provides:
  - SelectedMatchMeta component — view/edit toggle metadata card with inline MatchFormFields (no dialog), full carry-through PATCH, Synced badge
  - syncLocked prop on MatchFormFields — per-field fieldset[disabled] around exactly the 9 sync-owned controls mirroring changesSyncOwnedFields
  - vodStartSecondsAccessory slot prop on MatchFormFields — "Use current player time" button injection point
  - matchToFormValues exported from EditMatchForm for reuse
  - i18n keys vodManager.useCurrentTime + vodManager.meta.edit across all 6 locales
affects: []

tech-stack:
  added: []
  patterns:
    - 'Per-field <fieldset disabled className="contents"> sync-lock: wraps each locked FormField individually so layout is unchanged and native controls cascade-disable; default-false is inert for existing callers'
    - 'Optional ReactNode slot prop (vodStartSecondsAccessory) to inject caller-specific UI adjacent to a shared form field without duplicating the field'

key-files:
  created:
    - apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx
  modified:
    - apps/web/src/components/match-form/MatchForm.tsx
    - apps/web/src/components/match-form/EditMatchForm.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - 'Sync-locked the whole opponentName combobox via fieldset[disabled] on its wrapping FormItem — the trigger is a native <button> so cascade-disable works without touching the Popover internals'
  - 'Placed the Synced badge once at the top of MatchFormFields (rendered only when syncLocked) rather than per-field — one visual token labels the whole locked group, reusing matchData.table.synced'
  - 'SelectedMatchMeta resets the form from matchToFormValues(match) on every Edit click (not just mount) so a re-edit after an external match update never shows stale values — mirrors EditMatchForm.handleOpenChange'
  - "VodManagerPage reuses MatchDataPage's exact fighterSprites derivation (useFighters -> getFighterById filter) rather than inventing a new lookup"

patterns-established:
  - 'Sync-owned field lock: any client form over Match game-facts must mirror changesSyncOwnedFields (apps/api/src/services/rtdb.ts) verbatim — the authoritative list is cross-referenced by name in MatchForm.tsx'

requirements-completed: [NOTE-04]

coverage:
  - id: D1
    description: 'Metadata card Edit affordance swaps to inline MatchFormFields; Save issues one full carry-through PATCH preserving notes/vodTimestamps/gsp; Cancel restores view with no mutation'
    requirement: 'NOTE-04'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#shows an Edit affordance on the metadata card; editing and saving persists a full carry-through PATCH'
        status: pass
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#returns to the read-only view without a mutation on Cancel'
        status: pass
    human_judgment: false
  - id: D2
    description: 'On a synced match exactly the 9 sync-owned fields are disabled while notes/vodUrl/vodStartSeconds/gsp stay editable'
    requirement: 'NOTE-04'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#disables sync-owned fields but keeps notes/vodUrl/vodStartSeconds/gsp editable for a synced match'
        status: pass
    human_judgment: false
  - id: D3
    description: '"Use current player time" writes the live playback position (formatted) into the vodStartSeconds field'
    requirement: 'NOTE-04'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#fills the VOD start-time field from the live position via "Use current player time"'
        status: pass
    human_judgment: false
  - id: D4
    description: 'Editing metadata never remounts the player (video identity unchanged)'
    requirement: 'NOTE-04'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#does not remount the player when editing match metadata'
        status: pass
    human_judgment: false
  - id: D5
    description: 'All 6 locales carry an identical key set including vodManager.useCurrentTime and vodManager.meta.edit'
    verification:
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-07-10
status: complete
---

# Phase 2 Plan 3: Inline Match-Detail Editing Summary

**Extracted SelectedMatchMeta with a view/edit toggle that swaps the read-only metadata card into the shared MatchFormFields inline — sync-owned fields fieldset-disabled on synced matches (mirroring the server's changesSyncOwnedFields 409 contract field-for-field), a "Use current player time" button beside the VOD start-time field, and a full carry-through PATCH that preserves notes and timestamps without remounting the player.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-07-10T20:12:00Z
- **Completed:** 2026-07-10T20:26:05Z
- **Tasks:** 2
- **Files modified:** 11 (1 created, 10 modified)

## Accomplishments

- `SelectedMatchMeta` extracted from `VodManagerPage` into its own component: view mode keeps the original read-only `<dl>` block plus an "Edit details" button (and a Synced badge on synced matches); edit mode renders the shared `MatchFormFields` inline in the card — no dialog, no separate page, no divergent second form.
- Save reuses `matchToFormValues` (now exported from `EditMatchForm`) + `useMatchForm(requireOpponent: false)` + `matchFormValuesToInput` + the exact `vodTimestamps` carry-through shape from `EditMatchForm.onSubmit` — the E2E asserts notes, vodTimestamps, AND gsp all survive an edit (T-02-08 mitigation).
- `MatchFormFields` gained an optional `syncLocked` prop (default `false` — inert for AddMatchForm/EditMatchForm, whose full test suites stay green): each of the 9 sync-owned controls is individually wrapped in `<fieldset disabled={syncLocked} className="contents">` so layout is unchanged and native controls cascade-disable. The list mirrors `changesSyncOwnedFields` (apps/api/src/services/rtdb.ts) verbatim and cross-references it by name in a doc comment: fighterId, opponentFighterId, stageId, opponentName, matchType, result, stocksLeft, eventName + tournamentName. notes/vodUrl/vodStartSeconds/gsp are never wrapped (T-02-07: the server 409 guard stays authoritative; the client lock is UX).
- `MatchFormFields` also gained a `vodStartSecondsAccessory?: ReactNode` slot (default undefined — nothing renders for other callers) beside the vodStartSeconds field; `SelectedMatchMeta` injects a "Use current player time" button that writes `formatTimestamp(getCurrentTimeRef.current?.() ?? 0)` into the field — reusing 02-01's ref plumbing with zero new player surface.
- Player never remounts across an edit+save (E2E asserts `Player` construction count stays 1) — video identity is untouched by metadata edits.
- New i18n keys `vodManager.useCurrentTime` + `vodManager.meta.edit` across all 6 locales (en/es/fr/de/pt/ja); Save/Cancel/toasts/Synced badge all reuse existing keys.

## Task Commits

Each task was committed atomically (Task 2 is `tdd="true"` — its RED tests are Task 1's commit):

1. **Task 1: Failing E2E tests for inline match edit, sync-lock, and Use-current-time** - `7025b30` (test) — 5 new cases, all RED (missing Edit affordance, not a harness error)
2. **Task 2: Extract SelectedMatchMeta with view/edit toggle, sync-lock fieldset, and Use-current-time** - `e75fe04` (feat) — makes Task 1's cases pass (GREEN); includes MatchFormFields syncLocked/accessory props and i18n across all 6 locales

**Plan metadata:** (this commit, appended after SUMMARY.md)

## Files Created/Modified

- `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx` - New extracted metadata card: view/edit state, inline form, carry-through onSubmit, Synced badge, Use-current-time accessory (create)
- `apps/web/src/components/match-form/MatchForm.tsx` - `syncLocked` + `vodStartSecondsAccessory` props on `MatchFormFields`; per-field fieldset wrapping with the `changesSyncOwnedFields` cross-reference comment
- `apps/web/src/components/match-form/EditMatchForm.tsx` - `matchToFormValues` exported for reuse (no behavior change)
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - Inline `SelectedMatchMeta` function removed; new component wired with `fighterSprites` (useFighters-derived, same as MatchDataPage) + `getCurrentTimeRef`
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - 5 new E2E cases (edit+save carry-through, cancel, sync-lock, use-current-time, no-remount)
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - New `vodManager.useCurrentTime` + `vodManager.meta.edit` keys in all 6 locales

## Decisions Made

- Wrapped the opponentName combobox's FormItem in the sync-lock fieldset — its Popover trigger is a native `<button>`, so `fieldset[disabled]` cascade-disables it without modifying Popover internals.
- Rendered the Synced badge once at the top of `MatchFormFields` (only when `syncLocked`) instead of per-field — one visual token labels the whole locked group, reusing `matchData.table.synced`/`syncedTitle` (and deliberately NOT copying MatchTable's hide-the-edit-button behavior — NOTE-04 wants fields present-but-disabled).
- `SelectedMatchMeta.handleEdit` calls `form.reset(matchToFormValues(match))` on every Edit click (mirrors `EditMatchForm.handleOpenChange`) so a re-edit after an external update (e.g. a note added between edits) never shows stale values.
- Reused MatchDataPage's exact `fighterSprites` derivation (`useFighters` → `getFighterById` filter) in VodManagerPage rather than inventing a new lookup.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Execution was interrupted once by an API connection error mid-Task-2 (after the implementation files were written, before i18n keys were added); resumed cleanly from the uncommitted worktree state — no rework needed.
- The lint-staged prettier hook reformatted the fieldset-wrapped JSX indentation at commit time; re-ran the affected test files post-commit to confirm the committed state stays green (43/43).

## User Setup Required

None - no external service configuration required.

## End-of-Phase Human Check (for the orchestrator)

The plan's final task carries an end-of-phase `<human-check>` — present these items to the user (run `pnpm --filter @smash-tracker/shared build` if dist is stale, then `pnpm --filter @smash-tracker/web dev`, open `/vod`, select a YouTube/Twitch match):

- (NOTE-01) composer time field prefills the live position; typing a note + Enter saves it sorted, video does not pause.
- (NOTE-02) a note's pencil swaps the row to inline inputs; edit time + Enter re-sorts; Esc cancels.
- (NOTE-03) a note's trash opens an AlertDialog confirm; confirm removes it; row-body click still seeks + highlights.
- (NOTE-04) metadata Edit swaps fields in place; Save persists and notes survive; on a start.gg/parry.gg synced match the game-fact fields are disabled while notes/VOD link/start time/GSP stay editable; "Use current player time" fills the start-time field from the live position.
- Also confirm switching between two matches sharing one video repositions rather than reloads the player.

## Next Phase Readiness

- Phase 2 (inline annotation + match editing) is code-complete: NOTE-01 through NOTE-04 all have passing E2E coverage; only the end-of-phase human check remains.
- The `syncLocked`/`vodStartSecondsAccessory` props are reusable by any future form surface over Match game-facts (e.g. a phase 3 bulk-edit or playlist-item editor).

## Known Stubs

None — no placeholder values, empty-data wirings, or TODO/FIXME markers in the files created/modified by this plan.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surface beyond the plan's threat model (T-02-07/08/09 mitigations all implemented: server-authoritative 409 guard untouched with client fieldset as UX-only, full carry-through PATCH via matchFormValuesToInput + explicit vodTimestamps carry, shared buildMatchFormSchema zod validation with no parallel client-only validation).

---

## Self-Check: PASSED

All 11 key files confirmed present on disk; both task commits (7025b30, e75fe04) confirmed present in git log.

---

_Phase: 02-inline-annotation-match-editing_
_Completed: 2026-07-10_
