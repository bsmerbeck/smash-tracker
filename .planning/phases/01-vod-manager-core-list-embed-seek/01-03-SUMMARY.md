---
phase: 01-vod-manager-core-list-embed-seek
plan: 03
subsystem: ui
tags: [react, youtube-iframe-api, twitch-embed-api, vitest, tdd, csp]

requires:
  - phase: 01-vod-manager-core-list-embed-seek
    provides: 'detectVodProvider (01-01) + VodManagerPage master-detail shell (01-02)'
provides:
  - 'useVodPlayer hook: singleton YouTube/Twitch API loaders + ready-gated seek control'
  - 'VodPlayer component: embedded, seekable YouTube/Twitch player with loading/error/unsupported-host states'
  - 'TimestampList component: click-to-seek + selected-note highlight'
  - 'VodManagerPage detail panel wired to the real player + timestamp list'
affects: [01-04-vod-affordance-consolidation]

tech-stack:
  added: []
  patterns:
    - 'Hand-rolled YT.Player/Twitch.Player wrappers behind one { containerRef, isReady, error, seek } hook contract, per STACK.md — zero new npm dependencies'
    - 'Module-level singleton promise for vendor script injection (loadYouTubeApi/loadTwitchApi), shared across all player instances on the page'
    - 'Player-construction effect keyed on video IDENTITY (provider+videoId), not on vodUrl/startSeconds/the whole match object, to avoid remounting on unrelated state changes'
    - "React's render-phase 'adjusting state when a prop changes' pattern (compare-and-reset during render) instead of a reset-only useEffect, required by this repo's react-hooks/set-state-in-effect lint rule"

key-files:
  created:
    - apps/web/src/lib/useVodPlayer.ts
    - apps/web/src/lib/useVodPlayer.test.ts
    - apps/web/src/pages/VodManager/components/VodPlayer.tsx
    - apps/web/src/pages/VodManager/components/TimestampList.tsx
  modified:
    - apps/web/src/pages/VodManager/VodManagerPage.tsx

key-decisions:
  - "Added width: '100%'/height: '100%' to both the YT.Player and Twitch.Player constructor configs (not explicit in the plan's action text) so the embed fills VodPlayer's aspect-video container instead of each vendor API's fixed pixel default (640x390 / 400x300) — Rule 2, required for the UI-SPEC Player Component Visual Contract to actually hold visually"
  - 'Reset logic for both useVodPlayer\'s ready/error state on identity change and VodManagerPage\'s selectedTimestampIndex on match change use the React "adjust state during render" pattern (compare tracked-vs-current key, setState conditionally in the render body) instead of a reset-only useEffect — this repo\'s eslint-plugin-react-hooks ships the newer react-hooks/set-state-in-effect rule, which errors on unconditional setState calls as the first statement in an effect body'

patterns-established:
  - 'Vendor script singleton loaders return the SAME in-flight/resolved promise to all callers, guarding against double-injecting either the YouTube iframe_api or Twitch embed/v1.js script regardless of how many players are constructed on the page'

requirements-completed: [PLAY-01, PLAY-02, PLAY-03]

coverage:
  - id: D1
    description: 'useVodPlayer routes to the correct vendor API based on detectVodProvider, loads each vendor script at most once, gates seek() behind ready state, derives Twitch parent from window.location.hostname at runtime, and sets an unavailable error state on YouTube onError codes {2,5,100,101,150}'
    requirement: 'PLAY-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/useVodPlayer.test.ts (6 cases: YT construction+ready-gated seek, Twitch construction+dynamic parent+ready-gated seek, unsupported-host no-player, YouTube onError->unavailable, loadYouTubeApi single-injection, loadTwitchApi single-injection)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'VodPlayer renders a bordered aspect-video embed with loading (bg-muted animate-pulse), dead-VOD error (vodManager.playerUnavailable, replaces player not overlay), and unsupported-host (Open on {host} link) states; TimestampList rows call onSeek (never a URL-navigation fallback) and apply the locked D-13 selected-row tokens; VodManagerPage wires both into the detail panel with selectedTimestampIndex reset on match change'
    requirement: 'PLAY-02'
    verification:
      - kind: unit
        ref: 'pnpm --filter @smash-tracker/web build + typecheck + acceptance-criteria greps (aspect-video, bg-muted, playerUnavailable, onSeek(, absence of vodDeepLink in TimestampList.tsx, bg-accent text-accent-foreground, border-l-2 border-primary, shared.vod.noTimestamps, setSelectedTimestampIndex(null) on selectedMatchId change, vodUrl-only prop to VodPlayer)'
        status: pass
    human_judgment: false
  - id: D3
    description: 'YouTube and Twitch VODs both embed, play, and seek in-page on the REAL deploy target with no CSP/Twitch-parent console errors; dead-VOD, unsupported-host, and mobile aspect-ratio states verified visually'
    requirement: 'PLAY-03'
    verification: []
    human_judgment: true
    rationale: "Pitfall 4 (STACK.md/PITFALLS.md/STATE.md blocker): CSP and Twitch's separate parent-domain allowlist behavior on Firebase Hosting preview channels / Cloud Run is explicitly unverified in vendor docs and CANNOT be proven by unit tests or localhost alone — this plan's Task 4 is a blocking checkpoint:human-verify gate requiring deployment to the real target before sign-off. Not attempted by this executor per its instructions; deferred to the orchestrator/human."

# Metrics
duration: 11min
completed: 2026-07-10
status: complete
---

# Phase 01 Plan 03: VOD Player Embed + Click-to-Seek Summary

**useVodPlayer hook (hand-rolled YT.Player/Twitch.Player wrappers, zero new deps) + VodPlayer/TimestampList components wired into VodManagerPage's detail panel — YouTube/Twitch VODs embed and play in-page, and clicking a timestamp note seeks the live player and highlights the note**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-10T09:34:17-04:00
- **Completed:** 2026-07-10T09:45:17-04:00
- **Tasks:** 3 completed (Task 4 is a blocking human-verify checkpoint — not attempted, see below)
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `useVodPlayer` hook: singleton `loadYouTubeApi()`/`loadTwitchApi()` script loaders (each vendor script injected at most once per page, shared in-flight/resolved promise across concurrent callers) plus a `{ containerRef, isReady, error, seek }` control contract wrapping `YT.Player`/`Twitch.Player`
- Player-construction effect keyed on video IDENTITY (`${provider}:${videoId}`) — switching between matches with different videos rebuilds the player, but any unrelated re-render never remounts an in-progress playback
- `seek()` early-returns until the platform player fires ready (YouTube `onReady`, Twitch `Twitch.Player.READY`); YouTube path calls `seekTo(seconds, true)` + `playVideo()`, Twitch path calls `seek(seconds)` (commented as VOD-only, not for live streams)
- Twitch `parent` derived from `window.location.hostname` at runtime (Pitfall 4) — never a hardcoded domain
- YouTube `onError` codes `{2,5,100,101,150}` set an `unavailable` error state (Pitfall 3); non-YouTube/Twitch hosts set an `unsupported` state and construct no player (iframe-injection guard, T-01-07)
- `VodPlayer` component: bordered `aspect-video` box with `bg-muted animate-pulse` loading fill, an inline `vodManager.playerUnavailable` message on dead-VOD error (replaces the player entirely so layout doesn't jump), and a plain "Open on {host}" fallback link for unsupported hosts
- `TimestampList` component: read-only click-to-seek rows (adapted from `VodNotesDialog`, add/delete removed) — clicking a row calls `onSeek` (the live player, never a `vodDeepLink` URL reload) and highlights the clicked row with the locked D-13 tokens (`bg-accent text-accent-foreground border-l-2 border-primary`)
- `VodManagerPage`'s right panel now renders `VodPlayer` + `TimestampList` directly below it (D-03) for the selected match, keeping the plan-01-02 placeholder as the no-selection fallback, list panel, filters, cold-open, and empty state all unchanged

## Task Commits

Each task was committed atomically (Task 1 followed the TDD RED/GREEN cycle):

1. **Task 1a (RED): useVodPlayer failing test** - `fcc39bb` (test)
2. **Task 1b (GREEN): useVodPlayer implementation** - `a82bea8` (feat)
3. **Task 2: VodPlayer + TimestampList components** - `a3092ca` (feat)
4. **Task 3: Wire into VodManagerPage detail panel** - `fce2f44` (feat)

**Plan metadata commit:** pending (this SUMMARY.md commit, made after this document is written).

_Note: Task 1 was TDD (test → feat); no refactor commit was needed — the GREEN implementation passed cleanly, and the only follow-up change (adding `width`/`height: '100%'` to both player constructors) was folded into the Task 2 commit since it's needed for Task 2's visual contract, not a standalone refactor._

## Files Created/Modified

- `apps/web/src/lib/useVodPlayer.ts` - `loadYouTubeApi`, `loadTwitchApi` singleton script loaders; `useVodPlayer({ vodUrl, startSeconds })` hook returning `{ containerRef, isReady, error, seek }`; `window.YT`/`window.onYouTubeIframeAPIReady`/`window.Twitch` global type augmentations
- `apps/web/src/lib/useVodPlayer.test.ts` - 6 test cases: YouTube construction + ready-gated seek, Twitch construction + dynamic parent + ready-gated seek, unsupported-host (no player constructed), YouTube onError → unavailable, YouTube/Twitch single-script-injection
- `apps/web/src/pages/VodManager/components/VodPlayer.tsx` - `VodPlayer({ vodUrl, startSeconds, onReady, seekRef })`: loading/error/unsupported-host visual states over `useVodPlayer`, exposes `seek` upward via `seekRef`
- `apps/web/src/pages/VodManager/components/TimestampList.tsx` - `TimestampList({ timestamps, selectedIndex, onSelect, onSeek })`: click-to-seek rows with selected-note highlight and the existing empty-state copy
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - Right panel composes `VodPlayer` + `TimestampList` + the existing read-only metadata card; `selectedTimestampIndex` state (reset on match change); `playerSeekRef` bridges `TimestampList.onSeek` to the live player

## Decisions Made

- Added `width: '100%'`/`height: '100%'` to both the `YT.Player` and `Twitch.Player` constructor configs — not explicit in the plan's action text, but required so the embed fills `VodPlayer`'s `aspect-video` box instead of each vendor API's fixed pixel default (YouTube 640x390, Twitch 400x300 minimum). Documented as a Rule 2 addition below.
- Both `useVodPlayer`'s ready/error reset on video-identity change and `VodManagerPage`'s `selectedTimestampIndex` reset on match change use React's "adjusting state when a prop changes" render-phase pattern (compare a tracked key to the current value, `setState` conditionally in the render body) rather than a reset-only `useEffect`. This repo's `eslint-plugin-react-hooks` enforces `react-hooks/set-state-in-effect`, which errors on an effect whose first synchronous statement is an unconditional `setState` call — the render-phase pattern is the React-endorsed alternative and produces identical behavior (state resets exactly when the identity/match-id changes) without the lint violation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Sized the embedded player to fill its aspect-video container**

- **Found during:** Task 2 (`VodPlayer.tsx` implementation)
- **Issue:** The plan's Task 1 action text specifies the `YT.Player`/`Twitch.Player` constructor configs without `width`/`height`. Left as-is, both vendor APIs default to a fixed pixel size (YouTube 640x390, Twitch 400x300 minimum) that would not fill `VodPlayer`'s `aspect-video` box, breaking the UI-SPEC's Player Component Visual Contract (a locked design requirement for this phase).
- **Fix:** Added `width: '100%', height: '100%'` to both constructor configs in `useVodPlayer.ts`.
- **Files modified:** `apps/web/src/lib/useVodPlayer.ts`
- **Verification:** `pnpm --filter @smash-tracker/web build` + `typecheck` clean; `useVodPlayer.test.ts` (6/6) unaffected — tests assert on `videoId`/`video`/`parent`, not on width/height.
- **Committed in:** `a3092ca` (Task 2 commit, since it's needed for Task 2's visual contract to hold)

**2. [Rule 1 - Bug] Fixed `react-hooks/set-state-in-effect` lint errors from the plan's literal reset-in-effect wording**

- **Found during:** Task 1 (`useVodPlayer.ts`) and Task 3 (`VodManagerPage.tsx`)
- **Issue:** Both the plan's Task 1 action text ("Re-create the player... Clean up... on identity change") and Task 3's action text ("RESET it to null when `selectedMatchId` changes") describe the reset as effect-driven behavior. A literal `useEffect(() => { setIsReady(false); setError(null); ... })` / `useEffect(() => { setSelectedTimestampIndex(null); }, [selectedMatchId])` implementation triggers this repo's `eslint-plugin-react-hooks` `react-hooks/set-state-in-effect` rule (errors on an unconditional `setState` as the first statement in an effect body).
- **Fix:** Replaced both resets with React's "adjusting state when a prop changes" render-phase pattern (track the previous identity/match-id in state, compare during render, `setState` conditionally) — behaviorally identical (state resets exactly when the key changes) with zero lint violations.
- **Files modified:** `apps/web/src/lib/useVodPlayer.ts`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`
- **Verification:** `npx eslint` clean on all four touched/created files; `useVodPlayer.test.ts` (6/6) and the full web suite (997/997) still pass; acceptance-criteria grep for `setSelectedTimestampIndex(null)` tied to a `selectedMatchId` comparison still present.
- **Committed in:** `a82bea8` (Task 1 commit), `fce2f44` (Task 3 commit) — caught before each commit, no separate fix-up commit needed.

**3. [Rule 1 - Bug] Fixed test mock constructors — arrow functions cannot be used with `new`**

- **Found during:** Task 1 GREEN verification
- **Issue:** The initial `useVodPlayer.test.ts` mocked `window.YT.Player`/`window.Twitch.Player` with `vi.fn((el, config) => ...)` using arrow-function implementations. Since `useVodPlayer.ts` constructs players via `new window.YT.Player(...)`/`new window.Twitch.Player(...)`, and arrow functions have no `[[Construct]]` internal slot, this threw `TypeError: ... is not a constructor` at runtime.
- **Fix:** Changed the three affected mock implementations to `function` expressions (which support `new`).
- **Files modified:** `apps/web/src/lib/useVodPlayer.test.ts`
- **Verification:** `useVodPlayer.test.ts` 6/6 passing after the fix.
- **Committed in:** `fcc39bb` (Task 1 RED commit — fixed before the GREEN commit, so the RED commit already reflects the corrected mock style; only the implementation was genuinely RED→GREEN)

---

**Total deviations:** 3 auto-fixed (1 missing-critical visual sizing, 1 lint-rule-driven pattern substitution across two files, 1 test-authoring bug)
**Impact on plan:** All three are required for correctness (visual contract, lint-clean code, working tests) with zero scope creep — no behavior described in the plan changed, only _how_ two of its literal effect-based descriptions were implemented to satisfy this repo's lint config, and one test-authoring fix.

## Issues Encountered

`@smash-tracker/shared` had no `dist/` output at the start of this plan (same pre-existing environment issue noted in plans 01-01/01-02 — not caused by this plan's changes). Ran `pnpm --filter @smash-tracker/shared build` once at the start of the session, which unblocked `pnpm --filter @smash-tracker/web test`. Build output only, not committed (`packages/shared/dist` is gitignored).

## User Setup Required

None - no external service configuration required for Tasks 1-3. Task 4 (the blocking human-verify checkpoint) requires a deployed preview/production target — see "Next Phase Readiness" below.

## Next Phase Readiness

- Tasks 1-3 are complete, committed, and verified: `pnpm --filter @smash-tracker/web test -- src/lib/useVodPlayer.test.ts` (6/6), `pnpm --filter @smash-tracker/web test` (997/997, no regressions), `pnpm --filter @smash-tracker/web build` succeeds, `pnpm --filter @smash-tracker/web typecheck` clean, `npx eslint` clean on all touched/created files.
- **Task 4 (blocking checkpoint) was intentionally NOT attempted by this executor** — it requires deploying this branch to a Firebase Hosting preview channel / Cloud Run target and manually confirming YouTube + Twitch embed/play/seek with no CSP/Twitch-parent console errors, plus the dead-VOD, unsupported-host, and mobile aspect-ratio states. This is the Pitfall 4 empirical-verification gate already flagged in STACK.md/PITFALLS.md/STATE.md's blockers — it cannot be proven by automated tests or localhost alone. See the plan's Task 4 `<how-to-verify>` for the exact 8-step manual procedure.
- Once Task 4 is approved, this plan's `<success_criteria>` (PLAY-01/02/03 + graceful degradation + CSP/parent verified on the real deploy target) are fully met.
- No blockers for plan 01-04 (VOD affordance consolidation) — it can proceed independently of Task 4's deploy-target verification.

---

_Phase: 01-vod-manager-core-list-embed-seek_
_Completed: 2026-07-10_

## Self-Check: PASSED

All created/modified files verified present on disk (`apps/web/src/lib/useVodPlayer.ts`, `apps/web/src/lib/useVodPlayer.test.ts`, `apps/web/src/pages/VodManager/components/VodPlayer.tsx`, `apps/web/src/pages/VodManager/components/TimestampList.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`); all four task commits (`fcc39bb`, `a82bea8`, `a3092ca`, `fce2f44`) verified present in `git log --oneline`.
