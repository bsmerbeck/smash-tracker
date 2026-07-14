---
phase: 03-tags
plan: 02
subsystem: ui
tags: [react, i18n, cmdk, radix, tanstack-query]

# Dependency graph
requires:
  - phase: 03-tags
    provides: 'Optional `tags: string[]` on match records and VOD-timestamp notes (schema + API passthrough), 03-01'
provides:
  - 'apps/web/src/lib/tags.ts — MATCH_PRESET_TAGS (5), NOTE_PRESET_TAGS (11), PRESET_SLUGS, tagLabel, addTagToList, removeTagFromList, deriveCustomTagVocabulary'
  - 'apps/web/src/pages/VodManager/components/TagAddCombobox.tsx — shared preset → custom → create tag-add combobox, props: presets/existingTags/vocabulary/onAdd/ariaLabel'
  - 'buildUpdateInput (VodNotesDialog.tsx) extended with an optional `tags` override, defaulting to `match.tags` carry-through for every existing caller'
  - 'Match-tag chips + add/remove on SelectedMatchMeta view state (editable on synced matches)'
  - 'tags.preset.<16 slugs>, tags.combobox.*, tags.addAria/removeAria across all 6 locales'
affects: [03-03, 03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Manual Command filtering (shouldFilter=false) instead of cmdk built-in fuzzy filter, so a translated preset LABEL can be typed to match a slug-valued CommandItem, and a stable-sentinel Create row survives every keystroke'
    - "'key in overrides' presence check (not just !== undefined) to distinguish 'caller omitted this override, use default' from 'caller explicitly wants to clear this field' — extends the conditional-spread-write playbook to a field with BOTH a default-carry-through AND an explicit-clear caller"

key-files:
  created:
    - apps/web/src/lib/tags.ts
    - apps/web/src/lib/tags.test.ts
    - apps/web/src/pages/VodManager/components/TagAddCombobox.tsx
    - apps/web/src/pages/VodManager/components/TagAddCombobox.test.tsx
  modified:
    - apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.tsx
    - apps/web/src/pages/VodManager/VodManagerPage.test.tsx
    - apps/web/src/components/vod/VodNotesDialog.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - "'tags' in overrides (presence check) rather than overrides.tags !== undefined decides buildUpdateInput's tags behavior — lets SelectedMatchMeta's remove-last-tag flow pass `tags: undefined` to mean 'omit the key, clear tags' while every pre-existing caller that never mentions tags at all still gets the match.tags default carry-through. A plain !== undefined check would have made the two cases indistinguishable and silently kept stale tags on clear."
  - 'TagAddCombobox disables cmdk built-in filtering (shouldFilter=false) and filters manually against tagLabel(t, slug)/the raw custom string — cmdk filters by CommandItem `value`, which for presets is the untranslated slug, so typing a translated label like "Punish" would otherwise filter that very item out, and the Create sentinel would vanish on any keystroke.'
  - 'Custom tag text that case-insensitively matches a preset TRANSLATED LABEL dedupes onto the preset SLUG (both at combobox Create-select time and by simply not offering a Create row when the typed text already exact-matches a preset label) — per CONTEXT.md.'
  - 'tagVocabulary is computed once at VodManagerPage level over ALL loaded VOD matches (not per-match) and threaded down as a prop — the locked cross-match vocabulary decision from 03-CONTEXT.md, reused verbatim by 03-03s note-tag combobox.'

patterns-established:
  - 'Tag preset lists + pure helpers isolated in a single lib module (apps/web/src/lib/tags.ts) with zero React/i18n coupling except tagLabel, which takes t as a parameter — mirrors the existing tournamentLabel/matchTypeLabel resolver-helper shape in this codebase.'

requirements-completed: [TAG-01, TAG-03]

coverage:
  - id: D1
    description: 'apps/web/src/lib/tags.ts exports the 5 match presets, 11 note presets, PRESET_SLUGS, and pure helpers (tagLabel, addTagToList, removeTagFromList, deriveCustomTagVocabulary) covering trim/dedupe/cap/vocabulary-derivation'
    requirement: 'TAG-03'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/tags.test.ts (14 tests)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'TagAddCombobox renders preset labels (translated) then custom vocabulary then a stable-sentinel Create row for unmatched typed text; filters out already-applied tags; normalizes Create text onto a matching preset slug'
    requirement: 'TAG-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/components/TagAddCombobox.test.tsx (7 tests)'
        status: pass
      - kind: unit
        ref: 'apps/web/src/i18n/i18n.test.ts#every supported locale covers exactly the English key set'
        status: pass
    human_judgment: false
  - id: D3
    description: 'A user can add preset/custom tags to a match and remove them from the SelectedMatchMeta view state (including on synced matches), with tag writes preserving every other field and every other match edit preserving tags'
    requirement: 'TAG-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#renders match tag chips and adds a preset tag via the combobox, carrying other fields through'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#removes a match tag via the chip X, omitting tags from the payload when it was the last one'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/VodManagerPage.test.tsx#carries match tags through a match-detail edit save even when the VOD link is cleared'
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-07-13
status: complete
---

# Phase 3 Plan 2: Match Tagging (Combobox + Chips + Carry-Through) Summary

**Match-level tag chips with immediate add/remove on the VOD Manager metadata card, backed by a shared preset→custom→create cmdk combobox and a `buildUpdateInput` carry-through fix that keeps tags and every other field mutually intact.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-13T12:59:00Z
- **Completed:** 2026-07-13T13:09:00Z
- **Tasks:** 3
- **Files modified:** 14 (4 created, 10 modified)

## Accomplishments

- `apps/web/src/lib/tags.ts`: the 5 match presets, 11 note presets, and pure helpers (`tagLabel`, `addTagToList`, `removeTagFromList`, `deriveCustomTagVocabulary`) — fully unit-tested, zero React dependency
- `TagAddCombobox`: a shared, reusable Popover+Command combobox showing presets (translated) → custom vocabulary → a stable-sentinel "Create" row for freeform text, with manual filtering so translated labels and the Create row survive typing
- `SelectedMatchMeta`'s view state now renders match-tag chips with one-click removal and the add-combobox, editable even on synced matches (tags aren't sync-owned)
- `buildUpdateInput` carries `match.tags` through by default for every existing caller (VOD note dialog, MatchTable's "Remove VOD link"), while accepting an explicit `tags` override (including `undefined`, to actually clear the last tag) for `SelectedMatchMeta`'s add/remove handlers
- All new tag copy shipped across all 6 locales (en/es/fr/de/pt/ja) with the i18n parity test passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Tag logic module (preset lists + pure helpers)** - `0df1b91` (test, RED) / `f0b85d9` (feat, GREEN)
2. **Task 2: Shared TagAddCombobox + tag i18n across 6 locales** - `8bde2af` (feat)
3. **Task 3: Match-tag chips on SelectedMatchMeta + tag-safe carry-through** - `5b9ce68` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit)

_Note: Task 1 (`tdd="true"`) has a genuine RED→GREEN pair — the test file was committed first, then the implementation. Tasks 2-3 are not TDD-flagged in the plan and were committed as single feat commits, each including its own test coverage._

## Files Created/Modified

- `apps/web/src/lib/tags.ts` - Preset slug lists (`as const`), `PRESET_SLUGS` Set, `tagLabel`, `addTagToList` (trim/case-insensitive-dedupe/cap), `removeTagFromList`, `deriveCustomTagVocabulary` (Set+sort over match + note tags, presets excluded)
- `apps/web/src/lib/tags.test.ts` - 14 tests covering every behavior-block case
- `apps/web/src/pages/VodManager/components/TagAddCombobox.tsx` - Popover+Command combobox: preset group → custom vocabulary group → stable-sentinel Create row, manual (non-cmdk) filtering against display labels
- `apps/web/src/pages/VodManager/components/TagAddCombobox.test.tsx` - 7 tests: label rendering, existing-tag filtering, Create row, onAdd payloads (preset slug / raw custom / normalized-onto-preset), vocabulary rendering
- `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx` - Match-tag chip row + add/remove handlers on the view state; `onSubmit` carries `match.tags` unconditionally; new `tagVocabulary` prop
- `apps/web/src/pages/VodManager/VodManagerPage.tsx` - `tagVocabulary` computed via `useMemo(() => deriveCustomTagVocabulary(vodMatches), [vodMatches])`, threaded into `SelectedMatchMeta`
- `apps/web/src/pages/VodManager/VodManagerPage.test.tsx` - 4 new tests: chip render + preset add + field carry-through, chip removal drops the `tags` key on last removal, match-detail edit carries tags through even when the VOD link is cleared
- `apps/web/src/components/vod/VodNotesDialog.tsx` - `buildUpdateInput`'s `overrides` param gains an optional `tags?: string[] | undefined`; presence-checked (`'tags' in overrides`) against a default `match.tags` carry-through
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - New top-level `tags` namespace: `preset.<16 slugs>`, `combobox.{placeholder,create,empty}`, `addAria`, `removeAria`

## Decisions Made

- `buildUpdateInput` distinguishes "caller never mentioned `tags`" from "caller explicitly passed `tags: undefined`" via `'tags' in overrides`, not `overrides.tags !== undefined`. The plan's literal spec ("if `overrides.tags !== undefined` spread override, else fall back to `match.tags`") would have silently kept stale tags when `SelectedMatchMeta`'s remove-handler cleared the last tag by passing `tags: undefined` — that value IS `undefined` at the point of the check, so a plain `!==` comparison can't tell "omit tags key entirely" apart from "no override given." The presence check makes both cases correct: default-carry-through for every caller that doesn't mention tags, explicit-clear for the one caller that does.
- `TagAddCombobox` disables cmdk's built-in fuzzy filter (`shouldFilter={false}`) and filters manually against `tagLabel(t, slug)` / the raw custom string. cmdk's default filter matches against each `CommandItem`'s `value`, which for presets is the untranslated slug — typing the visible translated label would otherwise filter that very item out of the list, and the Create row's stable sentinel value would disappear on any keystroke since it never matches the typed text.
- Custom tag text that case-insensitively equals a preset's translated label normalizes onto the preset SLUG, both at Create-select time and by not offering a Create row at all when the typed text already exact-matches a preset (per 03-CONTEXT.md's dedupe rule).
- `tagVocabulary` is computed once at `VodManagerPage` level over every loaded VOD-bearing match (not scoped to the selected match) and passed down as a prop — the CONTEXT.md-locked "vocabulary spans all loaded matches" decision, set up here so 03-03's note-tag combobox can reuse the same page-level value without re-deriving it.

## Deviations from Plan

None — plan executed as written. The `buildUpdateInput` presence-check refinement above is a faithful implementation of the plan's stated intent ("send `undefined` when clearing the last tag... omitting a field here would clear it, not leave it untouched") rather than a deviation from it; the plan's shorthand pseudocode for the override-wins semantics needed the presence check to actually deliver that intent.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `TagAddCombobox` and `apps/web/src/lib/tags.ts` are genuine shared primitives (props: `presets`, `existingTags`, `vocabulary`, `onAdd`, `ariaLabel`) ready for 03-03 to reuse verbatim for note-level tags (seeded with `NOTE_PRESET_TAGS` instead of `MATCH_PRESET_TAGS`)
- `VodManagerPage`'s page-level `tagVocabulary` is already computed and available for 03-03 to thread into the note-tag combobox without re-deriving it
- 03-04 (filtering) will need a separate `tagsInUse` derivation (tags actually applied, not the full custom vocabulary) — noted in the plan as intentionally distinct from `tagVocabulary`, not yet built
- **Deploy-ordering reminder carried from 03-01's SUMMARY still applies**: the tag schema/passthrough diff (`packages/shared` + `apps/api`, commits `ec503b0`/`a921830`/`33f30f0`) must reach `master` + prod Cloud Run before any preview-channel human check in this phase, or preview PATCH calls with `tags` will be silently stripped by the still-old prod API schema.

---

_Phase: 03-tags_
_Completed: 2026-07-13_

## Self-Check: PASSED

All modified/created files exist on disk and all task commits (`0df1b91`, `f0b85d9`, `8bde2af`, `5b9ce68`) are present in git history.
