---
phase: 04-playlists
plan: 05
subsystem: ui
tags: [react, i18n, localStorage, vod-manager, tags, playback]

# Dependency graph
requires:
  - phase: 04-playlists (04-04)
    provides: 'useVodPlayer onEnded/onAutoplayBlocked/autoplayOnConstructRef, VodManagerPage handleEnded two-branch auto-advance, Prev/Next playback controls + "N of M" indicator'
provides:
  - 'lib/vod.ts: exported MAX_TIMESTAMPS (single shared cap source for NoteComposer and quick-tag capture)'
  - 'pages/VodManager/lib/vodPrefs.ts: readStoredQuickTags/persistQuickTags (default = NOTE_PRESET_TAGS) and readStoredPlayerSize/persistPlayerSize (default = fill), columnVisibility.ts localStorage convention'
  - 'TimestampList: editingIndex lifted to a controlled prop pair (editingIndex/onEditingIndexChange), owned by VodManagerPage'
  - 'QuickTagPanel.tsx: one-click pre-tagged instant capture panel below the player, with a Customize mode reusing TagAddCombobox for add/remove'
  - 'VodManagerPage: handleQuickTag (cap-checked instant capture routed through the existing handleUpdateTimestamps PATCH site, then opens the new row in edit mode), player compact/fill size toggle (pure className swap, no remount), Prev/Next timestamp jump'
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vodPrefs.ts clones columnVisibility.ts's localStorage convention (namespaced smash-tracker.* key, pure parseStored* tolerating malformed input, readStored*/persist* guarding typeof window and try/catch) for a SECOND device-preference domain (quick-tag set + player size) beyond the original column-visibility use case — reusable template for any future device-only preference."
    - 'Controlled-prop state lifting for cross-sibling command: editingIndex followed the same lift-to-parent pattern selectedTimestampIndex already established, specifically so a sibling (QuickTagPanel, via its parent VodManagerPage) can command a child (TimestampList) into a specific UI state after an async mutation resolves.'
    - 'Pure-className size toggle: a NEW wrapper div (not the pre-existing VodPlayer internals) carries the size-dependent class, keeping the VodPlayer JSX element at one unconditional position with zero props threaded into useVodPlayer — extends 04-04''s "identity-keyed construction must never read incidental UI state" discipline to a second axis (size, not just autoplay intent).'

key-files:
  created:
    - apps/web/src/pages/VodManager/lib/vodPrefs.ts
    - apps/web/src/pages/VodManager/lib/vodPrefs.test.ts
    - apps/web/src/pages/VodManager/components/QuickTagPanel.tsx
  modified:
    - apps/web/src/lib/vod.ts
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/pages/VodManager/components/NoteComposer.tsx
    - apps/web/src/pages/VodManager/components/TimestampList.tsx
    - apps/web/src/pages/VodManager/components/TimestampRow.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "Fixed a pre-existing bug (Rule 1) in TimestampRow.commit(): committing an in-place time/text edit built `{ seconds, note }` and silently dropped the row's existing `tags`. This directly blocked the quick-tag flow's stated behavior (capture pre-tags a note, Enter must commit text WITHOUT losing that tag) but is a general in-place-edit bug affecting any tagged note, not scoped to quick-tag capture alone. Fixed by carrying `stamp.tags` through `onCommitEdit`'s payload (omitted entirely when empty, matching the existing omit-to-clear convention)."
  - "handleQuickTag computes the inserted note's post-sort array index via `next.indexOf(newNote)` (object-identity lookup on the just-built note object) rather than re-deriving position from seconds — robust against duplicate-second edge cases and avoids re-implementing the sort's tie-breaking."
  - 'QuickTagPanel''s own root element carries `role="region"` `aria-label={t(''vodManager.capture.title'')}` — not required by the plan''s text, but needed to let VodManagerPage''s own SelectedMatchMeta match-tag combobox (which reuses the identical `tags.addAria` label as the quick-tag Customize combobox) be unambiguously distinguished in tests and assistive tech; a reasonable a11y improvement, not a scope change.'
  - "Chose a generous, unenforced-by-the-plan MAX_QUICK_TAGS = 20 cap on the quick-tag button SET itself (distinct from MAX_TIMESTAMPS, the per-match note cap, and the existing MAX_NOTE_TAGS = 5 per-note cap) so QuickTagPanel's own addTagToList call has a bound — CONTEXT.md/RESEARCH.md left this edge undecided; picked to match the existing per-note tag cap's order of magnitude without inventing new i18n surface."
  - "Compact mode caps the player wrapper at `md:max-w-[560px]` (a concrete Tailwind value) — the plan specified 'a width cap (e.g. md:max-w-[560px]-style)' as an example, not a locked pixel value; used verbatim since no other constraint was given."

requirements-completed: [LIST-04]

coverage:
  - id: D1
    description: 'One click on a QuickTagPanel button instantly captures a pre-tagged, empty-text note at the current playback time via the existing handleUpdateTimestamps PATCH site, enforcing the shared MAX_TIMESTAMPS cap, then opens the new row in edit mode (Enter commits text without losing the tag, Esc keeps the saved note)'
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#captures an instant pre-tagged note via a Quick tags panel button, then opens it in edit mode'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#blocks a quick-tag capture once the match is at the MAX_TIMESTAMPS cap, via the existing cap toast'
        status: pass
    human_judgment: false
  - id: D2
    description: 'The quick-tag button set is customizable (add presets/custom tags via the reused TagAddCombobox, remove via chip X) and persists across reloads on the same device via localStorage — no server storage'
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#customizes the quick-tag panel (adds a custom tag, removes a preset) and persists the set to localStorage'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/lib/vodPrefs.test.ts (19 tests: parseStoredQuickTags fallback/dedupe, persistQuickTags/readStoredQuickTags round-trip + storage key + no-throw)'
        status: pass
    human_judgment: false
  - id: D3
    description: 'The player compact/fill size toggle persists per device (default fill), keeps the aspect-video frame, and NEVER remounts the player (pure className swap; VodPlayer stays at one unconditional JSX position, size never threaded into useVodPlayer)'
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#toggles the player between compact and fill via a pure className swap (no remount) and persists the choice'
        status: pass
      - kind: other
        ref: 'grep -c "<VodPlayer" apps/web/src/pages/VodManager/VodManagerPage.tsx — single JSX mount confirmed by direct code inspection (line ~672); literal grep count is inflated to 2 by the unrelated useState<VodPlayerSize> generic, a wording artifact of the acceptance-criteria grep, not a functional issue'
        status: pass
    human_judgment: false
  - id: D4
    description: 'Prev/Next timestamp jump buttons seek to and select the previous/next time-sorted note (clamped at boundaries, nothing-selected defaults sensibly), disabled with zero notes'
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#Prev/Next timestamp buttons seek to and select the previous/next time-sorted note, clamped at the boundaries'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#disables the Prev/Next timestamp buttons when the selected match has zero notes'
        status: pass
    human_judgment: false
  - id: D5
    description: 'Full-suite regression: shared build, web test/typecheck/lint/build, and i18n parity all pass after all three tasks'
    verification:
      - kind: unit
        ref: 'apps/web (vitest): 125 test files / 1127 tests passing'
        status: pass
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web typecheck && pnpm --filter @smash-tracker/web lint (0 errors, 40 pre-existing warnings) && pnpm --filter @smash-tracker/web build'
        status: pass
    human_judgment: false
  - id: D6
    description: 'End-of-phase human-check walkthrough: full playlist + capture + player-size + mobile-autoplay walkthrough on a deployed preview channel (Plan 04-01 backend must be prod-deployed first)'
    verification: []
    human_judgment: true
    rationale: "Real cross-device/cross-browser behavior (mobile Safari autoplay-block fallback, actual preview-channel deploy against the prod API, visual/tactile compact-mode capture ergonomics) cannot be exercised by automated tests in this environment — explicitly deferred to the orchestrator-presented human-check per this plan's own stated scope."
---

# Phase 04 Plan 05: Quick Tags, Customize, Player Size Toggle, Timestamp Jump Summary

**One-click pre-tagged instant capture via a distinct Quick tags panel (customizable set, TagAddCombobox reuse, localStorage-persisted), a compact/fill player size toggle that never remounts the player, and Prev/Next timestamp jump — the final plan of the VOD Manager playlists phase.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-07-13T19:58:00Z (approx.)
- **Completed:** 2026-07-13T20:20:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 15 (3 created, 12 modified)

## Accomplishments

- `lib/vod.ts` now exports `MAX_TIMESTAMPS = 20` as the single shared timestamp cap; `NoteComposer.tsx` imports it instead of declaring a local copy — no divergent literal can exist between the composer and the new quick-tag capture path
- `editingIndex` lifted out of `TimestampList` into a controlled `editingIndex`/`onEditingIndexChange` prop pair, owned by `VodManagerPage` alongside the already-lifted `selectedTimestampIndex`, reset whenever the selected match changes
- New `pages/VodManager/lib/vodPrefs.ts` clones `columnVisibility.ts`'s localStorage convention for two device-only preferences: the quick-tag button set (`smash-tracker.vodQuickTags`, default = the 11 `NOTE_PRESET_TAGS`, deduped/malformed-tolerant) and player size (`smash-tracker.vodPlayerSize`, default `'fill'`, exact-literal `'compact'` match only) — neither preference is ever sent to the API
- New `QuickTagPanel.tsx`: a distinct bordered "Quick tags" panel (role="region") mounted directly below the player. One click on a button instantly captures a pre-tagged, empty-text note at the CURRENT playback time via the existing `handleUpdateTimestamps` single-PATCH site (never a parallel mutation), enforcing the shared `MAX_TIMESTAMPS` cap with the existing `timestampLimit` toast, then drops the freshly-inserted row into edit mode. A "Customize" toggle swaps the buttons for removable chips and reuses `TagAddCombobox` (presets + custom tags) to add entries — every add/remove persists via `vodPrefs.ts`
- Player compact/fill size toggle (`VodManagerPage`): a small icon `Button` (`Minimize2`/`Maximize2`) overlays the player's corner. Toggling is a PURE className swap on a new wrapper `div` around the unchanged `VodPlayer` element — the player stays at exactly one unconditional JSX position, is never given a size-dependent `key`, and `playerSize` is never threaded into `useVodPlayer`'s options/identity, so toggling never remounts the player or interrupts playback. Compact mode caps the wrapper at `md:max-w-[560px]` while `VodPlayer`'s own `aspect-video`/`rounded-lg`/`border` frame classes are untouched; fill mode is today's full-width default
- Prev/Next TIMESTAMP jump buttons (`ChevronLeft`/`ChevronRight`), grouped in the same row as the existing playlist Prev/Next cluster — distinct from 04-04's playlist navigation. Moves `selectedTimestampIndex` by -1/+1 through the time-sorted note order (clamped at the boundaries; nothing-selected defaults Prev to the last note and Next to the first), reusing the existing seek ref and lifted selection state. Disabled when the match has zero notes
- Fixed a pre-existing bug (Rule 1): `TimestampRow.commit()` dropped a note's `tags` when committing an in-place time/text edit — now carries `stamp.tags` through, required for quick-tag capture's "Enter commits text, tag survives" contract but fixes the general in-place-edit flow too
- `vodManager.capture.*` (`title`, `customize`, `customizeAria`, `removeQuickTagAria`, `quickTagAria`, `quickTagHint`, `prevTimestamp`, `nextTimestamp`) and `vodManager.player.{compactAria,fillAria}` i18n keys shipped identically across all 6 locales; i18n parity test green
- 26 new/updated automated tests across 3 tasks: `vodPrefs.ts` (19 tests — malformed/non-array/empty-array fallback, dedupe, exact-literal player-size matching, no-throw persistence), plus 7 new `VodManagerPage` tests (instant capture + edit-mode handoff + tag-preserving commit, `MAX_TIMESTAMPS` cap blocks capture, Customize add/remove + localStorage persistence, size toggle never-remounts + persists, Prev/Next timestamp seek/select/clamp, zero-notes disabled state)

## Task Commits

Each task was committed atomically:

1. **Task 1: Foundations — hoist MAX_TIMESTAMPS, lift editingIndex, vodPrefs localStorage lib** - `1e87675` (feat, TDD RED-first)
2. **Task 2: QuickTagPanel — one-click capture + Customize (TagAddCombobox shape)** - `f9c2677` (feat)
3. **Task 3: Player size toggle (no remount) + Prev/Next timestamp jump + end-of-phase human check** - `fa36fa0` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified

- `apps/web/src/lib/vod.ts` - exports `MAX_TIMESTAMPS = 20` (hoisted, single shared source)
- `apps/web/src/pages/VodManager/lib/vodPrefs.ts` - quick-tag set + player size localStorage persistence
- `apps/web/src/pages/VodManager/lib/vodPrefs.test.ts` - 19 tests, TDD RED-first
- `apps/web/src/pages/VodManager/components/QuickTagPanel.tsx` - one-click capture panel + Customize mode
- `apps/web/src/pages/VodManager/components/NoteComposer.tsx` - imports the hoisted `MAX_TIMESTAMPS` instead of a local declaration
- `apps/web/src/pages/VodManager/components/TimestampList.tsx` - `editingIndex`/`onEditingIndexChange` controlled props (state lifted out)
- `apps/web/src/pages/VodManager/components/TimestampRow.tsx` - commit() now carries the note's existing `tags` through (bug fix)
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - `editingIndex`/`quickTags`/`playerSize` state, `handleQuickTag`, `handleTogglePlayerSize`, `handlePrevTimestamp`/`handleNextTimestamp`, QuickTagPanel mount, player size wrapper + toggle button, timestamp Prev/Next controls
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - 7 new tests for quick-tag capture, cap enforcement, customize/persistence, size toggle, and timestamp jump
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `vodManager.capture.*` and `vodManager.player.*` keys

## Decisions Made

- Fixed a pre-existing bug (Rule 1) in `TimestampRow.commit()` that silently dropped a note's tags on in-place edit — see `key-decisions` in frontmatter for full rationale.
- `handleQuickTag` locates the freshly-inserted note's post-sort index via object-identity `next.indexOf(newNote)` rather than re-deriving from seconds, avoiding any need to re-implement the sort's tie-breaking rules.
- Added `role="region"` + `aria-label` to `QuickTagPanel`'s root — not plan-mandated, but needed to disambiguate its `TagAddCombobox` from `SelectedMatchMeta`'s own (both use the identical `tags.addAria` label) in both tests and assistive tech.
- Chose `MAX_QUICK_TAGS = 20` as a generous, plan-undecided cap on the quick-tag button SET itself (distinct from the per-match `MAX_TIMESTAMPS` and per-note `MAX_NOTE_TAGS = 5`).
- Compact mode's width cap (`md:max-w-[560px]`) was given as an illustrative example in the plan text and used verbatim since no other value was specified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `TimestampRow.commit()` silently dropping a note's tags on in-place edit**

- **Found during:** Task 2 (writing the "captures an instant pre-tagged note ... then Enter commits" test)
- **Issue:** `commit()` built `onCommitEdit(index, { seconds, note })`, omitting the row's existing `tags` entirely. Any note WITH tags that then had its time/text edited in place would silently lose its tags on save — a pre-existing bug in the Phase 3 edit flow, surfaced directly by this plan's quick-tag capture requirement ("Enter commits ... tag + time already saved").
- **Fix:** `commit()` now spreads `stamp.tags` into the committed payload when non-empty (omitted entirely when empty, matching the existing omit-to-clear convention used elsewhere in this file for tags).
- **Files modified:** `apps/web/src/pages/VodManager/components/TimestampRow.tsx`
- **Verification:** New `VodManagerPage` test explicitly asserts the tag survives an Enter-commit after quick-tag capture; full test suite green (1127/1127)
- **Committed in:** `f9c2677` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug fix)
**Impact on plan:** No scope creep. The fix was required for this plan's own stated quick-tag capture behavior ("Enter commits, tag survives") and additionally corrects a pre-existing bug in the general in-place-edit flow for any tagged note.

## Issues Encountered

None beyond the deviation above. One test-design note: the "captures an instant pre-tagged note ... then opens it in edit mode" test needed a mutable fake `listMatches`/`updateMatch` pairing (rather than this file's usual static `listMatches.mockResolvedValue`) because the assertion depends on TanStack Query's `invalidateQueries`-triggered refetch actually reflecting the just-PATCHed note — the other tests in this file only assert on `updateMatch`'s call arguments, which doesn't require this.

## User Setup Required

None — no external service configuration required. No new npm packages, no env vars. Both new preferences (quick-tag set, player size) are `localStorage`-only, per the phase's locked "no server storage" decision.

## Next Phase Readiness

- This is the LAST plan of the 04-playlists phase. All automated verification is green: `pnpm --filter @smash-tracker/shared build` + `pnpm --filter @smash-tracker/web test` (1127 tests) + `test -- i18n` (parity) + `typecheck` + `lint` (0 errors, 40 pre-existing warnings) + `build` all pass.
- **The end-of-phase human-check walkthrough (Task 3's `<human-check>` block) has NOT been executed by this automated task** — per the orchestrator's explicit instruction, it is presented by the orchestrator after this wave completes, not run inline here. It covers: playlist CRUD, cross-video auto-advance (incl. mobile Safari autoplay-block fallback), the playlist Prev/Next controls, quick-tag capture + Customize persistence (both compact and fill player modes), the Prev/Next timestamp jump, and one non-English locale spot-check. Its stated PRECONDITION is that Plan 04-01's backend (rev 00035) is already deployed to prod, since preview channels hit the prod API.
- The `vodPrefs.ts` localStorage-preference pattern (device-only, no server round-trip, `columnVisibility.ts`-style parse/read/persist triad) is now established for a second domain beyond column visibility — reusable for any future per-device UI preference.
- No blockers for merge; the only outstanding item for this milestone is the human walkthrough itself.

## Known Stubs

None — every deliverable is fully wired: quick-tag capture writes through the real PATCH mutation, the customize set and player size genuinely persist to `localStorage` (verified via direct `localStorage.getItem` assertions in tests), and the Prev/Next timestamp controls drive the real seek ref.

---

_Phase: 04-playlists_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified/created files found on disk (`apps/web/src/lib/vod.ts`, `apps/web/src/pages/VodManager/lib/vodPrefs.ts`, `apps/web/src/pages/VodManager/lib/vodPrefs.test.ts`, `apps/web/src/pages/VodManager/components/QuickTagPanel.tsx`, `apps/web/src/pages/VodManager/components/NoteComposer.tsx`, `apps/web/src/pages/VodManager/components/TimestampList.tsx`, `apps/web/src/pages/VodManager/components/TimestampRow.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.test.tsx`, `apps/web/src/i18n/locales/en.json`, `apps/web/src/i18n/locales/ja.json`); all three task commits (`1e87675`, `f9c2677`, `fa36fa0`) found in git log.
