# Phase 3: Tags - Pattern Map

**Mapped:** 2026-07-13
**Files analyzed:** 8 (3 API-side touches, 5 web-side new/modified files)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File                                                                                         | Role                | Data Flow                    | Closest Analog                                                                                                                                                                     | Match Quality |
| --------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/shared/src/match.ts` (add `tags`/`vodTimestamp.tags`)                                           | model (Zod schema)  | CRUD                         | same file, `vodStartSeconds` field (2026-07-10)                                                                                                                                    | exact         |
| `apps/api/src/services/rtdb.ts` (`createMatch`/`updateMatch` passthrough)                                 | service             | CRUD                         | same file, `vodTimestamps`/`vodStartSeconds` conditional-spread lines                                                                                                              | exact         |
| `apps/api/src/routes/matches.test.ts` (new tag test cases)                                                | test                | request-response             | same file, `vodStartSeconds` test blocks (lines 244-314, 561-690)                                                                                                                  | exact         |
| `apps/web/src/lib/tags.ts` (new)                                                                          | utility             | transform                    | `packages/shared/src/stageFavorites.ts` (`.default([])` array-read lesson) + `apps/web/src/pages/MatchData/lib/matchTableFilters.ts` (vocabulary/options derivation)               | role-match    |
| `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx` (add match-tag chips)                    | component           | request-response             | same file (already has view/edit split, Badge usage)                                                                                                                               | exact         |
| `apps/web/src/pages/VodManager/components/TimestampRow.tsx` (add note-tag chips)                          | component           | request-response             | same file (already has view/edit split, chip-adjacent controls)                                                                                                                    | exact         |
| `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts` (add tag filter) + `VodMatchList.tsx` (chip row) | utility + component | transform / request-response | same two files (existing filter-composition pipeline)                                                                                                                              | exact         |
| New tag add-combobox (shared between match/note tag adders)                                               | component           | request-response             | `apps/web/src/pages/Profile/components/FavoriteStagesCard.tsx` (Popover+Command add-affordance) and `apps/web/src/pages/VodManager/components/VodMatchList.tsx`'s `FilterCombobox` | role-match    |

## Pattern Assignments

### `packages/shared/src/match.ts` — add `tags: z.array(z.string()...).optional()` to `vodTimestampSchema`, `matchRecordSchema`, `createMatchInputSchema`/`updateMatchInputSchema`

**Analog:** same file, `vodStartSeconds` (schema-evolution playbook explicitly named in CONTEXT.md).

**Field pattern to copy** (lines 151, 160, 268-269):

```typescript
/**
 * User-authored VOD timestamp notes (V7-E) ...
 */
vodTimestamps: z.array(vodTimestampSchema).max(20).optional(),
...
vodStartSeconds: z.number().int().nonnegative().optional(),
```

Copy this shape for `tags` on THREE places: `vodTimestampSchema` (note-level, max 5), `matchRecordSchema` (match-level, max 10), and BOTH `createMatchInputSchema`/`updateMatchInputSchema` (`updateMatchInputSchema = createMatchInputSchema`, so one edit covers both). Use:

```typescript
tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(), // match-level
tags: z.array(z.string().trim().min(1).max(24)).max(5).optional(),  // note-level, inside vodTimestampSchema
```

Add a doc comment following the `vodStartSeconds` comment style — reference "TAG-01..05", explain the embedded-array/no-registry rationale, and note the RTDB-drops-empty-arrays caveat (mirrors `stageFavorites.ts`'s `.default([])` reasoning, though here `.optional()` not `.default([])` is correct because `matchRecordSchema`/`vodTimestampSchema` are READ schemas over records that predate the field — `stageFavoritesSchema` uses `.default([])` because it's a single always-present document, not an evolving per-record optional field like every other match field here).

**Do NOT use `.default([])` on `matchRecordSchema.tags`** — every other optional array/scalar field on this schema (`vodTimestamps`, `stocksLeft`, etc.) is `.optional()`, not defaulted, because absence is a meaningful, valid state (legacy/pre-tag records). `.default([])` is reserved for the `stageFavoritesSchema` document-level case where the field is conceptually always "the current list, possibly empty" rather than "present or absent."

### `apps/api/src/services/rtdb.ts` — `createMatch`/`updateMatch` conditional-spread

**Analog:** same file, `vodTimestamps`/`vodStartSeconds` lines (140-176, 178-230).

**Core pattern to copy** (createMatch, line 159-161 style; updateMatch, line 217-220 style):

```typescript
...(input.vodTimestamps !== undefined ? { vodTimestamps: input.vodTimestamps } : {}),
...(input.vodStartSeconds !== undefined ? { vodStartSeconds: input.vodStartSeconds } : {}),
```

Add `...(input.tags !== undefined ? { tags: input.tags } : {})` to the record-building object in BOTH `createMatch` and `updateMatch`, in the same position (grouped with the other user-editable annotation fields). Since `tags` lives on `matchRecordSchema` as well as `vodTimestampSchema`, no separate top-level handling for note-tags is needed — note tags travel inside the `vodTimestamps` array elements, which are already passed through wholesale (`input.vodTimestamps` is the full array, so `tags` on each timestamp element is captured automatically once the schema accepts it — no rtdb.ts change needed for note-level tags beyond what already exists for `vodTimestamps`).

**Full-overwrite clearing semantics comment to copy** (line 208-212 style): extend the existing comment listing `opponent/vodUrl/vodTimestamps/vodStartSeconds/gsp` to also say `/tags` — "Omitting tags from the input is how a caller clears all match tags, since this is a full overwrite."

### `apps/api/src/routes/matches.test.ts` — new tag test cases

**Analog:** same file, `vodStartSeconds` test blocks.

**Pattern to copy** (lines 275-314 style, adapted):

```typescript
it('accepts and stores tags', async () => {
  const app = await buildTestApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/matches',
    headers: authHeaders(),
    payload: { ...baseCreatePayload, tags: ['practice-friendlies', 'my custom tag'] },
  });
  expect(response.json()).toMatchObject({ tags: ['practice-friendlies', 'my custom tag'] });
  const stored = /* read raw RTDB fixture */;
  expect(stored).toMatchObject({ tags: ['practice-friendlies', 'my custom tag'] });
});

it('omits tags from the stored record when not provided', async () => {
  // mirrors lines 298-314: create without tags, assert `.not.toHaveProperty('tags')`
});
```

Also mirror the update-side pattern (lines 629-656: "clears X when omitted from the update payload") for tags — create with tags, PATCH without tags, assert the stored record no longer has `tags`. This is the RTDB-drops-empty-arrays behavior CONTEXT.md calls out — write a test that PATCHes with `tags: []` explicitly (not omitted) and asserts the read-back also lacks the key, confirming RTDB's empty-array-drop rather than relying on `.optional()` semantics alone.

---

### `apps/web/src/lib/tags.ts` (new file)

**Analogs:**

- `packages/shared/src/stageFavorites.ts` for the `.default([])`-read lesson (documented above — NOT directly reused here since `tags` stays `.optional()`, but the derived-vocabulary-at-read-time pattern below borrows from how `FavoriteStagesCard.tsx` filters `alphaStageList` against `stageIds` to compute `addableStages`).
- `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts`'s `getVodManagerFilterOptions` for the "derive a sorted/deduped list from all loaded matches" shape (lines 37-49):

```typescript
export function getVodManagerFilterOptions(matches: Match[]) {
  const opponents = new Set<string>();
  for (const match of matches) {
    if (match.opponent) {
      opponents.add(match.opponent);
    }
  }
  return {
    ...getMatchTableFilterOptions(matches),
    opponents: [...opponents].sort((a, b) => a.localeCompare(b)),
  };
}
```

Copy this exact `Set` + `sort` + iterate-all-matches shape for `deriveCustomTagVocabulary(matches: Match[])` — iterate `match.tags` AND every `match.vodTimestamps[].tags`, add to a `Set<string>`, sort, and (per CONTEXT.md) case-insensitive-dedupe against the preset display labels before returning.

**Constants pattern:** model the preset lists as `as const` arrays + a `z.enum(...)`-style union, following `matchTypeValues`/`matchTypeSchema` in `packages/shared/src/match.ts` (lines 12-21):

```typescript
export const matchTypeValues = ['none', 'quickplay', ...] as const;
export const matchTypeSchema = z.enum(matchTypeValues);
export type MatchType = z.infer<typeof matchTypeSchema>;
```

Mirror this for `MATCH_PRESET_TAGS`/`NOTE_PRESET_TAGS` as plain `as const` string-slug arrays in `apps/web/src/lib/tags.ts` (no Zod needed on the web side since these aren't parsed from user input at this layer — validation of custom-tag shape, if any, belongs to the shared package's schema constraints already covering `max(24)`/`max(10)`/`max(5)`).

**i18n resolution helper:** follow the `tournamentLabel(match)` pattern from `apps/web/src/pages/MatchData/lib/matchTableFilters.ts` (imported and used directly in `SelectedMatchMeta.tsx` line 9/162) — a small pure function `tagLabel(t: TFunction, slug: string): string` that returns `t('tags.preset.' + slug)` for preset slugs and the raw string for customs (i.e., `PRESET_SLUGS.has(slug) ? t(...) : slug`).

---

### `apps/web/src/pages/VodManager/components/SelectedMatchMeta.tsx` — match-tag chips on VIEW state

**Analog:** same file's own view-state block (lines 125-177) and its `Badge` usage (line 132-140) for the "Synced" badge.

**Chip pattern to copy** (Badge usage, lines 132-140):

```typescript
{match.source != null && (
  <Badge variant="outline" title={...}>
    {t('matchData.table.synced')}
  </Badge>
)}
```

Render `match.tags?.map(tag => <Badge key={tag} variant="secondary">{tagLabel(t, tag)}</Badge>)` inside the view-state `<div className="flex items-center gap-2">` header row or as a new row beneath the `<dl>` — NOT gated behind `mode === 'edit'` (CONTEXT.md: chips + add affordance live on the VIEW state, editable even for synced matches). Add an X button per chip (icon-sm `Button` + `X` from `lucide-react`, same as `TimestampRow.tsx`'s pencil/trash icon-button pattern, lines 192-209) that PATCHes immediately via `useUpdateMatch` (same hook `SelectedMatchMeta` already imports, line 8) with `tags` filtered to remove that one entry — full-overwrite carry-through of all other fields, matching `onSubmit`'s existing `updateMatch.mutateAsync({ id: match.id, input })` call shape (lines 79-85).

**"+" add affordance:** opens the shared add-combobox (see below), seeded with `MATCH_PRESET_TAGS`.

---

### `apps/web/src/pages/VodManager/components/TimestampRow.tsx` — note-tag chips under note text

**Analog:** same file's view-mode block (lines 176-191) and icon-button siblings (192-209).

Render tag chips (same `Badge variant="secondary"` treatment) in a new line under `<span className="truncate">{stamp.note}</span>` (line 190), OUTSIDE the seek `<button>` so chip clicks/removal don't trigger `onSeek`/`onSelect` (mirrors the existing "pencil/trash affordances are siblings that never call onSeek/onSelect" doc comment, lines 47-54). The "+" affordance and each chip's X call back up to the parent (`VodManagerPage`/`TimestampList`, whichever owns `handleUpdateTimestamps`) the same way `onCommitEdit`/`onDelete` already do — add an `onUpdateTags: (index: number, tags: string[]) => void` prop following the existing `onCommitEdit(index, next: VodTimestamp)` signature shape (line 39).

---

### `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts` + `VodMatchList.tsx` — tag filter chip row

**Analog:** same two files' existing filter-composition + option-derivation pipeline.

**State shape to extend** (lines 15-29):

```typescript
export interface VodManagerFilterState {
  fighter: string;
  opponentFighter: string;
  stage: string;
  tournament: string;
  opponent: string;
}
export const DEFAULT_VOD_MANAGER_FILTERS: VodManagerFilterState = { ... };
```

Add `tags: string[]` (default `[]`, NOT the `ALL_FILTER_VALUE` sentinel used by the single-select dropdowns — this is a multi-select chip toggle, so empty array = no tag filter applied, matching the OR-within/AND-across semantics from CONTEXT.md).

**Filter-application pattern to copy** (lines 57-70):

```typescript
export function applyVodManagerFilters(matches: Match[], filters: VodManagerFilterState): Match[] {
  const delegated = applyMatchTableFilters(matches, { ... });
  if (filters.opponent === ALL_FILTER_VALUE) {
    return delegated;
  }
  return delegated.filter((match) => match.opponent === filters.opponent);
}
```

AND-compose a tag filter after the existing `delegated` filtering, using the OR-within-tags/match-or-any-note semantics from CONTEXT.md:

```typescript
if (filters.tags.length === 0) {
  return delegated;
}
return delegated.filter((match) => {
  const matchTags = match.tags ?? [];
  const noteTags = (match.vodTimestamps ?? []).flatMap((ts) => ts.tags ?? []);
  const allTags = [...matchTags, ...noteTags];
  return filters.tags.some((selected) => allTags.includes(selected));
});
```

**Options-derivation pattern to copy** (lines 37-49, `getVodManagerFilterOptions`): add a `tagsInUse: string[]` field computed the same `Set` + iterate-all-matches + sort way, iterating both `match.tags` and note tags (CONTEXT.md: "chips shows only tags actually in use ... presets with zero uses don't render").

**Chip row UI:** new component in `VodMatchList.tsx` below the existing five `FilterSelect`/`FilterCombobox` controls (after line 115's sort `<Select>`), a toggleable `Badge`-per-tag row — reuse `Badge` (`variant={selected ? 'default' : 'outline'}`) as a clickable toggle (`asChild` + `<button>` or `onClick` directly on the span since `Badge` forwards props) rather than introducing a new visual component, per CONTEXT.md's discretion note "reuse the app's badge/chip visual language."

---

### Tag add-combobox (new, shared between `SelectedMatchMeta` and `TimestampRow`)

**Analogs:**

- `apps/web/src/pages/Profile/components/FavoriteStagesCard.tsx` (lines 84-127) — the closest full Popover+Command "add from a list, mutate on select" shape:

```typescript
<Popover open={addOpen} onOpenChange={setAddOpen}>
  <PopoverTrigger asChild>
    <Button type="button" variant="outline" role="combobox" aria-label={...} aria-expanded={addOpen} className="justify-between font-normal">
      {t('...add')}
      <ChevronsUpDown className="opacity-50" />
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
    <Command>
      <CommandInput placeholder={...} />
      <CommandList>
        <CommandEmpty>{t('...noStage')}</CommandEmpty>
        <CommandGroup>
          {addableStages.map((stage) => (
            <CommandItem key={stage.id} value={`${stage.name} ${stage.id}`} onSelect={() => { save([...stageIds, stage.id]); setAddOpen(false); }}>
              <StageOption stage={stage} />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

- `VodMatchList.tsx`'s `FilterCombobox` (lines 215-268) for the `Check`-marker/`cn` selected-state idiom and stable `CommandItem` `value` convention (`value={option}`, deduped since option lists are already unique).

**Gap — no freeform-create precedent exists in the codebase.** Every existing `Command`/`CommandItem` list in this repo (stage favorites, opponent merge picker, VOD filter comboboxes) is a closed, pre-known option list — none of them has a "Create '{typed}'" row for arbitrary user text. Build this fresh: track `CommandInput`'s typed value via `onValueChange` (cmdk's controlled-input pattern — check `apps/web/src/components/ui/command.tsx` for whether `CommandInput` already forwards `onValueChange`, otherwise lift local state), and conditionally render a trailing `CommandItem` (`value="__create__"` fixed sentinel — the STABLE ITEM VALUES gotcha CONTEXT.md calls out: dynamic values keyed on typed text can break cmdk's internal selection tracking, so use a stable literal value and read the typed text from closure/state in `onSelect`, not from `value`) reading `t('tags.combobox.create', { tag: typedValue })` when `typedValue` is non-empty and doesn't already match a preset/custom item.

**Ordering per CONTEXT.md:** `CommandGroup` 1 = preset tags (translated labels via `tagLabel`), `CommandGroup` 2 = derived custom-tag vocabulary (raw), then the "Create" row as a third group or trailing item — filter both groups' items by the current `CommandInput` search text (cmdk does this automatically via its built-in fuzzy filter on `value`, matching `FavoriteStagesCard`'s reliance on cmdk's default filtering rather than manual `.filter()`).

**Enter-adds convention:** `onSelect` fires on Enter for the highlighted `CommandItem` — no custom keydown handler needed, matching every existing combobox in the codebase (none of them intercept Enter manually; cmdk's default behavior already does this).

## Shared Patterns

### Conditional-spread + optional-field schema evolution

**Source:** `packages/shared/src/match.ts` (`vodStartSeconds`/`vodTimestamps`), `apps/api/src/services/rtdb.ts` (createMatch/updateMatch)
**Apply to:** `packages/shared/src/match.ts` tags fields, `apps/api/src/services/rtdb.ts` tags passthrough

```typescript
...(input.tags !== undefined ? { tags: input.tags } : {}),
```

Omitting the field is how a caller clears it (full-overwrite `.set()` semantics, not partial PATCH) — the web side must send `tags: undefined` (i.e., omit the key) rather than `tags: []` when clearing all tags, though both should behave correctly given RTDB drops empty arrays either way per CONTEXT.md.

### Badge/chip visual language

**Source:** `apps/web/src/components/ui/badge.tsx`
**Apply to:** `SelectedMatchMeta.tsx`, `TimestampRow.tsx`, `VodMatchList.tsx` chip row, add-combobox rendering

```typescript
<Badge variant="secondary">{tagLabel(t, tag)}</Badge>
```

`variant="outline"` is already used for the "Synced" badge; use `variant="secondary"` for tag chips to visually distinguish them, and toggle `default`/`outline` for the filter row's selected/unselected states.

### Popover + Command add-combobox

**Source:** `apps/web/src/pages/Profile/components/FavoriteStagesCard.tsx`, `apps/web/src/pages/VodManager/components/VodMatchList.tsx`'s `FilterCombobox`
**Apply to:** new shared tag add-combobox component (mounted from both `SelectedMatchMeta.tsx` and `TimestampRow.tsx`)
See full excerpt above. Watch the two documented cmdk/Radix gotchas referenced in CONTEXT.md: stable `CommandItem` `value`s (don't key off typed/dynamic text), and open overlays `aria-hide` the rest of the page in tests (prior SUMMARYs — check `apps/web/src/pages/Profile/components/FavoriteStagesCard.test.tsx` or `VodMatchList.test.ts` if present for the established `within(document.body)`/portal query workaround).

### Filter-pipeline composition

**Source:** `apps/web/src/pages/VodManager/lib/vodManagerFilters.ts`
**Apply to:** tag filter addition to `applyVodManagerFilters`/`getVodManagerFilterOptions`, consumed by `VodManagerPage` the same way the existing five filters are (already wired via `useMemo`-derived `filteredMatches` — check `VodManagerPage.tsx` for the exact call site before adding the new filter dimension).

## No Analog Found

| File                                     | Role      | Data Flow        | Reason                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freeform "Create '{typed}'" combobox row | component | event-driven     | No existing cmdk combobox in the codebase supports arbitrary user-typed creation; every existing one (stage favorites, opponent merge, VOD filters) is a closed pre-known list. Built fresh per the Pattern Assignments section above, borrowing structure (not the creation logic) from `FavoriteStagesCard.tsx`/`FilterCombobox`. |
| Multi-select toggle filter chip row      | component | request-response | Existing VOD Manager filters are all single-select (`Select`/`FilterCombobox`); the tag row is the first multi-select AND/OR-composed filter dimension. Built fresh using `Badge`-as-toggle, structured like the existing `FilterSelect`/`FilterCombobox` wrapper divs for label placement consistency.                             |

## Metadata

**Analog search scope:** `packages/shared/src/`, `apps/api/src/services/rtdb.ts`, `apps/api/src/routes/matches.test.ts`, `apps/web/src/pages/VodManager/`, `apps/web/src/pages/Profile/components/FavoriteStagesCard.tsx`, `apps/web/src/pages/Opponents/components/MergeOpponentDialog.tsx`, `apps/web/src/components/ui/badge.tsx`, `apps/web/src/components/ui/command.tsx`
**Files scanned:** ~14
**Pattern extraction date:** 2026-07-13
