---
phase: 03-tags
plan: 04
subsystem: ui
tags: [react, i18n, filtering, tanstack-query]

# Dependency graph
requires:
  - phase: 03-tags
    provides: 'apps/web/src/lib/tags.ts (tagLabel), match.tags + vodTimestamps[].tags data (03-01/03-02/03-03)'
provides:
  - 'VodManagerFilterState.tags: string[] (default []) — multi-select tag filter dimension'
  - 'applyVodManagerFilters tag predicate: OR-within-selected-tags, match-or-any-note-level hit, AND-composed after fighter/opponentFighter/stage/tournament/opponent'
  - 'getVodManagerFilterOptions().tagsInUse — sorted, deduped list of tags actually applied across match.tags and every vodTimestamps[].tags'
  - 'VodMatchList tag filter chip row (Badge asChild + button toggle, aria-pressed, default/outline variant) below the sort control, hidden when tagsInUse is empty'
  - 'vodManager.filters.tagsLabel across all 6 locales'
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Badge asChild wrapping a <button type="button" aria-pressed> for a toggleable filter chip (distinct from the existing removable-chip pattern of Badge + nested X button used for match/note tag chips) — variant flips default/outline on selection instead of rendering a remove affordance.'

key-files:
  created: []
  modified:
    - apps/web/src/pages/VodManager/lib/vodManagerFilters.ts
    - apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts
    - apps/web/src/pages/VodManager/components/VodMatchList.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - 'filters.tags defaults to [] (not the ALL_FILTER_VALUE sentinel every other VodManagerFilterState dimension uses) because it is a multi-select — empty array is the natural "no tag narrowing" identity, matching the plan spec exactly.'
  - 'The tag AND-branch runs LAST in applyVodManagerFilters (after delegated dropdown filtering AND opponent filtering), so a match carrying a selected tag but excluded by any other dimension never surfaces — preserves strict AND-across-dimensions/OR-within-tags composition.'
  - 'tagsInUse is a separate derivation from tags.ts deriveCustomTagVocabulary (03-02): tagsInUse includes PRESET tags that are actually used (for the filter row, so a used preset shows as a filterable chip), while deriveCustomTagVocabulary explicitly excludes presets (it feeds the add-combobox custom group). Both share the same Set+iterate-match-and-notes+sort shape but serve different UI surfaces.'

patterns-established: []

requirements-completed: [TAG-05]

coverage:
  - id: D1
    description: 'applyVodManagerFilters narrows the VOD list by tag: OR within multiple selected tags, a match surfaces on either a match-level or any note-level tag hit, and the tag filter AND-composes with every existing dropdown filter'
    requirement: 'TAG-05'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts#tags (5 cases: match-level hit, note-only hit, OR-within, AND-composition, empty-passthrough)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'getVodManagerFilterOptions derives tagsInUse — every distinct tag actually applied across match.tags and note tags, sorted and deduped, excluding presets with zero uses'
    requirement: 'TAG-05'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts#getVodManagerFilterOptions > derives tagsInUse from both match.tags and note tags, sorted and deduped, excluding zero-use presets'
        status: pass
    human_judgment: false
  - id: D3
    description: 'The list panel renders a toggleable Badge chip row (below the sort control) sourced from tagsInUse; toggling a chip updates filters.tags and narrows the visible match list; the row is hidden when no tags are in use'
    requirement: 'TAG-05'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx (existing suite re-verified green against the new chip row; no dedicated new component test added for the chip row itself)'
        status: pass
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
    human_judgment: true
    rationale: 'The chip-toggle interaction itself (click narrows the list visually, second click ORs, dropdown AND-composes on top) is exercised end-to-end by the filter-logic unit tests, but no component-level test drives the actual chip click in VodMatchList — the phase-end human-check (Task 2 step 5) is the intended verification surface for the wired UI, per the plan.'
  - id: D4
    description: 'vodManager.filters.tagsLabel ships across all 6 locales (en/es/fr/de/pt/ja)'
    requirement: 'TAG-05'
    verification:
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-07-13
status: complete
---

# Phase 3 Plan 4: Tag Filter (Chip Row + AND/OR Composition) Summary

**A toggleable Badge-chip tag filter row in the VOD Manager list panel — OR-within-selected-tags, match-or-any-note-level hit, AND-composed with every existing dropdown filter, sourced from an in-use-only tag list, closing out TAG-05 and the whole tags phase.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-13T13:26:00Z
- **Completed:** 2026-07-13T13:46:00Z
- **Tasks:** 2
- **Files modified:** 10 (0 created, 10 modified)

## Accomplishments

- `VodManagerFilterState.tags: string[]` (default `[]`) is a new multi-select filter dimension, distinct from every other dimension's `ALL_FILTER_VALUE` sentinel — empty array is the natural "no tag filter" identity for a multi-select.
- `applyVodManagerFilters` AND-composes a tag predicate after all existing dropdown/opponent filtering: a match surfaces when it carries ANY selected tag (OR within `filters.tags`), checking both `match.tags` and every `vodTimestamps[].tags` — a match whose only hit is a note tag still surfaces.
- `getVodManagerFilterOptions().tagsInUse` lists only tags actually applied across all loaded matches (both match- and note-level), sorted and deduped — a preset with zero uses never appears in the filter row.
- `VodMatchList` renders a wrap-friendly `Badge`-as-toggle chip row below the sort control, sourced from `tagsInUse`, hidden entirely when no tags are in use; selected chips render `variant="default"`, unselected `variant="outline"`, with `aria-pressed` for accessibility.
- `vodManager.filters.tagsLabel` ("Tags"/"Etiquetas"/"Tags"/"Tags"/"Tags"/"タグ") shipped across all 6 locales — the one new i18n key for the whole plan (chip text itself reuses `tags.preset.*` via `tagLabel`, customs render raw).
- Two pre-existing `VodManagerPage.test.tsx` assertions (`findByText('Punish')`, `findByText('Practice/Friendlies')`) became ambiguous once the same labels also render as filter-row toggle chips; both were re-scoped (to the note row, and to the chip's unique remove-button accessible name) rather than weakened — the underlying behavior they verify (chip renders with correct translated label) is unchanged.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tag filter composition in vodManagerFilters** - `b5a9c21` (test, RED) / `30bbb97` (feat, GREEN)
2. **Task 2: Tag filter chip row in VodMatchList + filter label i18n** - `909726d` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit)

_Note: Task 1 (`tdd="true"`) has a genuine RED→GREEN pair — the test file was committed first (6 failing assertions confirmed), then the implementation made all 15 tests in the file pass. Task 2 is not TDD-flagged and was committed as a single `feat` commit including its own test-suite fixups._

## Files Created/Modified

- `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts` - `VodManagerFilterState.tags` + `DEFAULT_VOD_MANAGER_FILTERS.tags: []`; `applyVodManagerFilters` tag AND-branch (OR-within, match-or-note); `getVodManagerFilterOptions().tagsInUse`
- `apps/web/src/pages/VodManager/lib/vodManagerFilters.test.ts` - New `tags` default assertion, 5-case `describe('tags', ...)` block (match-level hit, note-only hit, OR-within, AND-composition, empty-passthrough), `tagsInUse` derivation test
- `apps/web/src/pages/VodManager/components/VodMatchList.tsx` - `tagsInUse` on the local `VodManagerFilterOptions` type; `toggleTag` handler; conditional chip row (`flex flex-wrap gap-1.5`) below the sort `Select`, hidden when `tagsInUse` is empty
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - Re-scoped two pre-existing text queries that became ambiguous against the new filter chip row (no behavior change, disambiguation only)
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - `vodManager.filters.tagsLabel` added to all 6 locales

## Decisions Made

- `filters.tags` defaults to `[]`, not `ALL_FILTER_VALUE` — the plan's explicit instruction, since this is the first multi-select dimension in `VodManagerFilterState` (every prior dimension is single-select with an "all" sentinel). Kept literally as specified; no ambiguity to resolve.
- The tag predicate is applied strictly LAST in `applyVodManagerFilters` (after delegated dropdown filtering and opponent filtering), guaranteeing AND-composition: a match that carries a selected tag but was already excluded by fighter/stage/tournament/opponent never reaches the tag check and never surfaces.
- `tagsInUse` intentionally does NOT exclude presets (unlike `tags.ts`'s `deriveCustomTagVocabulary`, which excludes presets because it feeds the add-combobox's "custom tags you've already used" group). The filter row needs every tag in active use, preset or custom, so a used preset renders as a toggleable chip — this is a deliberate divergence from the superficially similar 03-02 helper, not an oversight.
- Chose a `Badge asChild` + `<button>` toggle (variant flips `default`/`outline` on selection, `aria-pressed` communicates state) rather than reusing the removable-chip pattern (`Badge` + nested X button) from `SelectedMatchMeta`/`TimestampRow` — filter chips toggle membership in a selection set, they don't remove data, so a different interaction affordance (no X, whole chip is clickable) is the correct semantic fit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Disambiguated two pre-existing test queries broken by the new filter chip row**

- **Found during:** Task 2 verification (`vitest run src/pages/VodManager`)
- **Issue:** `VodManagerPage.test.tsx`'s `renders match tag chips and adds a preset tag via the combobox...` and `renders note tag chips and adds a preset tag via the note combobox...` tests used `screen.findByText('Practice/Friendlies')` and `screen.findByText('Punish')` to assert an existing tag chip rendered. Once the new tag filter row in `VodMatchList` also renders those same translated labels as toggle-chip button text (because the test's single loaded match carries those tags, making them "in use"), both queries became ambiguous (`Found multiple elements with the text: ...`) and failed.
- **Fix:** Re-scoped the match-tag test to assert via the removable chip's unique accessible name (`findByRole('button', { name: 'Remove tag Practice/Friendlies' })` — semantically equivalent proof the chip rendered with the correct label, and already used elsewhere in the same file for the removal test). Re-scoped the note-tag test to query `within(noteARow)` after locating the row via `screen.getByText('note A').closest('li')`, matching the pattern the same test already used one line later for its combobox interaction.
- **Files modified:** `apps/web/src/pages/VodManager/VodManagerPage.test.tsx`
- **Verification:** `pnpm --filter @smash-tracker/web exec vitest run src/pages/VodManager src/i18n/i18n.test.ts` — all 44 tests pass
- **Committed in:** `909726d` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — test disambiguation caused by intentional new UI, not a behavior regression)
**Impact on plan:** No scope creep — the fix only touches test assertions to keep them unambiguous after adding the plan-specified chip row; the behavior each test verifies (correct tag chip rendering, correct PATCH payload, no accidental seek) is unchanged and still fully covered.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

This is the last plan of Phase 3. All of TAG-01..05 are now demoable end-to-end in the VOD Manager:

- **TAG-01/TAG-03** (03-02): Match-level preset + custom tag chips, add/remove, carried through every match edit.
- **TAG-02/TAG-04** (03-03): Note-level preset + custom tag chips on every timestamp row, add/remove, carried through the single existing PATCH without disturbing other notes or seeking.
- **TAG-05** (03-04, this plan): A toggleable tag filter chip row in the list panel — OR within selected tags, match-or-any-note-level hit, AND-composed with the five existing dropdown filters, sourced from an in-use-only tag list, one new i18n key across all 6 locales.

**Outstanding before the phase's end-of-phase human-check can run (carried from 03-01/03-02/03-03 SUMMARYs, unchanged by this plan):** the 03-01 schema/API diff (`packages/shared` + `apps/api`) must be merged to `master` and deployed to the prod Cloud Run API before any preview-channel verification — the plan's per-instructions note states this precondition is already satisfied (prod rev 00034 carries tags support), so the orchestrator's end-of-phase `<human-check>` can proceed directly to the 6-step preview walkthrough in Task 2's `<human-check>` block:

1. Add a preset + custom match tag on the metadata card, confirm both persist through reload.
2. Add a preset + custom note tag on a timestamp, confirm chips don't trigger seek and persist through reload.
3. Edit match/note details and Save, confirm tags carry through.
4. Remove a tag via its X on both a match and a note chip, confirm immediate removal.
5. Toggle a tag chip in the new filter row, confirm the list narrows correctly (including a note-only-tag match), that a second selected tag ORs, and that a dropdown filter still AND-narrows on top.
6. Switch locale (e.g. Japanese) and confirm preset labels + the new "Tags"/"タグ" filter label translate, with customs rendering as typed.

No blockers for the milestone beyond that standard human-check.

---

_Phase: 03-tags_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified/created files exist on disk and all task commits (`b5a9c21`, `30bbb97`, `909726d`) are present in git history.
