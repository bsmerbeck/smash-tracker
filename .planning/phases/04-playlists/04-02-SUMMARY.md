---
phase: 04-playlists
plan: 02
subsystem: ui
tags: [react, tanstack-query, cmdk, radix, react-router, i18next, playlists]

# Dependency graph
requires:
  - phase: 04-playlists (04-01)
    provides: '/api/playlists REST routes (GET/POST/PATCH/DELETE), playlistSchema/CreatePlaylistInput/UpdatePlaylistInput, MAX_PLAYLISTS_PER_USER'
provides:
  - 'apps/web/src/lib/playlists.ts: resolvePlaylistMatches (client-side soft-orphan join), addMatchToPlaylistIds, movePlaylistItem'
  - 'api.playlists.{list,create,update,remove} client'
  - 'usePlaylists hook family (usePlaylists, useCreatePlaylist, useUpdatePlaylist, useDeletePlaylist)'
  - 'PlaylistSelector.tsx — Popover+Command combobox (Library + named playlists + inline create)'
  - '?playlist= URL-driven playlist browse view in VodManagerPage/VodMatchList'
affects: [04-playlists-03-04-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Client-side soft-orphan join: resolvePlaylistMatches maps stored matchIds against the caller''s own already-loaded matches, silently dropping unresolvable ids (T-04-05)'
    - 'Sibling URL params (?match= / ?playlist=) never merged into one setSearchParams call — both use the functional-updater form of setSearchParams to preserve the other'
    - 'PlaylistSelector reuses the TagAddCombobox Popover+Command shape but folds selection + inline-create into ONE Command list (existing rows use id as the stable cmdk value, never display name)'

key-files:
  created:
    - apps/web/src/lib/playlists.ts
    - apps/web/src/lib/playlists.test.ts
    - apps/web/src/hooks/usePlaylists.ts
    - apps/web/src/pages/VodManager/components/PlaylistSelector.tsx
  modified:
    - apps/web/src/lib/api.ts
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/components/VodMatchList.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "PlaylistSelector is a single compact Popover+Command combobox (not a row of always-visible buttons) — the plan's 'a compact control atop the list panel' plus 'Library option plus one row per playlist' both live inside the one Command list, with Library/each playlist as CommandItems (id as stable value) and the inline create row appearing once the CommandInput has trimmed text"
  - "playlistMatches resolves against vodMatches (all VOD-bearing matches the caller owns), not the locally-filtered/sorted list — filters are hidden in playlist view per the plan, so the join must be unaffected by whatever filter state was last set"
  - "Non-403 playlist-create failures are logged (console.error) rather than surfaced via a new toast copy — the plan only specified the 403-cap toast; inventing new user-facing copy would have required new i18n keys outside the task's stated scope"

patterns-established:
  - "Second sibling-URL-param pattern (after ?match=) using the setSearchParams functional-updater form to avoid one selection wiping the other"

requirements-completed: [LIST-01, LIST-03]

coverage:
  - id: D1
    description: "resolvePlaylistMatches resolves matchIds to Match[] in playlist order and silently skips ids with no resolvable match (soft-orphan)"
    requirement: 'LIST-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#resolvePlaylistMatches resolves matchIds to Match objects in playlist order'
        status: pass
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#resolvePlaylistMatches silently skips an id with no resolvable match (soft-orphan)'
        status: pass
    human_judgment: false
  - id: D2
    description: "addMatchToPlaylistIds is an idempotent, non-mutating append"
    requirement: 'LIST-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#addMatchToPlaylistIds is idempotent — skips an id already present'
        status: pass
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#addMatchToPlaylistIds never mutates the input array'
        status: pass
    human_judgment: false
  - id: D3
    description: "movePlaylistItem is an immutable adjacent swap with a no-op at either boundary"
    requirement: 'LIST-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#movePlaylistItem swaps an item up one slot'
        status: pass
      - kind: unit
        ref: 'apps/web/src/lib/playlists.test.ts#movePlaylistItem is a no-op moving the first item up (top boundary)'
        status: pass
    human_judgment: false
  - id: D4
    description: "PlaylistSelector renders Library + named playlists as a Popover+Command combobox with an inline create row, all copy translated"
    requirement: 'LIST-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
      - kind: other
        ref: 'grep -c "shouldFilter={false}" apps/web/src/pages/VodManager/components/PlaylistSelector.tsx >= 1'
        status: pass
    human_judgment: true
    rationale: "Visual selection-token rendering (D-13 active-row styling, popover open/close, cmdk keyboard navigation) is not exercised by an automated test in this plan — needs a human look at the running page."
  - id: D5
    description: "Selecting a playlist swaps the list panel to that playlist's matches in playlist order via ?playlist=, independent of ?match=; Library restores the normal filtered list; filters are hidden in playlist view; an empty playlist shows the empty-state copy"
    requirement: 'LIST-03'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx (19 pre-existing tests, all still passing after the ?playlist= sibling-param + displayedMatches rewire)'
        status: pass
      - kind: other
        ref: 'grep -c "searchParams.get(\'playlist\')" apps/web/src/pages/VodManager/VodManagerPage.tsx == 1'
        status: pass
    human_judgment: true
    rationale: "No new automated test exercises the playlist-selected browse path end-to-end (creating a playlist, selecting it, seeing its matches, seeing the empty-state copy) — this plan's task 3 verification was existing-suite-must-still-pass + typecheck, not new integration tests for the playlist view itself."

# Metrics
duration: 45min
completed: 2026-07-13
status: complete
---

# Phase 04 Plan 02: Playlists Web Vertical Slice (Create + Browse) Summary

**`usePlaylists` hook family + `api.playlists` client + client-side soft-orphan join helper, the `PlaylistSelector` Popover+Command combobox (Library + named playlists + inline create), and a `?playlist=` URL-driven playlist browse view wired into `VodManagerPage`/`VodMatchList` — a player can create a named playlist and browse it as an ordered collection the moment the Plan 04-01 backend is deployed.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-07-13T14:12:00Z (approx.)
- **Completed:** 2026-07-13T14:56:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 13 (4 created, 9 modified)

## Accomplishments

- `apps/web/src/lib/playlists.ts`: `resolvePlaylistMatches` (client-side soft-orphan join per T-04-05), `addMatchToPlaylistIds` (idempotent), `movePlaylistItem` (immutable adjacent swap, boundary no-op) — 13 passing unit tests
- `api.playlists.{list,create,update,remove}` added to `apps/web/src/lib/api.ts`, mirroring the `gspReadings` client shape
- `usePlaylists`/`useCreatePlaylist`/`useUpdatePlaylist`/`useDeletePlaylist` in `apps/web/src/hooks/usePlaylists.ts` — `useUpdatePlaylist` serves both rename and reorder via `{ id, input }`
- `PlaylistSelector.tsx`: a Popover+Command combobox mirroring `TagAddCombobox`'s shape — Library + one `CommandItem` per playlist (playlist `id` as the stable cmdk value, never the display name), D-13 selection tokens on the active row, and an inline "+ New playlist" create row gated on a trimmed 1-40 char name
- `vodManager.playlists.*` i18n keys (`library`, `newPlaylist`, `createPlaceholder`, `create`, `selectAria`, `empty`, `limitReached`, `matchCount_one`/`matchCount_other`) shipped identically across all 6 locales; i18n parity test green
- `VodManagerPage.tsx`: `?playlist=` read as a sibling param to `?match=` (both via the `setSearchParams` functional-updater form so neither selection clobbers the other); `playlistMatches` resolved via `resolvePlaylistMatches(selectedPlaylist, vodMatches)`; `displayedMatches = playlistMatches ?? filtered` drives both the rendered list and the cold-open auto-select effect; `handleCreatePlaylist` surfaces the 403-cap failure as a `vodManager.playlists.limitReached` toast
- `VodMatchList.tsx`: new `isPlaylistView` prop hides the filter/sort controls while a playlist is active and renders the `vodManager.playlists.empty` copy for an empty resolved list instead of blank rows

## Task Commits

Each task was committed atomically (TDD RED → GREEN for Task 1):

1. **Task 1 (RED): failing test for playlists lib helpers** - `922e036` (test)
1. **Task 1 (GREEN): usePlaylists hook + api.playlists client + soft-orphan join helper** - `204e410` (feat)
1. **Task 2: PlaylistSelector combobox (Library + named playlists + inline create)** - `17be7fe` (feat)
1. **Task 3: wire playlist selection into VodManagerPage + VodMatchList** - `21e41ed` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified

- `apps/web/src/lib/playlists.ts` - `resolvePlaylistMatches`/`addMatchToPlaylistIds`/`movePlaylistItem`
- `apps/web/src/lib/playlists.test.ts` - unit coverage for all three helpers, incl. soft-orphan + idempotent-append cases
- `apps/web/src/hooks/usePlaylists.ts` - `playlistsQueryKey` + hook family
- `apps/web/src/lib/api.ts` - `api.playlists.{list,create,update,remove}`
- `apps/web/src/pages/VodManager/components/PlaylistSelector.tsx` - Library + playlists combobox + inline create
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - `?playlist=` state, `playlistMatches`/`displayedMatches`, `handleSelectPlaylist`/`handleCreatePlaylist`, `PlaylistSelector` mount
- `apps/web/src/pages/VodManager/components/VodMatchList.tsx` - `isPlaylistView` prop: hides filters, renders playlist empty-state copy
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `vodManager.playlists.*` keys (incl. plural `matchCount_one`/`matchCount_other`)

## Decisions Made

- Built `PlaylistSelector` as a single Popover+Command combobox rather than an always-visible row of buttons — the plan's "compact control" language and its instruction to reuse the `TagAddCombobox` Popover+Command shape for the whole thing (not just the create row) both point to one unified control; Library and each playlist are `CommandItem`s inside the same `Command`, with the playlist `id` (never the name) as the stable cmdk `value`.
- `resolvePlaylistMatches` joins against `vodMatches` (every VOD-bearing match the signed-in caller owns) rather than the locally-filtered/sorted `filtered` list, since filters are hidden in playlist view per the plan — the playlist's own stored order must not depend on whatever filter/sort state happened to be active before the playlist was selected.
- Generalized the cold-open auto-select effect and the `selectedMatch` lookup to key off `displayedMatches` (`playlistMatches ?? filtered`) instead of only `filtered`, so a deep-link that lands on a playlist view (`?playlist=<id>` with no `?match=`) still auto-selects that playlist's first match rather than falling back to Library's first match — a small correctness extension beyond the plan's literal wording, not a new feature.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused `createPlaylistInputSchema`/`updatePlaylistInputSchema` imports from `api.ts`**

- **Found during:** Task 3 (lint verification)
- **Issue:** Task 1's `api.playlists` implementation mirrors `api.gspReadings`, which passes typed input straight through without a client-side `.parse()` call. I had imported `createPlaylistInputSchema`/`updatePlaylistInputSchema` speculatively; ESLint's `no-unused-vars` flagged both as errors, failing `pnpm lint`.
- **Fix:** Removed the two unused imports; `api.playlists.create`/`update` continue to type-check against `CreatePlaylistInput`/`UpdatePlaylistInput` (the inferred types), matching the `gspReadings` pattern exactly.
- **Files modified:** `apps/web/src/lib/api.ts`
- **Verification:** `pnpm --filter @smash-tracker/web lint` — 0 errors (40 pre-existing warnings, unrelated)
- **Committed in:** `21e41ed` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — unused imports failing lint)
**Impact on plan:** No scope creep — a lint-only fix within the same file Task 1 already touched.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. No new npm packages, no env vars.

## Next Phase Readiness

- `usePlaylists`/`useCreatePlaylist`/`useUpdatePlaylist`/`useDeletePlaylist` and `resolvePlaylistMatches`/`addMatchToPlaylistIds`/`movePlaylistItem` are all in place for the next plan (adding/removing/reordering matches within a playlist, and playback auto-advance).
- `PlaylistSelector`'s `id`-as-cmdk-value convention and the `?playlist=`/`?match=` sibling-param pattern (functional-updater `setSearchParams`) should be reused by any further playlist-view work rather than re-derived.
- No blockers. `pnpm --filter @smash-tracker/shared build && pnpm --filter @smash-tracker/web test/typecheck/lint/build` all green.

---

_Phase: 04-playlists_
_Completed: 2026-07-13_

## Self-Check: PASSED

All created/modified files found on disk (`apps/web/src/lib/playlists.ts`, `apps/web/src/lib/playlists.test.ts`, `apps/web/src/hooks/usePlaylists.ts`, `apps/web/src/pages/VodManager/components/PlaylistSelector.tsx`, `apps/web/src/pages/VodManager/VodManagerPage.tsx`, `apps/web/src/pages/VodManager/components/VodMatchList.tsx`, `apps/web/src/lib/api.ts`); all four task commits (`922e036`, `204e410`, `17be7fe`, `21e41ed`) found in git log.
