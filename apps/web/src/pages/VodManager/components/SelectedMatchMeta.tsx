import type { RefObject } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link2, ListPlus, Plus, Share2, X } from 'lucide-react';
import {
  MAX_PLAYLISTS_PER_USER,
  type Fighter,
  type Match,
  type Playlist,
  type UpdateMatchInput,
} from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { formatTimestamp } from '@/lib/vod';
import { MATCH_PRESET_TAGS, addTagToList, removeTagFromList, tagLabel } from '@/lib/tags';
import { addMatchToPlaylistIds } from '@/lib/playlists';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import { useCreatePlaylist, useUpdatePlaylist } from '@/hooks/usePlaylists';
import { useVodShares } from '@/hooks/useVodShares';
import { buildUpdateInput } from '@/components/vod/VodNotesDialog';
import { tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TagAddCombobox } from './TagAddCombobox';
import { ShareDialog } from '@/pages/VodManager/ShareDialog';
import {
  MatchFormFields,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';
import { matchToFormValues } from '@/components/match-form/EditMatchForm';

const MAX_MATCH_TAGS = 10;

// Fixed sentinel `CommandItem` value for the "create new playlist" row — same
// stable-value rule as `TagAddCombobox`'s `CREATE_ITEM_VALUE`: cmdk tracks
// selection by item `value`, so this must never be keyed off the typed name.
const CREATE_PLAYLIST_ITEM_VALUE = '__create-playlist__';

/**
 * "Add to playlist" affordance (LIST-02) — rendered in `SelectedMatchMeta`'s
 * HEADER row, next to the match title (retest fix-up #8: previously sat
 * past the tags row at the bottom of the card, reading as buried rather
 * than the prominent affordance it's meant to be). Reuses `TagAddCombobox`'s
 * Popover+Command shape: existing playlists list as `CommandItem`s keyed by
 * playlist `id` (stable cmdk value, mirrors `PlaylistSelector`), plus a
 * "create new" row using the typed `CommandInput` text as the candidate
 * name. Adding is idempotent via `addMatchToPlaylistIds` — re-adding an
 * already-member match is a no-op PATCH that still resolves cleanly.
 */
function AddToPlaylistMenu({ playlists, matchId }: { playlists: Playlist[]; matchId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const updatePlaylist = useUpdatePlaylist();
  const createPlaylist = useCreatePlaylist();

  const trimmedSearch = search.trim();
  const searchLower = trimmedSearch.toLowerCase();
  const canCreate = trimmedSearch.length >= 1 && trimmedSearch.length <= 40;
  const isPending = updatePlaylist.isPending || createPlaylist.isPending;

  const filteredPlaylists = playlists.filter(
    (playlist) => searchLower === '' || playlist.name.toLowerCase().includes(searchLower),
  );

  function reset() {
    setSearch('');
    setOpen(false);
  }

  async function addToPlaylist(playlist: Playlist) {
    try {
      await updatePlaylist.mutateAsync({
        id: playlist.id,
        input: { matchIds: addMatchToPlaylistIds(playlist.matchIds, matchId) },
      });
      toast.success(t('vodManager.playlists.added'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
    reset();
  }

  async function handleCreateAndAdd() {
    if (!canCreate) {
      return;
    }
    try {
      const playlist = await createPlaylist.mutateAsync({ name: trimmedSearch });
      await updatePlaylist.mutateAsync({
        id: playlist.id,
        input: { matchIds: addMatchToPlaylistIds(playlist.matchIds, matchId) },
      });
      toast.success(t('vodManager.playlists.added'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast.error(t('vodManager.playlists.limitReached', { max: MAX_PLAYLISTS_PER_USER }));
      } else {
        toast.error(t('shared.vod.saveFailed'));
      }
    }
    reset();
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : reset())}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={t('vodManager.playlists.addToPlaylistAria')}
          aria-expanded={open}
          disabled={isPending}
        >
          <ListPlus className="size-4" />
          {t('vodManager.playlists.addToPlaylist')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-56 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('vodManager.playlists.createPlaceholder')}
            value={search}
            onValueChange={setSearch}
            maxLength={40}
          />
          <CommandList>
            {filteredPlaylists.length > 0 && (
              <CommandGroup>
                {filteredPlaylists.map((playlist) => (
                  <CommandItem
                    key={playlist.id}
                    value={playlist.id}
                    onSelect={() => addToPlaylist(playlist)}
                  >
                    {playlist.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmedSearch !== '' && (
              <CommandGroup>
                <CommandItem
                  value={CREATE_PLAYLIST_ITEM_VALUE}
                  disabled={!canCreate || isPending}
                  onSelect={handleCreateAndAdd}
                >
                  <Plus className="size-4" />
                  {t('vodManager.playlists.create')}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The VOD Manager's selected-match metadata card (NOTE-04). View mode
 * renders the original read-only `<dl>` block plus an Edit affordance;
 * clicking it swaps in the shared `MatchFormFields` (the same field set
 * `EditMatchForm` uses — no divergent second form) inline, right here in
 * the card — never a separate page or dialog. Save reuses
 * `matchFormValuesToInput` + the exact `vodTimestamps` carry-through
 * `EditMatchForm.onSubmit` uses, then PATCHes via `useUpdateMatch` and
 * returns to view mode; Cancel returns to view mode with no mutation.
 * `syncLocked` disables exactly the 9 sync-owned fields on a synced match
 * (see `MatchFormFields`'s `changesSyncOwnedFields` cross-reference);
 * notes/vodUrl/vodStartSeconds/gsp always stay editable. The
 * `vodStartSecondsAccessory` slot renders a "Use current player time"
 * button that reads the live position via `getCurrentTimeRef` (the ref
 * `VodPlayer` populates, plumbed all the way from 02-01) — a one-shot
 * read, never polled.
 */
export function SelectedMatchMeta({
  match,
  fighterSprites,
  getCurrentTimeRef,
  tagVocabulary,
  playlists,
  onOpenMyShares,
}: {
  match: Match;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  /** Populated by `VodPlayer` with the live player's `getCurrentTime` function once available. */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Custom tag vocabulary derived across ALL loaded VOD matches (03-02 locked decision) — fed into the match TagAddCombobox's "your existing custom tags" group. */
  tagVocabulary: string[];
  /** The signed-in user's playlists — fed into the "Add to playlist" menu (LIST-02). */
  playlists: Playlist[];
  /** Opens the page-level My shares dialog (ShareDialog created-step shortcut). */
  onOpenMyShares?: () => void;
}) {
  const { t } = useTranslation();
  const updateMatch = useUpdateMatch();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);

  // "Shared" indicator (SHARE-05) — client-side soft-orphan join against the
  // owner's full share list, mirroring `resolvePlaylistMatches`'s pattern:
  // a match "has an active share" the moment any of its issued shares is
  // still active, independent of which one.
  const sharesQuery = useVodShares();
  const hasActiveShare = (sharesQuery.data ?? []).some(
    (share) => share.matchId === match.id && share.status === 'active',
  );

  // requireOpponent: false — mirrors EditMatchForm: Quick Logger matches are
  // stored with `opponent: ''` (anonymous quickplay randoms) and must stay
  // editable without inventing a name.
  const form = useMatchForm(matchToFormValues(match), { requireOpponent: false });

  function handleEdit() {
    form.reset(matchToFormValues(match));
    setMode('edit');
  }

  function handleCancel() {
    setMode('view');
  }

  async function onSubmit(values: MatchFormValues) {
    // Full-overwrite PATCH — mirrors EditMatchForm.onSubmit exactly: carry
    // vodTimestamps through unless the VOD link was just cleared (offsets
    // into a video that no longer has a URL would otherwise be orphaned).
    // match.tags carries through UNCONDITIONALLY (no vodUrlBlank guard) —
    // match-level tags are independent annotations, not tied to the VOD
    // link, so clearing the VOD never drops them (TAG-01..05).
    const vodUrlBlank = values.vodUrl.trim() === '';
    const input: UpdateMatchInput = {
      ...matchFormValuesToInput(values),
      ...(!vodUrlBlank && match.vodTimestamps !== undefined
        ? { vodTimestamps: match.vodTimestamps }
        : {}),
      ...(match.tags !== undefined ? { tags: match.tags } : {}),
    };
    try {
      await updateMatch.mutateAsync({ id: match.id, input });
      toast.success(t('matchForm.edit.edited'));
      setMode('view');
    } catch {
      toast.error(t('matchForm.edit.saveFailed'));
    }
  }

  async function handleAddTag(tag: string) {
    const next = addTagToList(match.tags ?? [], tag, MAX_MATCH_TAGS);
    const input = buildUpdateInput(match, {
      vodUrl: match.vodUrl,
      vodTimestamps: match.vodTimestamps,
      tags: next.length > 0 ? next : undefined,
    });
    try {
      await updateMatch.mutateAsync({ id: match.id, input });
      toast.success(t('shared.vod.saved'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  async function handleRemoveTag(tag: string) {
    const next = removeTagFromList(match.tags ?? [], tag);
    const input = buildUpdateInput(match, {
      vodUrl: match.vodUrl,
      vodTimestamps: match.vodTimestamps,
      tags: next.length > 0 ? next : undefined,
    });
    try {
      await updateMatch.mutateAsync({ id: match.id, input });
      toast.success(t('shared.vod.saved'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  if (mode === 'edit') {
    return (
      <div className="flex flex-col gap-4 rounded-lg border p-4 text-sm">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <MatchFormFields
            form={form}
            fighterSprites={fighterSprites}
            syncLocked={match.source != null}
            vodStartSecondsAccessory={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  form.setValue(
                    'vodStartSeconds',
                    formatTimestamp(getCurrentTimeRef.current?.() ?? 0),
                  )
                }
              >
                {t('vodManager.useCurrentTime')}
              </Button>
            }
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleCancel}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={updateMatch.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
      {/* Retest fix-up #8: "Add to playlist" moved into this HEADER row,
          next to the match title, instead of being buried past the tags
          row at the bottom of the card — a visible icon+label button is
          the whole point of the affordance, so it needs to read as
          prominent from the moment the card renders. Same menu component/
          behavior as before, just relocated. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">
          vs. {match.opponent || t('common.unknown')}
        </h2>
        <div className="flex items-center gap-2">
          {match.source != null && (
            <Badge
              variant="outline"
              title={t('matchData.table.syncedTitle', {
                source: match.source === 'startgg' ? 'start.gg' : 'parry.gg',
              })}
            >
              {t('matchData.table.synced')}
            </Badge>
          )}
          {hasActiveShare && (
            <Badge variant="outline" title={t('vodManager.shares.sharedBadgeTooltip')}>
              <Link2 className="size-3" />
              {t('vodManager.shares.sharedBadge')}
            </Badge>
          )}
          <AddToPlaylistMenu playlists={playlists} matchId={match.id} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!match.vodUrl}
            title={!match.vodUrl ? t('vodManager.shares.requiresVod') : undefined}
            aria-label={t('vodManager.shares.shareButtonAria')}
            onClick={() => setShareDialogOpen(true)}
          >
            <Share2 className="size-4" />
            {t('vodManager.shares.shareButton')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleEdit}>
            {t('vodManager.meta.edit')}
          </Button>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-muted-foreground">
        <div>
          <dt className="text-xs">{t('vodManager.filters.fighter')}</dt>
          <dd className="text-foreground">{fighter?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.opponentFighter')}</dt>
          <dd className="text-foreground">{opponentFighter?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.stage')}</dt>
          <dd className="text-foreground">{match.map?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.tournament')}</dt>
          <dd className="text-foreground">{tournamentLabel(match)}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('matchData.table.columns.win')}</dt>
          <dd className="text-foreground">{match.win ? t('common.win') : t('common.loss')}</dd>
        </div>
        {match.vodStartSeconds !== undefined && (
          <div>
            <dt className="text-xs">{t('vodManager.startTime')}</dt>
            <dd className="text-foreground">{formatTimestamp(match.vodStartSeconds)}</dd>
          </div>
        )}
      </dl>
      {/* Match-tag chips (TAG-01..05) live on the VIEW state, NOT gated
          behind edit mode — tags are annotations, not sync-owned game
          facts, so they stay editable even on a synced match. */}
      <div className="flex flex-wrap items-center gap-2">
        {(match.tags ?? []).map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tagLabel(t, tag)}
            <button
              type="button"
              aria-label={t('tags.removeAria', { tag: tagLabel(t, tag) })}
              onClick={() => handleRemoveTag(tag)}
              disabled={updateMatch.isPending}
              className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <TagAddCombobox
          presets={MATCH_PRESET_TAGS}
          existingTags={match.tags ?? []}
          vocabulary={tagVocabulary}
          onAdd={handleAddTag}
          ariaLabel={t('tags.addAria')}
        />
      </div>
      <ShareDialog
        match={match}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        onViewShares={onOpenMyShares}
      />
    </div>
  );
}
