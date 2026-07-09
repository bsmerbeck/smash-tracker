---
phase: 01-vod-manager-core-list-embed-seek
plan: 02
subsystem: ui
tags: [react, react-router, i18n, shadcn, vitest, tdd]

requires:
  - phase: null
    provides: null
provides:
  - '/vod route + VodManagerPage master-detail shell'
  - 'vodManagerFilters.ts filter/sort composition utility'
  - 'vodManager.* + nav.vodManager i18n keys across all 6 locales'
affects: [01-03-vod-player-embed-seek, 01-04-vod-affordance-consolidation]

tech-stack:
  added: []
  patterns:
    - 'Pure filter/sort composition over an existing filter utility (vodManagerFilters.ts delegates to matchTableFilters.ts) rather than reimplementing predicates'
    - 'URL (?match=) as single source of truth for master-detail selection, with a cold-open replace-navigation auto-select effect'

key-files:
  created:
    - apps/web/src/pages/VodManager/lib/vodManagerFilters.ts
    - apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/components/VodMatchList.tsx
  modified:
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json
    - apps/web/src/layouts/nav.ts
    - apps/web/src/routes/AppRouter.tsx

key-decisions:
  - "vodManagerFilters.ts intentionally omits matchType (D-08: only recency is a sort toggle in Phase 1; character/opponent/tournament/stage are filter-only, and matchType isn't one of those four dimensions)"
  - 'Right-panel placeholder shows read-only match metadata (opponent, fighters, stage, tournament, result) below an aspect-video bg-muted box — the exact seam plan 01-03 will replace with the real player + timestamp list'

requirements-completed: [LIB-01, LIB-02]

coverage:
  - id: D1
    description: 'vodManagerFilters.ts composes matchTableFilters + adds opponent-name filter + recency sort, fully unit tested'
    requirement: 'LIB-02'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts'
        status: pass
    human_judgment: false
  - id: D2
    description: 'vodManager.* + nav.vodManager i18n keys present and valid across all 6 locales; nav item + lazy /vod route registered'
    requirement: 'LIB-01'
    verification:
      - kind: other
        ref: 'node -e i18n key-presence check across en/es/fr/de/pt/ja (see plan verify block)'
        status: pass
    human_judgment: false
  - id: D3
    description: 'VodManagerPage lists only VOD-having matches via useFilteredMatches -> vodUrl filter, filterable/sortable via VodMatchList, URL-driven selection (?match=), D-04 cold-open auto-select, D-12 empty state'
    requirement: 'LIB-01'
    verification:
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web build (lazy chunk emitted) + pnpm --filter @smash-tracker/web typecheck + acceptance-criteria greps (useFilteredMatches, vodUrl != null, replace: true, setSearchParams, md:grid-cols-[360px_1fr], aspect-video, bg-accent text-accent-foreground, ALL_FILTER_VALUE)'
        status: pass
    human_judgment: true
    rationale: "Manual navigation/deep-link/filter-toggle verification (per plan's <verification> block) requires visually confirming the split-view layout, filter narrowing, and deep-link preselection in a running app — not fully provable by static grep/build/typecheck alone."

duration: 10min
completed: 2026-07-09
status: complete
---

# Phase 1 Plan 02: VOD Manager Page Shell Summary

**VOD Manager master-detail page shell (`/vod`) with URL-driven selection, a filter/sort composition utility over `matchTableFilters`, and every `vodManager.*` i18n key shipped across all 6 locales — the right panel is a defined `aspect-video` seam for plan 01-03's real player.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-09T22:26:09Z
- **Completed:** 2026-07-09T22:36:21Z
- **Tasks:** 3
- **Files modified:** 12 (4 created, 8 modified)

## Accomplishments

- `vodManagerFilters.ts`: pure composition over `matchTableFilters.ts` (fighter/opponentFighter/stage/tournament delegated verbatim) plus a new opponent-name filter and `sortByRecency` (newest/oldest) — 100% TDD (RED test commit, then GREEN implementation commit), all 8 test cases passing
- Every `vodManager.*` + `nav.vodManager` i18n key shipped across all 6 locales (en/es/fr/de/pt/ja), verified via the plan's node key-presence check
- Sidebar "VODs" nav item + lazy `/vod` route (mirrors the `MatchDataPage` lazy-import/`ProtectedRoute` pattern exactly)
- `VodManagerPage`: master-detail shell — list sourced through `useFilteredMatches()` (the alias-canonicalization choke point) filtered to `vodUrl != null`, URL (`?match=`) as the single source of truth for selection, D-04 cold-open auto-select via `setSearchParams(..., { replace: true })`, D-12 minimal "No VODs yet" empty state, `md:grid-cols-[360px_1fr]` split layout
- `VodMatchList`: one Select/combobox control per filter dimension (D-06 — Select for fighter/opponent's character/stage, searchable Command+Popover combobox for opponent/tournament given higher cardinality), newest/oldest sort toggle, selected-row `bg-accent text-accent-foreground` highlight, has-VOD `border-primary text-primary` row accent, deep-link auto-scroll-into-view

## Task Commits

Each task was committed atomically (Task 1 followed the TDD RED/GREEN cycle):

1. **Task 1a (RED): vodManagerFilters failing test** - `a7f6a9f` (test)
2. **Task 1b (GREEN): vodManagerFilters implementation** - `4e5acf5` (feat)
3. **Task 2: i18n keys (6 locales) + nav entry + lazy /vod route** - `a46263e` (feat)
4. **Task 3: VodManagerPage shell + VodMatchList** - `45d5dba` (feat)
5. **Follow-up cleanup: Match type for SelectedMatchMeta prop** - `7821540` (refactor)

**Plan metadata:** commit skipped — `commit_docs: false` in `.planning/config.json` and `.planning/` is gitignored in this repo (see Self-Check below).

## Files Created/Modified

- `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts` - `VodManagerFilterState`, `DEFAULT_VOD_MANAGER_FILTERS`, `getVodManagerFilterOptions`, `applyVodManagerFilters`, `VodSortDirection`, `sortByRecency`
- `apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts` - 8 test cases covering defaults, opponent filter, delegation/composition, recency sort (both directions + non-mutation), filter option derivation
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - master-detail page shell, URL-driven selection, cold-open auto-select, empty state, read-only match metadata card
- `apps/web/src/pages/VodManager/components/VodMatchList.tsx` - filter/sort controls + selectable match row list
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `vodManager.*` + `nav.vodManager` keys
- `apps/web/src/layouts/nav.ts` - `Video` icon import, new nav entry (`href: '/vod'`)
- `apps/web/src/routes/AppRouter.tsx` - lazy `VodManagerPage` import + `/vod` `ProtectedRoute` route

## Decisions Made

- `matchType` deliberately excluded from `VodManagerFilterState` (per plan spec / D-08) — only fighter/opponentFighter/stage/tournament/opponent are filter dimensions; recency is the sole sort toggle.
- Match row secondary line shows opponent name, tournament label (via `tournamentLabel()`), and date together for scannability — not specified verbatim in the plan but consistent with the UI-SPEC's "playlist-like" list panel intent.
- `SelectedMatchMeta` typed its prop as `Match` directly (cleaner than an initial `ReturnType<typeof useFilteredMatches>` construct) — a same-task readability fix, not a scope change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Built `@smash-tracker/shared` before running web tests**

- **Found during:** Task 1 (GREEN verification)
- **Issue:** `@smash-tracker/shared` had no `dist/` output; every test importing from `@smash-tracker/shared` failed to resolve the module (pre-existing workspace state, not caused by this plan's changes)
- **Fix:** Ran `pnpm --filter @smash-tracker/shared build` once, which unblocked the entire web test suite (982 tests passed afterward, including the 68 previously-failing files)
- **Files modified:** none (build output only, not committed — `packages/shared/dist` is gitignored build output)
- **Verification:** `pnpm --filter @smash-tracker/web test` — 119/119 test files, 982/982 tests passing
- **Committed in:** N/A (no source change; environment/build-state fix only)

**2. [Rule 1 - Bug] Fixed two lint errors surfaced after Task 3**

- **Found during:** Task 3 post-build lint pass
- **Issue:** `MatchTableFilterState` imported-but-unused in `vodManagerFilters.ts` (leftover from an earlier draft re-export); unnecessary `eslint-disable-next-line react-hooks/exhaustive-deps` comment in `VodMatchList.tsx`'s scroll-into-view effect
- **Fix:** Removed the unused type import; removed the disable comment (the effect's dependency array was already correct, the directive was reported as unused by the linter)
- **Files modified:** `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts`, `apps/web/src/pages/VodManager/components/VodMatchList.tsx`
- **Verification:** `npx eslint src/pages/VodManager/` clean; typecheck and build re-verified green afterward
- **Committed in:** `45d5dba` (Task 3 commit, same commit — caught before commit)

---

**Total deviations:** 2 auto-fixed (1 blocking/environment, 1 bug/lint-cleanliness)
**Impact on plan:** Neither affected plan scope or acceptance criteria. No scope creep.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Self-Check

Verified the following before finalizing:

- `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts` — FOUND
- `apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts` — FOUND
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` — FOUND
- `apps/web/src/pages/VodManager/components/VodMatchList.tsx` — FOUND
- Commit `a7f6a9f` (RED test) — FOUND in `git log --oneline --all`
- Commit `4e5acf5` (GREEN implementation) — FOUND
- Commit `a46263e` (i18n/nav/route) — FOUND
- Commit `45d5dba` (page shell + list) — FOUND
- Commit `7821540` (cleanup refactor) — FOUND
- `pnpm --filter @smash-tracker/web build` — succeeds, `VodManagerPage-*.js` lazy chunk emitted
- `pnpm --filter @smash-tracker/web typecheck` — clean
- `pnpm --filter @smash-tracker/web test` — 982/982 passing

**Note on plan metadata commit:** This repo has `.planning/` gitignored (see `chore: untrack .planning/` at `e5ddda7`) and `.planning/config.json` sets `commit_docs: false`. Per the executor's `<final_commit>` contract, this SUMMARY.md is written to disk as the canonical output but is intentionally NOT force-added to git — the orchestrator/user has already opted out of committing `.planning/` artifacts. All five source-code task commits above are on the worktree branch and are the actual deliverable.

## Next Phase Readiness

- The `aspect-video` placeholder + `SelectedMatchMeta` read-only card in `VodManagerPage.tsx`'s right panel is the exact, clean seam plan 01-03 (embedded YouTube/Twitch player + timestamp list) is meant to replace.
- Every `vodManager.*` i18n key plan 01-03 needs (`playerPlaceholder`, `playerUnavailable`, `openOnHost`) already exists in all 6 locales — 01-03 should not need to touch locale files again.
- `vodManagerFilters.ts`/`VodMatchList.tsx` are stable, tested contracts — 01-04 (VOD affordance consolidation at `MatchTable`/`SetTimeline`) can safely navigate to `/vod?match=<id>` against this shell without further shape changes.
- No blockers.

---

_Phase: 01-vod-manager-core-list-embed-seek_
_Completed: 2026-07-09_
