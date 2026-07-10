---
phase: 02-inline-annotation-match-editing
plan: 01
subsystem: ui
tags: [react, vod, i18n, tanstack-query]

requires:
  - phase: 01-vod-manager-core-list-embed-seek
    provides: useVodPlayer ready-gated hook, VodPlayer seekRef plumbing, read-only TimestampList, VOD Manager master-detail page
provides:
  - getCurrentTime() on useVodPlayer/YouTubePlayerInstance/TwitchPlayerInstance (ready-gated, returns 0 before ready, on-demand only)
  - getCurrentTimeRef prop on VodPlayer mirroring the existing seekRef pattern
  - NoteComposer component — persistent inline add-note form (never a modal)
  - TimestampList extended with composer + full-overwrite PATCH wiring (onUpdateTimestamps)
  - VodManagerPage handleUpdateTimestamps using buildUpdateInput + useUpdateMatch
affects: [02-02-inline-annotation-match-editing, 02-03-inline-annotation-match-editing]

tech-stack:
  added: []
  patterns:
    - "On-demand player-position read via a ref-forwarded getCurrentTime function (mirrors seek's ref-plumbing) — never polled"
    - 'Inline composer pattern: local component state (timeInput/noteInput/timeError), Enter-to-save via onKeyDown, one-shot onFocus prefill'

key-files:
  created:
    - apps/web/src/pages/VodManager/components/NoteComposer.tsx
  modified:
    - apps/web/src/lib/useVodPlayer.ts
    - apps/web/src/lib/useVodPlayer.test.ts
    - apps/web/src/pages/VodManager/components/VodPlayer.tsx
    - apps/web/src/pages/VodManager/components/TimestampList.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "Ported VodNotesDialog.handleAddTimestamp's parse/cap/sort logic verbatim into NoteComposer, swapping parseTimestamp for parseFlexibleTimestamp per CONTEXT.md"
  - 'Single PATCH mutation site (VodManagerPage.handleUpdateTimestamps) owns buildUpdateInput carry-through; NoteComposer/TimestampList only produce the next array, never call the mutation directly'
  - 'Added a genuinely-new i18n key (vodManager.composer.title) across all 6 locales as a small visible label above the composer inputs; every other composer string reuses existing shared.vod.* keys'

patterns-established:
  - "On-demand ref-forwarded player reads (getCurrentTimeRef) for one-shot 'capture the moment' interactions — reusable by a future 'Use current player time' button (NOTE-04)"

requirements-completed: [NOTE-01]

coverage:
  - id: D1
    description: "getCurrentTime() added to useVodPlayer (ready-gated, returns 0 before ready, never throws, never polled) and forwarded via VodPlayer's getCurrentTimeRef prop"
    requirement: 'NOTE-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts#getCurrentTime() returns 0 without throwing before the player is ready (Pitfall 3 guard)'
        status: pass
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts#constructs a YT.Player for a youtube vodUrl and gates seek behind onReady'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Persistent inline NoteComposer lets a user add a timestamp note while the VOD plays — auto-captures the live position on focus, saves on Enter, sorts ascending, persists via a single full-carry-through PATCH, never pauses playback'
    requirement: 'NOTE-01'
    verification:
      - kind: e2e
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#adds a timestamp note via the inline composer, prefilled from the live position, sorted ascending, carrying through other match fields'
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-10
status: complete
---

# Phase 2 Plan 1: Inline Note Composer Summary

**Persistent inline "add a timestamp note" composer below the VOD player — auto-captures live playback position on focus, saves on Enter, sorts ascending, persists via a single full-carry-through PATCH that never pauses the video.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-10T19:40:00Z
- **Completed:** 2026-07-10T19:50:13Z
- **Tasks:** 3
- **Files modified:** 13 (1 created, 12 modified)

## Accomplishments

- `useVodPlayer` gained a ready-gated `getCurrentTime()` (mirrors `seek`'s exact guard clause — returns `0` before ready, never throws, never polled) exposed to `VodPlayer` via a new `getCurrentTimeRef` prop.
- New `NoteComposer` component renders a persistent inline time+note+add control at the top of `TimestampList`, directly below the player — no modal. Focusing the time input prefills it from the live position exactly once; Enter on either input or clicking add saves.
- `TimestampList`/`VodManagerPage` now wire a single `handleUpdateTimestamps` PATCH mutation (via `buildUpdateInput` + `useUpdateMatch`) that carries every other match field through unchanged (verified against `gsp`, `win`, `fighter_id` in the fixture).
- A user watching a VOD in the manager can now add a timestamp note without leaving the page, pausing playback, or reopening the old `VodNotesDialog` — direct answer to the Phase 1 checkpoint feedback ("I don't see a way to add timestamp notes on the page").

## Task Commits

Each task was committed atomically (Tasks 2 and 3 are `tdd="true"` — RED then GREEN):

1. **Task 1: Failing end-to-end test for the add-note happy path** - `ec58ee3` (test)
2. **Task 2: Add getCurrentTime() to useVodPlayer and getCurrentTimeRef to VodPlayer**
   - RED: `52c950c` (test) — failing guard test, `getCurrentTime` not yet on the hook's return contract
   - GREEN: `c369e23` (feat) — implementation, mirrors `seek`'s ready-gate guard exactly
3. **Task 3: NoteComposer + TimestampList render + VOD Manager PATCH wiring + i18n** - `cd93e23` (feat) — makes Task 1's RED E2E assertions pass (GREEN)

**Plan metadata:** (this commit, appended after SUMMARY.md)

## Files Created/Modified

- `apps/web/src/pages/VodManager/components/NoteComposer.tsx` - New inline add-note composer (create); ported add/cap/sort logic from `VodNotesDialog`
- `apps/web/src/lib/useVodPlayer.ts` - Added `getCurrentTime()` to both vendor interfaces, `UseVodPlayerResult`, and the hook implementation
- `apps/web/src/lib/useVodPlayer.test.ts` - New pre-ready guard test; extended existing mocks with `getCurrentTime`
- `apps/web/src/pages/VodManager/components/VodPlayer.tsx` - New `getCurrentTimeRef` prop, mirrors `seekRef` plumbing
- `apps/web/src/pages/VodManager/components/TimestampList.tsx` - Renders `NoteComposer` above rows (even when empty); extended props (`getCurrentTimeRef`, `onUpdateTimestamps`)
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - Added `getCurrentTimeRef`, `handleUpdateTimestamps` PATCH wiring via `buildUpdateInput` + `useUpdateMatch`
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - New add-note E2E test; extended YT mocks with `getCurrentTime`; mocked `api.matches.update`
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - Added `vodManager.composer.title` key to all 6 locales

## Decisions Made

- Ported `VodNotesDialog.handleAddTimestamp`'s parse/cap/sort logic verbatim into `NoteComposer` rather than re-deriving it, swapping the stricter `parseTimestamp` for `parseFlexibleTimestamp` per CONTEXT.md's locked decision (flexible parser everywhere this phase).
- Kept the single-PATCH-mutation-site discipline: `NoteComposer`/`TimestampList` only ever produce the next `vodTimestamps` array; `VodManagerPage.handleUpdateTimestamps` is the only place that calls `useUpdateMatch`.
- Added exactly one genuinely-new i18n key (`vodManager.composer.title`, a small visible label above the composer) across all 6 locales; every other composer string (placeholders, aria-labels, errors, add-button sr-only text) reuses the existing `shared.vod.*` keys unchanged.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `@smash-tracker/shared`'s `dist/` was stale in the worktree (fresh worktree checkout) — ran `pnpm --filter @smash-tracker/shared build` before the first test run, per the plan's own verification-environment note. Not a deviation from plan content, just a required build-order step.
- The new `useVodPlayer.test.ts` guard test initially tripped `@typescript-eslint/no-unused-vars` on unused mock-constructor parameters — fixed by capturing and asserting the `config` argument (matching the file's own established pattern) rather than leaving it unused.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `getCurrentTimeRef` is now available on `VodPlayer`/`VodManagerPage` for reuse by 02-03's "Use current player time" button (NOTE-04) without any further plumbing.
- `TimestampList`'s `onUpdateTimestamps` callback is the wiring seam 02-02's in-place row edit/delete (NOTE-02/NOTE-03) will extend — no new PATCH mutation needed, same `handleUpdateTimestamps` site.
- No blockers for 02-02/02-03.

---

## Self-Check: PASSED

All 9 key files confirmed present on disk; all 5 commits (ec58ee3, 52c950c, c369e23, cd93e23, 841648a) confirmed present in git log.

---

_Phase: 02-inline-annotation-match-editing_
_Completed: 2026-07-10_
