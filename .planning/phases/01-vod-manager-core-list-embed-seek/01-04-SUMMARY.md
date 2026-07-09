---
phase: 01-vod-manager-core-list-embed-seek
plan: 04
subsystem: ui
tags: [react, react-router, i18n, vitest]

requires:
  - phase: 01-vod-manager-core-list-embed-seek
    provides: '/vod route + VodManagerPage master-detail shell (plan 01-02); ?match= deep-link contract'
provides:
  - 'MatchTable VOD icon: has-VOD navigates same-tab into /vod?match=<id>, no-VOD still opens VodNotesDialog'
  - 'SetTimeline Watch-VOD affordance: same-tab react-router Link into /vod?match=<id> (was external target=_blank)'
  - 'matchData.table.watchVod i18n key across all 6 locales'
affects: []

tech-stack:
  added: []
  patterns:
    - 'D-09/D-10 VOD-affordance split (hasVod true -> navigate, false -> dialog) applied identically at every existing VOD-icon entry point, no per-page special-casing'
    - 'All internal SPA navigation imports from "react-router" (v8), never "react-router-dom"'

key-files:
  created: []
  modified:
    - apps/web/src/pages/MatchData/components/MatchTable.tsx
    - apps/web/src/pages/Tournaments/components/SetTimeline.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json
    - apps/web/src/pages/MatchData/MatchDataPage.test.tsx
    - apps/web/src/pages/Tournaments/components/SetTimeline.test.tsx

key-decisions:
  - "SetTimeline Watch-VOD affordance icon swapped from ExternalLink to Video (lucide-react) since the link destination is now internal, per the plan's own guidance to pick one or the other"
  - "ExternalLink import retained in SetTimeline.tsx (still used by OpponentLabel's outbound start.gg profile link) — not removed, only its usage on the Watch-VOD link was replaced"

requirements-completed: [LIB-03]

coverage:
  - id: D1
    description: 'matchData.table.watchVod = "Watch VOD" (locale-appropriate translations) present across all 6 locales, sibling to editVod/addVod'
    requirement: 'LIB-03'
    verification:
      - kind: other
        ref: "node i18n key-presence check across en/es/fr/de/pt/ja (plan's verify block) — WATCHVOD_OK"
        status: pass
    human_judgment: false
  - id: D2
    description: 'MatchTable VOD icon navigates same-tab to /vod?match=<id> via useNavigate("react-router") when hasVod===true; aria-label switches from editVod to watchVod; hasVod===false unchanged (still opens VodNotesDialog via setVodMatch)'
    requirement: 'LIB-03'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/MatchData/MatchDataPage.test.tsx#shows "Add VOD notes" for a match without a vodUrl and "Watch VOD" for one with'
        status: pass
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web build + typecheck; grep useNavigate/react-router/vod?match=/watchVod/setVodMatch in MatchTable.tsx per plan acceptance criteria'
        status: pass
    human_judgment: true
    rationale: "The plan's own <verification> block requires manually confirming, from a running app, that a has-VOD row's icon navigates same-tab with that match preselected and a no-VOD row still opens the attach dialog — not fully provable by unit test + static grep alone."
  - id: D3
    description: 'SetTimeline Watch-VOD affordance is now a same-tab react-router Link to /vod?match=<id> (no target=_blank/rel=noreferrer); pencil VodNotesDialog trigger and VodTimestampChips (external per-timestamp deep-links) unchanged'
    requirement: 'LIB-03'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/Tournaments/components/SetTimeline.test.tsx#shows a "Watch VOD" link when a game in the set carries a vodUrl; #shows the VOD link when only one game in a multi-game set carries the vodUrl; #opens the VOD notes dialog from the edit affordance'
        status: pass
      - kind: other
        ref: 'pnpm --filter @smash-tracker/web build + typecheck; grep Link-from-react-router/vod?match=/VodNotesDialog/VodTimestampChips in SetTimeline.tsx per plan acceptance criteria'
        status: pass
    human_judgment: true
    rationale: "The plan's <verification> block requires manually confirming, from a running tournament detail page, that the Watch-VOD affordance navigates same-tab into the Manager preselected and the pencil still opens the dialog — not fully provable by unit test + static grep alone."

duration: 6min
completed: 2026-07-09
status: complete
---

# Phase 1 Plan 04: VOD Affordance Consolidation Summary

**MatchTable's and SetTimeline's existing VOD icons now deep-link has-VOD matches into `/vod?match=<id>` (same-tab, react-router) instead of opening the edit dialog, while no-VOD matches keep the unchanged attach-a-first-VOD dialog flow — completing LIB-03 end-to-end.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-09T22:44:33Z
- **Completed:** 2026-07-09T22:50:07Z
- **Tasks:** 3
- **Files modified:** 10 (0 created, 10 modified)

## Accomplishments

- `matchData.table.watchVod` = "Watch VOD" (translated per-locale) shipped as a sibling of `editVod`/`addVod` across all 6 locales (en/es/fr/de/pt/ja); `editVod` key left in place, untouched
- `MatchTable.tsx`'s VOD-icon `onClick` now branches on `hasVod`: `true` navigates same-tab (`useNavigate` from `'react-router'`, not `react-router-dom`) to `/vod?match=<id>`; `false` still calls `setVodMatch(...)` opening `VodNotesDialog` exactly as before. The has-VOD aria-label switched from `matchData.table.editVod` to the new `matchData.table.watchVod`
- `SetTimeline.tsx`'s `VodLink`'s "Watch VOD" affordance changed from an external `<a href={vodUrl} target="_blank" rel="noreferrer">` to a same-tab react-router `<Link to={`/vod?match=${vodMatch.id}`}>`, with the icon swapped from `ExternalLink` to `Video` (internal destination); the pencil `VodNotesDialog` trigger and `VodTimestampChips` (per-timestamp external deep-links to the VOD host itself) are unchanged
- D-09/D-10 split applied identically at both entry points — no per-page special-casing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add matchData.table.watchVod key across all 6 locales** - `e5c2b0a` (feat)
2. **Task 2: MatchTable VOD icon — navigate when hasVod, keep dialog when not (D-09/D-11)** - `f43f40f` (feat)
3. **Task 3: SetTimeline Watch-VOD affordance — same-tab react-router Link into the Manager (D-09/D-10/D-11)** - `9ebf215` (feat)
4. **Deviation fix: update pre-existing tests broken by the intentional behavior change** - `683762b` (fix)

**Plan metadata:** commit skipped — `commit_docs: false` in `.planning/config.json` (this is a parallel worktree executor; the orchestrator owns STATE.md/ROADMAP.md updates after merge per its instructions).

## Files Created/Modified

- `apps/web/src/pages/MatchData/components/MatchTable.tsx` - `useNavigate` import + call; VOD-icon `onClick` branches on `hasVod` (navigate vs. `setVodMatch`); aria-label `editVod` → `watchVod`; `navigate` added to the `columns` memo dependency array
- `apps/web/src/pages/Tournaments/components/SetTimeline.tsx` - `Link` import from `'react-router'`; `Video` icon import added (kept `ExternalLink`, still used by `OpponentLabel`); Watch-VOD anchor replaced with an internal `Link`, dropping `target="_blank"`/`rel="noreferrer"`
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - new `matchData.table.watchVod` key
- `apps/web/src/pages/MatchData/MatchDataPage.test.tsx` - has-VOD aria-label assertion updated from "Edit VOD notes" to "Watch VOD"
- `apps/web/src/pages/Tournaments/components/SetTimeline.test.tsx` - wrapped `renderTimeline` in `MemoryRouter` (the `Link` component requires router context); Watch-VOD link assertions updated to check the internal `/vod?match=<id>` href with no `target`/`rel` attributes

## Decisions Made

- Swapped `ExternalLink` for `Video` (lucide-react) on the SetTimeline Watch-VOD affordance since the link is now internal — the plan explicitly left "swap the icon or drop it" to executor discretion; swapping was chosen to preserve a visual leading icon on the affordance rather than removing it.
- Kept the `ExternalLink` import in `SetTimeline.tsx` (it's still used by `OpponentLabel`'s outbound start.gg profile link) rather than removing/re-adding it — no unused-import risk.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed two pre-existing tests broken by the intentional D-09/D-11 behavior change**

- **Found during:** Post-Task-3 full test suite run
- **Issue:** `MatchDataPage.test.tsx` asserted the has-VOD icon's aria-label was still "Edit VOD notes" (now "Watch VOD" per Task 2). `SetTimeline.test.tsx` rendered `SetTimeline` without a router context, and `react-router`'s `Link` (introduced in Task 3) throws `Cannot destructure property 'basename' of 'React$1.useContext(...)' as it is null` without one; two of its assertions also checked the old external-link `href`/`target`/`rel` behavior.
- **Fix:** Updated the `MatchDataPage.test.tsx` assertion to expect "Watch VOD". Wrapped `SetTimeline.test.tsx`'s `renderTimeline` helper in `MemoryRouter` (matching the established convention already used in `MatchDataPage.test.tsx` and other router-consuming component tests in this codebase) and updated the two Watch-VOD link assertions to check the new internal `/vod?match=<id>` href with no `target`/`rel` attributes.
- **Files modified:** `apps/web/src/pages/MatchData/MatchDataPage.test.tsx`, `apps/web/src/pages/Tournaments/components/SetTimeline.test.tsx`
- **Verification:** `pnpm --filter @smash-tracker/web test` — 990/990 tests passing (119/119 test files)
- **Committed in:** `683762b` (dedicated fix commit, after the three task commits)

**2. [Rule 3 - Blocking] Built `@smash-tracker/shared` before running web build/test**

- **Found during:** Pre-Task-2 verification setup
- **Issue:** `@smash-tracker/shared` had no `dist/` output in this worktree (pre-existing workspace state, same environment gap already documented in plan 01-02's summary — not caused by this plan's changes)
- **Fix:** Ran `pnpm --filter @smash-tracker/shared build` once, which unblocked `pnpm --filter @smash-tracker/web build`/`typecheck`/`test`
- **Files modified:** none (build output only, gitignored `packages/shared/dist`, not committed)
- **Verification:** subsequent build/typecheck/test all succeeded
- **Committed in:** N/A (no source change; environment/build-state fix only)

---

**Total deviations:** 2 auto-fixed (1 bug/pre-existing-test-breakage, 1 blocking/environment)
**Impact on plan:** Both were necessary consequences of the plan's own intentional behavior change (D-09/D-11) and a known pre-existing environment gap. No scope creep — no plan/requirement changes.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Self-Check

Verified the following before finalizing:

- `apps/web/src/pages/MatchData/components/MatchTable.tsx` — FOUND, contains `useNavigate`, `/vod?match=`, `watchVod`, `setVodMatch`
- `apps/web/src/pages/Tournaments/components/SetTimeline.tsx` — FOUND, contains `Link` from `'react-router'`, `/vod?match=`, `VodNotesDialog`, `VodTimestampChips`
- All 6 locale files contain `matchData.table.watchVod` (node check: `WATCHVOD_OK`)
- Commit `e5c2b0a` (i18n keys) — FOUND in `git log --oneline`
- Commit `f43f40f` (MatchTable) — FOUND
- Commit `9ebf215` (SetTimeline) — FOUND
- Commit `683762b` (test fixes) — FOUND
- `pnpm --filter @smash-tracker/web build` — succeeds
- `pnpm --filter @smash-tracker/web typecheck` — clean
- `pnpm --filter @smash-tracker/web test` — 990/990 passing
- `npx eslint` on all 4 modified `.tsx` source/test files — clean (0 errors; 1 pre-existing unrelated `react-hooks/incompatible-library` warning in `MatchTable.tsx` on `useReactTable`, not introduced by this plan)

## Next Phase Readiness

- LIB-03 is now fully delivered: every existing VOD affordance (`MatchTable` icon + `SetTimeline` Watch-VOD link) deep-links has-VOD matches into the VOD Manager (plan 01-02's `/vod?match=<id>` shell) same-tab, preselected.
- The no-VOD attach flow (`VodNotesDialog`) is preserved identically at both entry points — Phase 2 (which adds inline match/note editing inside the Manager itself) can build on this without needing to touch `MatchTable.tsx`/`SetTimeline.tsx` again for the VOD-icon split.
- This plan touched no player/embed code (plan 01-03's scope) and no new i18n keys beyond `matchData.table.watchVod` — no additional locale work needed downstream.
- No blockers.

---

_Phase: 01-vod-manager-core-list-embed-seek_
_Completed: 2026-07-09_
