---
phase: 03-tags
plan: 03
subsystem: ui
tags: [react, i18n, cmdk, radix]

# Dependency graph
requires:
  - phase: 03-tags
    provides: 'apps/web/src/lib/tags.ts (NOTE_PRESET_TAGS, addTagToList, removeTagFromList, tagLabel, deriveCustomTagVocabulary), TagAddCombobox, and VodManagerPage tagVocabulary useMemo, 03-02'
provides:
  - 'TimestampRow: onUpdateTags(index, tags) + tagVocabulary props; note-tag chips (removable) + TagAddCombobox seeded with the 11 NOTE_PRESET_TAGS, sibling of the seek button (never inside it)'
  - 'TimestampList: handleUpdateTags(index, tags) array-rebuild that replaces only the targeted vodTimestamps element (no re-sort) and omits the tags key when the resulting list is empty; tagVocabulary forwarded to every row'
  - 'VodManagerPage: forwards its existing 03-02 tagVocabulary into TimestampList'
affects: [03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Note-tag array rebuild uses a conditional-spread object literal ({ seconds, note, ...(tags.length > 0 ? { tags } : {}) }) rather than a destructure-and-omit — keeps the existing conditional-spread-write/RTDB-null-stripping convention consistent across match-tag (buildUpdateInput) and note-tag (handleUpdateTags) carry-through, and avoids an unused-var lint concern from a rest-destructure.'

key-files:
  created: []
  modified:
    - apps/web/src/pages/VodManager/components/TimestampRow.tsx
    - apps/web/src/pages/VodManager/components/TimestampList.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx

key-decisions:
  - 'handleUpdateTags never re-sorts the vodTimestamps array (unlike handleCommitEdit) — tags do not affect chronological ordering, only seconds does, so tagging/untagging never reshuffles other notes or moves the edited row.'
  - 'Note-tag cap is 5 per note (vs. 10 for match tags) per TAG-04/the vodTimestampSchema.tags.max(5) already shipped in 03-01 — kept as a named MAX_NOTE_TAGS constant at TimestampRow module scope, matching the codebase convention of extracting magic numbers.'

patterns-established: []

requirements-completed: [TAG-02, TAG-04]

coverage:
  - id: D1
    description: 'Each timestamp note shows its tags as removable chips under the note text and a "+" combobox seeded with the 11 note presets (then custom vocabulary, then Create), both siblings of the seek button so tag interaction never seeks/selects the row'
    requirement: 'TAG-04'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#renders note tag chips and adds a preset tag via the note combobox, carrying other notes and match fields through without seeking'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Adding/removing a note tag persists via the single existing match PATCH, rebuilding only the targeted vodTimestamps element (omitting the tags key when it empties) and preserving every other note and match field'
    requirement: 'TAG-02'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#renders note tag chips and adds a preset tag via the note combobox, carrying other notes and match fields through without seeking'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#removes a note tag via the chip X, omitting tags from that note only, without disturbing other notes'
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-07-13
status: complete
---

# Phase 3 Plan 3: Note Tagging (Chips + Combobox on TimestampRow) Summary

**Note-level tag chips with removal + a preset/custom/create combobox on every VOD timestamp row, threaded through TimestampList's array-rebuild into the existing single match PATCH.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-13T13:16:00Z
- **Completed:** 2026-07-13T13:31:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `TimestampRow` renders each note's tags as removable `Badge` chips followed by a `TagAddCombobox` (seeded with `NOTE_PRESET_TAGS`, cap 5) — both rendered as siblings after the seek `<button>`, never inside it, preserving D-13/D-14 (tag interaction never seeks or selects the row)
- `TimestampList.handleUpdateTags(index, tags)` rebuilds only the targeted `vodTimestamps` element, omitting the `tags` key entirely when the array empties (mirroring the omit-to-clear convention already used for match tags), and never re-sorts (only time edits re-sort)
- `VodManagerPage` forwards its existing 03-02 `tagVocabulary` into `TimestampList`, so note tags share the same cross-match custom vocabulary as match tags
- Zero new primitives, zero new i18n keys — reused `tags.ts` and `TagAddCombobox` verbatim from 03-02
- Two new tests cover the add and remove flows, asserting the PATCH payload carries other notes/match fields through unchanged and that tagging never triggers `seekTo`

## Task Commits

Each task was committed atomically:

1. **Task 1: Note-tag chips + add affordance on TimestampRow** - `4b9e7ae` (feat)
2. **Task 2: Thread note-tag updates through TimestampList → VodManagerPage** - `6cc7fa8` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit)

_Note: Neither task in this plan is `tdd="true"`; both were committed as single `feat` commits, each including its own test coverage (Task 2 added the note-tag test cases)._

## Files Created/Modified

- `apps/web/src/pages/VodManager/components/TimestampRow.tsx` - `onUpdateTags`/`tagVocabulary` props; view-mode container restructured to `flex-col` with the original seek/pencil/trash/AlertDialog row unchanged, plus a new sibling row of tag chips + `TagAddCombobox` (`NOTE_PRESET_TAGS`, cap `MAX_NOTE_TAGS = 5`)
- `apps/web/src/pages/VodManager/components/TimestampList.tsx` - `tagVocabulary` prop forwarded to every row; `handleUpdateTags(index, tags)` array-rebuild (conditional-spread, no re-sort)
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - passes the existing `tagVocabulary` `useMemo` (from 03-02) into `TimestampList`
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - 2 new tests: note-tag chip render + preset add (carrying other notes/match fields through, asserting no seek), note-tag chip removal (omitting the `tags` key on that note only)

## Decisions Made

- `handleUpdateTags` intentionally never re-sorts the array (unlike `handleCommitEdit`, which re-sorts on every time edit) — tag changes don't affect `seconds`, so re-sorting would be both unnecessary and a source of surprising row reordering on a tag click.
- Kept the note-tag cap as a named `MAX_NOTE_TAGS = 5` module-scope constant in `TimestampRow.tsx` (matching `SelectedMatchMeta`'s `MAX_MATCH_TAGS` precedent) rather than an inline literal, per the codebase's "magic numbers extracted to named constants" convention — the value 5 still appears literally in the source for grep-based acceptance checks.
- `handleUpdateTags`'s array-rebuild uses a conditional-spread object literal (`{ seconds, note, ...(tags.length > 0 ? { tags } : {}) }`) instead of a destructure-and-omit (`const { tags: _drop, ...rest } = stamp`) — avoids an unused-variable lint footgun and stays consistent with the conditional-spread-write pattern already used everywhere else in this codebase for RTDB-optional fields.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both match-level (03-02) and note-level (03-03) tagging are now fully shipped and share every primitive (`tags.ts`, `TagAddCombobox`, `tagVocabulary`) — 03-04 (filtering) can derive `tagsInUse` from the same `vodMatches` data (both `match.tags` and every `vodTimestamps[].tags`) without needing new tag-storage plumbing.
- **Deploy-ordering reminder carried from 03-01/03-02 still applies**: the tag schema/passthrough diff (`packages/shared` + `apps/api`) must reach `master` + prod Cloud Run before any preview-channel human check in this phase, or preview PATCH calls with `tags` will be silently stripped by the still-old prod API schema.

---

_Phase: 03-tags_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified files exist on disk and both task commits (`4b9e7ae`, `6cc7fa8`) are present in git history.
