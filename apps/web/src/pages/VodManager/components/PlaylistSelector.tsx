import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import type { Playlist } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Fixed sentinel `CommandItem` values — MUST NOT be keyed off display text.
// cmdk tracks selection by item `value`; existing-playlist rows use the
// playlist `id` (stable, never the display name — a rename must not break
// cmdk's internal selection-highlight tracking).
const LIBRARY_ITEM_VALUE = '__library__';
const CREATE_ITEM_VALUE = '__create-playlist__';

/**
 * Compact control atop the VOD Manager list panel (LIST-01/LIST-03): a
 * Popover+Command combobox (mirrors `TagAddCombobox`'s shape) listing
 * "Library" (the default, unfiltered view) plus the user's named playlists,
 * with an inline "+ New playlist" create row reusing the same `CommandInput`
 * text as the candidate name. `shouldFilter={false}` — manual, since the
 * input doubles as the create-name field rather than cmdk's built-in filter.
 */
export function PlaylistSelector({
  playlists,
  selectedPlaylistId,
  onSelect,
  onCreate,
  creating,
}: {
  playlists: Playlist[];
  selectedPlaylistId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  creating: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const trimmedName = name.trim();
  const canCreate = trimmedName.length >= 1 && trimmedName.length <= 40;

  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const triggerLabel = selectedPlaylist ? selectedPlaylist.name : t('vodManager.playlists.library');

  function reset() {
    setName('');
    setOpen(false);
  }

  function handleSelect(id: string | null) {
    onSelect(id);
    reset();
  }

  function handleCreate() {
    if (!canCreate) {
      return;
    }
    onCreate(trimmedName);
    setName('');
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : reset())}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={t('vodManager.playlists.selectAria')}
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('vodManager.playlists.createPlaceholder')}
            value={name}
            onValueChange={setName}
            maxLength={40}
          />
          <CommandList>
            <CommandGroup>
              <CommandItem
                value={LIBRARY_ITEM_VALUE}
                onSelect={() => handleSelect(null)}
                className={cn(
                  selectedPlaylistId === null &&
                    'bg-accent text-accent-foreground border-l-2 border-primary',
                )}
              >
                <Check className={cn(selectedPlaylistId === null ? 'opacity-100' : 'opacity-0')} />
                {t('vodManager.playlists.library')}
              </CommandItem>
              {playlists.map((playlist) => (
                <CommandItem
                  key={playlist.id}
                  value={playlist.id}
                  onSelect={() => handleSelect(playlist.id)}
                  className={cn(
                    selectedPlaylistId === playlist.id &&
                      'bg-accent text-accent-foreground border-l-2 border-primary',
                  )}
                >
                  <Check
                    className={cn(selectedPlaylistId === playlist.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="flex-1 truncate">{playlist.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('vodManager.playlists.matchCount', { count: playlist.matchIds.length })}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            {/* Always-visible create affordance (never gated on typed text)
                so the popover reads as "browse OR create", not a bare search
                box — before typing this shows a generic "+ New playlist"
                hint; once a name is typed it becomes the actionable
                "Create '{typed}'" row. Same stable sentinel `value` either
                way (cmdk selection tracking). */}
            <CommandGroup>
              <CommandItem
                value={CREATE_ITEM_VALUE}
                disabled={!canCreate || creating}
                onSelect={handleCreate}
              >
                <Plus className="size-4" />
                {trimmedName === ''
                  ? t('vodManager.playlists.newPlaylist')
                  : t('vodManager.playlists.createNamed', { name: trimmedName })}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
