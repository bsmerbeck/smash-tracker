---
phase: 04-playlists
plan: 04
subsystem: ui
tags: [react, youtube-iframe-api, twitch-embed-api, i18next, playlists, playback]

# Dependency graph
requires:
  - phase: 04-playlists (04-02)
    provides: 'usePlaylists hook family, resolvePlaylistMatches, PlaylistSelector, ?playlist= browse view'
  - phase: 04-playlists (04-03)
    provides: 'playlist membership handlers (add/reorder/remove/rename/delete), playlistMatches resolved present-only set'
provides:
  - 'useVodPlayer: onEnded / onAutoplayBlocked callbacks (SDK-constant gated) + autoplayOnConstructRef (ref-threaded, read only inside the construction effect)'
  - 'VodPlayer.tsx: forwards onEnded/onAutoplayBlocked/autoplayOnConstructRef'
  - 'VodManagerPage: handleEnded (two-branch auto-advance), autoplayNextRef (single-use), handleAutoplayBlocked + autoplayBlocked fallback hint, Prev/Next playback controls, "N of M" indicator'
affects: [04-playlists-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'ENDED/autoplay-block detection gated on live SDK constants (window.YT.PlayerState.ENDED, window.Twitch.Player.ENDED/PLAYBACK_BLOCKED) — never hardcoded literals, extending the Phase-1 READY-literal discipline'
    - 'autoplayOnConstruct is threaded as a RefObject<boolean> (not a snapshotted boolean prop) so the value is read only inside useVodPlayer'"'"'s construction effect — required by the react-hooks/refs lint rule (refs must never be read during render), mirrors the existing seekRef/getCurrentTimeRef ref-passthrough pattern already used in this file'
    - 'Two-branch playlist advance: same video identity -> reposition via the existing previousVodIdentityRef effect (no remount, no autoplay); different identity -> set autoplayNextRef then select, letting the identity-keyed remount read the flag'
    - 'autoplayNextRef is single-use: set true only inside handleEnded'"'"'s cross-identity branch, reset false by an effect keyed on selectedMatch?.id that runs AFTER the child construction effect (React'"'"'s child-before-parent effect ordering guarantees the flag is still true when useVodPlayer reads it)'

key-files:
  created: []
  modified:
    - apps/web/src/lib/useVodPlayer.ts
    - apps/web/src/lib/useVodPlayer.test.ts
    - apps/web/src/pages/VodManager/components/VodPlayer.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "Switched useVodPlayer's autoplayOnConstruct option from a plain boolean (as Task 1's action text specified) to a RefObject<boolean> mid-plan, during Task 2 — reading autoplayNextRef.current directly in VodManagerPage's JSX (to compute the boolean prop) tripped eslint-plugin-react-hooks v7's react-hooks/refs rule ('Cannot access refs during render'), which is now part of the recommended config. Threading the ref itself (read only inside useVodPlayer's construction effect) fixes this while matching RESEARCH.md Open Question 2's own literal recommendation ('read-and-reset ref.current... inside useVodPlayer's construction effect') more precisely than Task 1's simplified boolean-prop wording. All of Task 1's and Task 2's acceptance-criteria greps (which check for the substring 'autoplayOnConstruct' and the literal name 'autoplayNextRef') still pass unchanged since 'autoplayOnConstructRef' contains 'autoplayOnConstruct' as a substring."
  - "The reset-to-false for autoplayNextRef lives in VodManagerPage (an effect keyed on selectedMatch?.id), not inside useVodPlayer — relying on React's guaranteed child-before-parent effect commit order so useVodPlayer's construction effect always reads the true value before VodManagerPage's own reset effect flips it back to false. This keeps a single, explicit owner of the ref's write lifecycle in one file, per the plan's acceptance criteria naming VodManagerPage.tsx as the reset site."
  - "Prev/Next handlers (handlePrevMatch/handleNextMatch) call handleSelect directly and never touch autoplayNextRef — manual navigation (row click, Prev, Next) must never surprise-autoplay; only handleEnded's cross-identity branch is ever allowed to set the flag."

patterns-established:
  - "Ref-threading for values that must influence a child's imperative construction effect without being read during the parent's render (react-hooks/refs compliance) — reusable for any future 'consulted once at construction, set by an event handler' value."

requirements-completed: [LIST-04]

coverage:
  - id: D1
    description: "onEnded fires from window.YT.PlayerState.ENDED (via onStateChange) / window.Twitch.Player.ENDED (via addEventListener), both read off the live SDK object — never a hardcoded literal"
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts#fires onEnded when YouTube reports the ENDED player state via the live SDK constant'
        status: pass
      - kind: unit
        ref: "apps/web/src/lib/useVodPlayer.test.ts#fires onEnded/onAutoplayBlocked when Twitch fires its live ENDED/PLAYBACK_BLOCKED event names"
        status: pass
      - kind: other
        ref: 'grep -c "window.YT.PlayerState.ENDED" apps/web/src/lib/useVodPlayer.ts >= 1; grep -c "window.Twitch.Player.ENDED" apps/web/src/lib/useVodPlayer.ts >= 1'
        status: pass
    human_judgment: false
  - id: D2
    description: "onAutoplayBlocked fires from YouTube's onAutoplayBlocked event / Twitch's PLAYBACK_BLOCKED event, surfacing the autoplayBlocked fallback hint"
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts#fires onAutoplayBlocked when YouTube reports its onAutoplayBlocked event'
        status: pass
      - kind: other
        ref: 'grep -c "autoplayBlocked" apps/web/src/i18n/locales/en.json >= 1'
        status: pass
    human_judgment: true
    rationale: "Real mobile Safari autoplay-block behavior cannot be exercised in jsdom — the automated tests cover the pure event-wiring (the callback fires when the SDK event fires); actual cross-browser blocking behavior is verified in the end-of-phase human check (Plan 04-05), per the plan's own stated scope."
  - id: D3
    description: "handleEnded advances through playlistMatches: same video identity repositions (no remount, no autoplay); different identity sets autoplayNextRef then selects, remounting with autoplay requested"
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#LIST-04: auto-advances to the next playlist match via reposition (no remount) when the ENDED event fires and they share one video identity'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#LIST-04: auto-advances to the next playlist match with autoplay when the ENDED event fires and they have different video identities'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#LIST-04: ENDED is a no-op outside a playlist view (Library has no "next match")'
        status: pass
    human_judgment: false
  - id: D4
    description: "autoplayNextRef is single-use per identity change (never inherited by a later, unrelated construction) and never added to useVodPlayer's identity-keyed effect deps"
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts#does not remount the player when autoplayOnConstructRef.current changes without an identity change'
        status: pass
      - kind: other
        ref: 'grep -c "autoplayNextRef.current = false" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 1'
        status: pass
    human_judgment: false
  - id: D5
    description: "Prev/Next playback controls + 'N of M' indicator render only while a playlist is active, disable at the correct boundaries, and never set autoplayNextRef"
    requirement: 'LIST-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#LIST-04: renders Prev/Next playback controls + "N of M" while a playlist is active, and manual Next never autoplays'
        status: pass
      - kind: other
        ref: 'grep -c "vodManager.playback.position" apps/web/src/pages/VodManager/VodManagerPage.tsx >= 1'
        status: pass
    human_judgment: false
  - id: D6
    description: "Full-suite regression: shared build, web test/typecheck/lint/build, and i18n parity all pass after all three tasks"
    verification:
      - kind: unit
        ref: 'apps/web (vitest): 124 test files / 1102 tests passing'
        status: pass
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web typecheck && pnpm --filter @smash-tracker/web lint (0 errors, 40 pre-existing warnings) && pnpm --filter @smash-tracker/web build'
        status: pass
    human_judgment: false

# Metrics
duration: 55min
completed: 2026-07-13
status: complete
---

# Phase 04 Plan 04: Sequential Auto-Advance Playback Summary

**`useVodPlayer` now fires `onEnded`/`onAutoplayBlocked` from the live YouTube/Twitch SDK constants and accepts a ref-threaded `autoplayOnConstructRef`; `VodManagerPage.handleEnded` advances a playing playlist through same-video repositions and cross-video autoplay-remounts, with Prev/Next controls + an "N of M" indicator that never surprise-autoplay.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-07-13T15:38:00Z (approx.)
- **Completed:** 2026-07-13T16:33:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 11 (0 created, 11 modified)

## Accomplishments

- `useVodPlayer.ts`: `UseVodPlayerOptions.onEnded`/`.onAutoplayBlocked` (latest-value refs, updated every render, mirroring `VodPlayer.tsx`'s `seekRef`/`getCurrentTimeRef` population pattern) and `.autoplayOnConstructRef` (a threaded `RefObject<boolean>`, read exactly once per construction inside the effect body); YouTube's `onStateChange` now compares `event.data === window.YT.PlayerState.ENDED` and a new `onAutoplayBlocked` event handler is wired; Twitch gets two new `addEventListener` calls for `window.Twitch.Player.ENDED`/`PLAYBACK_BLOCKED` — both providers read every constant off the live SDK object, never a hardcoded literal
- `Window.YT`/`Window.Twitch` global type declarations extended with `PlayerState.ENDED`, `Twitch.Player.ENDED`, `Twitch.Player.PLAYBACK_BLOCKED` — all `window.YT = {...}` test mocks across the codebase (19 sites in `VodManagerPage.test.tsx`, several in `useVodPlayer.test.ts`) updated to include the now-required `PlayerState` constant
- `VodPlayer.tsx`: forwards `onEnded`/`onAutoplayBlocked`/`autoplayOnConstructRef` straight through to `useVodPlayer`
- `VodManagerPage.tsx`: `handleEnded` (two-branch advance — same identity repositions via the existing `previousVodIdentityRef` effect with no remount/autoplay; different identity sets `autoplayNextRef.current = true` then selects, letting the identity-keyed remount read the flag); `autoplayNextRef` (`useRef(false)`, single-use, reset by an effect keyed on `selectedMatch?.id` that fires after the child's construction effect per React's child-before-parent effect ordering); `handleAutoplayBlocked` + `autoplayBlocked` state (rendered as a fallback hint); `handlePrevMatch`/`handleNextMatch` (manual nav, never touch `autoplayNextRef`); Prev/Next `Button`s (lucide `SkipBack`/`SkipForward`, `variant="outline"`) + "N of M" position indicator, all gated on a playlist being active and boundary-disabled correctly
- `vodManager.playback.{position,prev,next,autoplayBlocked}` i18n keys shipped identically across all 6 locales; i18n parity test green
- 8 new/updated automated tests: SDK-constant-gated `onEnded`/`onAutoplayBlocked` wiring for both providers, the identity-keyed no-remount-on-flag-change invariant, same-identity reposition advance, cross-identity autoplay-remount advance, ENDED-is-a-no-op-outside-playlist, and Prev/Next rendering/boundary/no-autoplay behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: extend useVodPlayer with onEnded/onAutoplayBlocked/autoplayOnConstruct (SDK constants only)** - `33ebef3` (feat)
2. **Task 2: VodManagerPage handleEnded — two-branch advance + single-use autoplay ref** - `a2fd865` (feat)
3. **Task 3: Prev/Next playback controls + "N of M" indicator** - `05c85a5` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified

- `apps/web/src/lib/useVodPlayer.ts` - `onEnded`/`onAutoplayBlocked`/`autoplayOnConstructRef` options; SDK-constant ENDED + autoplay-block wiring for both providers
- `apps/web/src/lib/useVodPlayer.test.ts` - 5 new tests covering onEnded/onAutoplayBlocked wiring (both providers) and the no-remount-on-ref-change invariant
- `apps/web/src/pages/VodManager/components/VodPlayer.tsx` - forwards the three new options
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - `handleEnded`, `autoplayNextRef`, `handleAutoplayBlocked`/`autoplayBlocked`, `handlePrevMatch`/`handleNextMatch`, Prev/Next controls + "N of M" indicator
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - `listPlaylists` api mock added; 4 new LIST-04 tests; 19 existing `window.YT` mocks updated with `PlayerState`
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `vodManager.playback.*` keys

## Decisions Made

- Amended `useVodPlayer`'s `autoplayOnConstruct` option from a plain boolean (Task 1's literal action text) to a `RefObject<boolean>` mid-plan (during Task 2) — a genuine blocking discovery, not a scope choice: reading `autoplayNextRef.current` directly in `VodManagerPage`'s JSX to compute a snapshotted boolean prop tripped `eslint-plugin-react-hooks` v7's `react-hooks/refs` rule ("Cannot access refs during render"), now part of the project's recommended lint config. Threading the ref object itself and reading `.current` only inside `useVodPlayer`'s construction effect resolves this cleanly and actually matches RESEARCH.md's own Open Question 2 recommendation ("read-and-reset ref.current... inside useVodPlayer's construction effect") more precisely than Task 1's simplified wording did. All acceptance-criteria greps (checking for the substrings `autoplayOnConstruct` and `autoplayNextRef`) still pass unchanged.
- Kept the reset-to-false for `autoplayNextRef` inside `VodManagerPage` (not inside `useVodPlayer`) — a single explicit owner of the ref's write lifecycle, relying on React's guaranteed child-before-parent effect commit order so the child always reads `true` before the parent's own reset effect flips it back.
- Placed the Prev/Next control cluster + "N of M" indicator directly below the `VodPlayer` mount (grouped with the player, per CONTEXT.md), above `TimestampList` — matches the existing detail-panel top-to-bottom ordering (player, then playback aids, then notes) rather than appending it after the notes list.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Changed `autoplayOnConstruct` from a snapshotted boolean to a threaded `RefObject<boolean>`**

- **Found during:** Task 2 (lint verification, discovered while wiring `autoplayNextRef` into the `VodPlayer` mount)
- **Issue:** `pnpm --filter @smash-tracker/web lint` failed with `react-hooks/refs`: "Cannot access refs during render" at the JSX line reading `autoplayNextRef.current` to compute the `autoplayOnConstruct` prop. This rule is part of `eslint-plugin-react-hooks` v7.1.1's recommended config (already enabled in `eslint.config.js` before this plan) and was never previously triggered because no existing code read a ref's `.current` synchronously during a component's render.
- **Fix:** Reworked `UseVodPlayerOptions.autoplayOnConstruct: boolean` into `autoplayOnConstructRef?: RefObject<boolean>`, threaded unread through `VodManagerPage` -> `VodPlayer` -> `useVodPlayer` (mirroring the existing `seekRef`/`getCurrentTimeRef` ref-passthrough pattern already used in this exact file), with the `.current` read moved inside `useVodPlayer`'s construction effect (an effect read is exempt from `react-hooks/refs`). Updated Task 1's already-committed tests to pass ref-shaped objects (`{ current: true }`) instead of a plain boolean.
- **Files modified:** `apps/web/src/lib/useVodPlayer.ts`, `apps/web/src/lib/useVodPlayer.test.ts`, `apps/web/src/pages/VodManager/components/VodPlayer.tsx`
- **Verification:** `pnpm --filter @smash-tracker/web lint` — 0 errors (40 pre-existing warnings); `pnpm --filter @smash-tracker/web typecheck` — 0 errors; useVodPlayer test suite green
- **Committed in:** `a2fd865` (Task 2 commit)

**2. [Rule 3 - Blocking] Updated 19 pre-existing `window.YT` test mocks in `VodManagerPage.test.tsx` (+ 4 in `useVodPlayer.test.ts`) to include the now-required `PlayerState` constant**

- **Found during:** Task 1 (typecheck verification)
- **Issue:** Making `Window.YT.PlayerState: { ENDED: number }` a required field on the global type (matching the real IFrame API's always-present shape, and needed for grep-verifiable SDK-constant discipline) broke every existing test that constructed `window.YT = { Player: ... }` without it.
- **Fix:** Added `PlayerState: { ENDED: 0 }` to every existing mock construction — a mechanical, behavior-preserving change (the tests don't exercise ENDED, they just needed the type to satisfy).
- **Files modified:** `apps/web/src/pages/VodManager/VodManagerPage.test.tsx`, `apps/web/src/lib/useVodPlayer.test.ts`
- **Verification:** `pnpm --filter @smash-tracker/web typecheck` — 0 errors; full test suite green (1102/1102)
- **Committed in:** `33ebef3` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking issues discovered during the task's own stated verification, both resolved without changing the plan's scope or intent)
**Impact on plan:** No scope creep. Both fixes are mechanical/architectural corrections required to satisfy the project's existing lint/type configuration; LIST-04's actual behavior (SDK-constant-gated ENDED/block detection, two-branch advance, single-use autoplay flag, Prev/Next controls) landed exactly as the plan specified.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

None — no external service configuration required. No new npm packages, no env vars. Real cross-browser autoplay/mobile-Safari-block verification is explicitly deferred to the end-of-phase human check (Plan 04-05), per this plan's own stated scope.

## Next Phase Readiness

- LIST-04 (sequential auto-advance playback) is complete for the web vertical slice: a playlist plays through end-to-end, same-video matches reposition and cross-video matches autoplay-remount, manual navigation never surprise-autoplays, and a blocked autoplay reveals the fallback hint.
- The ref-threading pattern (pass the ref object itself down through a prop chain, read `.current` only inside an effect) is now established in this codebase for any future "consulted once at construction, set by an event handler" value — reusable beyond VOD Manager.
- Mobile Safari / real cross-browser autoplay-block behavior (the STATE.md-flagged risk) still needs the human check in Plan 04-05.
- No blockers. `pnpm --filter @smash-tracker/shared build && pnpm --filter @smash-tracker/web test/typecheck/lint/build` all green (1102 tests, 0 lint errors, 40 pre-existing warnings, i18n parity green).

---

_Phase: 04-playlists_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified files found on disk (`apps/web/src/lib/useVodPlayer.ts`, `apps/web/src/lib/useVodPlayer.test.ts`, `apps/web/src/pages/VodManager/components/VodPlayer.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.test.tsx`, `apps/web/src/i18n/locales/en.json`, `apps/web/src/i18n/locales/ja.json`); all three task commits (`33ebef3`, `a2fd865`, `05c85a5`) found in git log.
