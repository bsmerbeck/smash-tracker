import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { tagLabel } from '@/lib/tags';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Fixed sentinel `CommandItem` value for the "Create '{typed}'" row — MUST
// NOT be keyed off the typed text itself. cmdk tracks selection by item
// `value`; a dynamic value that changes on every keystroke breaks its
// internal selection-highlight tracking (the documented STABLE ITEM VALUES
// gotcha). The typed text is read from `search` state inside `onSelect`,
// never from the item's `value`.
const CREATE_ITEM_VALUE = '__create__';

/**
 * Shared preset → custom → create tag-add combobox (TAG-01..05), mounted
 * from `SelectedMatchMeta` (match tags) and `TimestampRow` (note tags, 03-03).
 * Manual filtering (`shouldFilter={false}` on `Command`) rather than cmdk's
 * built-in fuzzy filter: the built-in filter matches against each item's
 * `value`, which for presets is the raw SLUG, not its translated display
 * label — typing the visible label text would filter out the very item
 * showing it. It would also filter the Create row's stable sentinel value
 * out of existence the moment any text is typed. Filtering here instead,
 * against `tagLabel(t, slug)`/the raw custom string, keeps both correct.
 */
export function TagAddCombobox({
  presets,
  existingTags,
  vocabulary,
  onAdd,
  ariaLabel,
}: {
  presets: readonly string[];
  existingTags: string[];
  vocabulary: string[];
  onAdd: (tag: string) => void;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const existingLower = existingTags.map((tag) => tag.toLowerCase());
  const trimmedSearch = search.trim();
  const searchLower = trimmedSearch.toLowerCase();

  // Preset labels resolved via tags.preset.<slug> (see `tagLabel`).
  const availablePresets = presets.filter((slug) => !existingLower.includes(slug.toLowerCase()));
  const filteredPresets = availablePresets.filter(
    (slug) => searchLower === '' || tagLabel(t, slug).toLowerCase().includes(searchLower),
  );

  const availableVocabulary = vocabulary.filter(
    (tag) => !existingLower.includes(tag.toLowerCase()),
  );
  const filteredVocabulary = availableVocabulary.filter(
    (tag) => searchLower === '' || tag.toLowerCase().includes(searchLower),
  );

  const matchesPresetLabel = presets.some(
    (slug) => tagLabel(t, slug).toLowerCase() === searchLower,
  );
  const matchesKnownTag =
    vocabulary.some((tag) => tag.toLowerCase() === searchLower) ||
    existingLower.includes(searchLower);
  const showCreate = trimmedSearch !== '' && !matchesPresetLabel && !matchesKnownTag;

  function reset() {
    setSearch('');
    setOpen(false);
  }

  function handleAdd(tag: string) {
    onAdd(tag);
    reset();
  }

  function handleCreate() {
    // A custom tag that normalizes onto a preset slug's display label
    // dedupes onto the preset (CONTEXT.md) — add the SLUG, not the raw text.
    const matchingPreset = presets.find((slug) => tagLabel(t, slug).toLowerCase() === searchLower);
    handleAdd(matchingPreset ?? trimmedSearch);
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : reset())}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
        >
          <Plus />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-48 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('tags.combobox.placeholder')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {filteredPresets.length === 0 && filteredVocabulary.length === 0 && !showCreate && (
              <CommandEmpty>{t('tags.combobox.empty')}</CommandEmpty>
            )}
            {filteredPresets.length > 0 && (
              <CommandGroup>
                {filteredPresets.map((slug) => (
                  <CommandItem key={slug} value={slug} onSelect={() => handleAdd(slug)}>
                    {tagLabel(t, slug)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {filteredVocabulary.length > 0 && (
              <CommandGroup>
                {filteredVocabulary.map((tag) => (
                  <CommandItem key={tag} value={tag} onSelect={() => handleAdd(tag)}>
                    {tag}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showCreate && (
              <CommandGroup>
                <CommandItem value={CREATE_ITEM_VALUE} onSelect={handleCreate}>
                  {t('tags.combobox.create', { tag: trimmedSearch })}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
