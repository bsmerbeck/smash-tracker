# Phase 3: Tags - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

<domain>
## Phase Boundary

A user with a growing VOD library can tag matches and individual timestamp notes the way they actually think about their play — preset and freeform custom tags — and use chip-style tag filters to narrow the VOD Manager list. Delivers TAG-01..05. Playlists are out of scope (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Data model & storage

- Tags are EMBEDDED ARRAYS: optional `tags: string[]` on the match record AND on each `vodTimestamps` entry — no separate tags tree, no references, no new API endpoints. Rides the existing full-carry-through PATCH; RTDB rules: `.nullish()` schema + conditional-spread writes (omit when empty — RTDB drops empty arrays anyway, mirror the stageFavorites `.default([])` read-side lesson).
- This RESOLVES the STATE.md blocker (RTDB fan-out/orphan risk): tags live inside the records they describe, so match deletion cascades automatically — there is no cross-referencing data to orphan.
- The custom-tag vocabulary (for autocomplete/suggestions) is DERIVED at read time from the user's loaded matches — no stored registry, zero drift/orphan risk.
- Preset tags are stored as STABLE SLUGS (`tournament-set`, `practice-friendlies`, `bad-matchup`, `good-read-highlight`, `to-review`; note-level: `neutral`, `punish`, `edgeguard`, `recovery`, `kill-confirm`, `defense`, `mixup`, `matchup-note`, `mental-game`, `mistake`, `highlight`) and displayed via i18n keys ×6 locales. Custom tags are stored as the user typed them (trimmed) and displayed raw.
- Custom tag rules: trim; case-insensitive dedupe within a record; max 24 chars per tag; max 10 tags per match, 5 per note. A custom tag that normalizes onto a preset slug's display label dedupes onto the preset.

### Tagging UI

- Match tags: chip list + "+" add affordance directly on the SelectedMatchMeta card VIEW state (not gated behind Phase 2's edit mode). Tags are annotations — editable on synced matches too (they are NOT in the 9 sync-owned fields).
- Note tags: small chips rendered under each TimestampRow's note text; a "+" affordance opens the same add-combobox seeded with the NOTE preset list.
- Add interaction: cmdk combobox popover — preset tags first (translated labels), then the user's existing custom tags (derived vocabulary), then a "Create '{typed}'" row. Enter adds (house convention). Respect the repo's known cmdk/Radix gotchas (stable item values; open overlays aria-hide the page in tests).
- Chip removal: X on each chip removes immediately via the carry-through PATCH — no confirm (recoverable by re-adding).

### Filtering (TAG-05)

- Filter UI: a toggleable chip row in the VOD Manager LIST panel, below the existing five dropdown filters. Wrap/scroll as needed.
- Semantics: OR within selected tags (match surfaces if it carries ANY selected tag), AND-composed with the existing dropdown filters and sort.
- Note tags reach the filter: a match surfaces if the MATCH or ANY OF ITS NOTES carries a selected tag.
- The chip row shows only tags actually in use across the user's VOD-bearing matches (presets with zero uses don't render); chips display preset labels via i18n, customs raw.

### Claude's Discretion

- Exact chip styling (reuse the app's badge/chip visual language), popover placement, and overflow behavior.
- The tag-slug ↔ display resolution helper's location (likely a shared lib in apps/web with the preset lists as named constants).
- Whether the filter chip row collapses when empty.

</decisions>

<code_context>

## Existing Code Insights

### Reusable Assets

- Full-carry-through PATCH plumbing from Phases 1-2: `buildUpdateInput` (VodNotesDialog), `matchFormValuesToInput` (MatchForm), `handleUpdateTimestamps` (VodManagerPage) — tag mutations are the same single-PATCH pattern.
- `SelectedMatchMeta.tsx` (Phase 2) — match-tag chips mount on its view state.
- `TimestampRow.tsx` (Phase 2) — note-tag chips mount under the note text.
- `vodManagerFilters.ts` + `VodMatchList.tsx` — the filter pipeline the tag chips extend.
- cmdk `Command` components (opponent combobox, stage favorites add) — the add-combobox analog.
- shadcn badge component (`components/ui/badge` if present) or the "Synced" badge styling in MatchTable.

### Established Patterns

- Schema evolution: optional field on `matchRecordSchema`/`vodTimestampSchema` + create/update input schemas (`packages/shared/src/match.ts`), conditional-spread in `apps/api/src/services/rtdb.ts` createMatch/updateMatch — exactly the `vodStartSeconds` playbook from 2026-07-10, including cherry-picking the shared+api commit to master for prod deploy BEFORE preview testing (preview channels hit the prod API; zod strips unknown keys silently).
- i18n ×6 with parity test; plural keys `_one`/`_other` where counts appear.
- Radix/cmdk testing gotchas documented in prior SUMMARYs.

### Integration Points

- `packages/shared/src/match.ts` (schema) + `apps/api/src/services/rtdb.ts` (passthrough) + `apps/api/src/routes/matches.test.ts` (tests) — the ONLY API-side touch, mirroring vodStartSeconds.
- Web: VodManagerPage detail panel (match chips via SelectedMatchMeta, note chips via TimestampRow), list panel (filter chips), new shared `apps/web/src/lib/tags.ts` (presets, normalization, vocabulary derivation, filter predicate).

</code_context>

<specifics>
## Specific Ideas

- Preset lists are FIXED by the requirements (TAG-03/04) — ship exactly those two lists.
- Deploy note for execution/ship: the schema passthrough commit must reach master + prod API (rev 00034) before the phase's preview-channel human check, or tag writes will silently vanish (learned twice on 2026-07-10).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
