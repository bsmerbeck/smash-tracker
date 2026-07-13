import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SkipBack, SkipForward, Trash2 } from 'lucide-react';
import {
  MAX_PLAYLISTS_PER_USER,
  type Fighter,
  type Match,
  type VodTimestamp,
} from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import {
  useCreatePlaylist,
  useDeletePlaylist,
  usePlaylists,
  useUpdatePlaylist,
} from '@/hooks/usePlaylists';
import { detectVodProvider, parseVodStartSeconds } from '@/lib/vod';
import { deriveCustomTagVocabulary } from '@/lib/tags';
import { movePlaylistItem, resolvePlaylistMatches } from '@/lib/playlists';
import { ApiError } from '@/lib/api';
import { buildUpdateInput } from '@/components/vod/VodNotesDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DEFAULT_VOD_MANAGER_FILTERS,
  applyVodManagerFilters,
  getVodManagerFilterOptions,
  sortByRecency,
  type VodManagerFilterState,
  type VodSortDirection,
} from './lib/vodManagerFilters';
import { VodMatchList } from './components/VodMatchList';
import { VodPlayer } from './components/VodPlayer';
import { TimestampList } from './components/TimestampList';
import { SelectedMatchMeta } from './components/SelectedMatchMeta';
import { PlaylistSelector } from './components/PlaylistSelector';

/**
 * Resolves the second to start playback at for `match`'s VOD: the player's
 * own user-set `vodStartSeconds` (V-Manager fix-up #3 — lets one video shared
 * by several matches be typed once per match, no URL `t=` editing required)
 * takes precedence over whatever offset happens to be encoded in the stored
 * `vodUrl`'s `t=`/`start=` query param. Shared by both the initial player
 * mount (`startSeconds` prop) and the same-video-identity reposition effect
 * below so the two can never drift apart.
 */
function resolveMatchStartSeconds(match: Match): number {
  return match.vodStartSeconds ?? parseVodStartSeconds(match.vodUrl ?? '');
}

/**
 * `${provider}:${videoId}` identity key for `match`'s VOD, or `null` if it
 * has no VOD / an unrecognized host — mirrors the reposition effect's own
 * identity computation below and `useVodPlayer`'s internal `identityKey`,
 * so "same video" is judged identically everywhere in this component.
 */
function videoIdentityOf(match: Match): string | null {
  if (!match.vodUrl) {
    return null;
  }
  const detected = detectVodProvider(match.vodUrl);
  return detected.provider != null ? `${detected.provider}:${detected.videoId}` : null;
}

/**
 * `/vod` — the VOD Manager: a master-detail page listing every match with a
 * VOD attached (LIB-01), filterable/sortable (LIB-02) in the left panel,
 * with the right panel showing the embedded, seekable player (PLAY-01/02),
 * the click-to-seek timestamp list directly below it (PLAY-03, D-03), and
 * the selected match's read-only metadata.
 *
 * Selection is URL-driven (`?match=<id>`, `useSearchParams` — the single
 * source of truth per ARCHITECTURE.md): selecting a list row updates the
 * URL, and `/vod?match=<id>` deep-links directly into that match. On
 * cold-open (no `?match=` yet, D-04) the most-recent VOD match is
 * auto-selected via a replace navigation so the panel is never empty on
 * entry with at least one VOD-having match.
 */
export function VodManagerPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedMatchId = searchParams.get('match');
  // Sibling param to `?match=` — a playlist can be active with no match
  // selected, and Library (browsing all VOD matches) has no playlist. Never
  // conflate the two selections.
  const selectedPlaylistId = searchParams.get('playlist');

  const { matches, isLoading } = useFilteredMatches();
  const vodMatches = useMemo(() => matches.filter((m) => m.vodUrl != null), [matches]);

  const { data: playlists = [] } = usePlaylists();
  const createPlaylist = useCreatePlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const selectedPlaylist = useMemo(
    () => playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? null,
    [playlists, selectedPlaylistId],
  );
  // Resolved against `vodMatches` (every VOD-bearing match the caller owns,
  // T-04-05's client-side soft-orphan join) rather than the locally-filtered
  // list — filters are hidden while a playlist is active (D- per CONTEXT),
  // so playlist order is unaffected by whatever the filter controls were
  // last set to.
  const playlistMatches = useMemo(
    () => (selectedPlaylist ? resolvePlaylistMatches(selectedPlaylist, vodMatches) : null),
    [selectedPlaylist, vodMatches],
  );
  // The selected match's position within playlistMatches (`-1` if no
  // playlist is active or the selection isn't in it) — drives the Prev/Next
  // boundary disable state and the "N of M" indicator (Task 3).
  const playlistMatchIndex = useMemo(
    () => (playlistMatches ? playlistMatches.findIndex((m) => m.id === selectedMatchId) : -1),
    [playlistMatches, selectedMatchId],
  );

  // Custom tag vocabulary (TAG-01..05) spans ALL loaded VOD-bearing matches
  // (locked decision, 03-CONTEXT.md) — not just the currently filtered/
  // selected one — so the add-combobox always offers every custom tag the
  // user has ever typed, reused by 03-03's note-tag combobox too.
  const tagVocabulary = useMemo(() => deriveCustomTagVocabulary(vodMatches), [vodMatches]);

  // Fighters offered by the inline edit form's "Your Fighter" select
  // (NOTE-04) — same primary+secondary sprite lookup MatchDataPage uses.
  const { data: fighterSelection } = useFighters();
  const fighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  const [filters, setFilters] = useState<VodManagerFilterState>(DEFAULT_VOD_MANAGER_FILTERS);
  const [sort, setSort] = useState<VodSortDirection>('newest');
  const [selectedTimestampIndex, setSelectedTimestampIndex] = useState<number | null>(null);
  // Lifted from `TimestampList` (Task 1) so the quick-tag panel's capture
  // handler can command a freshly-inserted row straight into edit mode once
  // the PATCH resolves and the new sorted array position is known.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Set by handleAutoplayBlocked (LIST-04) whenever the browser blocks an
  // auto-advance attempt — surfaces the native play-button fallback hint
  // (Task 3). Reset alongside selectedTimestampIndex below: a blocked flag
  // from the PREVIOUS video must never carry over to a newly selected one.
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // A new match starts with no timestamp note selected — the highlight is
  // fixed to the last click (D-13/D-14), not carried over between matches.
  // React's "adjusting state when a prop changes" pattern (reset during
  // render, not an effect) so switching matches never flashes a stale
  // selection from the previous match before an effect gets a chance to run.
  const [trackedMatchId, setTrackedMatchId] = useState(selectedMatchId);
  if (selectedMatchId !== trackedMatchId) {
    setTrackedMatchId(selectedMatchId);
    setSelectedTimestampIndex(null);
    setAutoplayBlocked(false);
    // A row editing on the PREVIOUS match must never carry over either.
    setEditingIndex(null);
  }

  // Inline rename draft for the active playlist's selector row — re-seeded
  // from the playlist's current name whenever the SELECTED PLAYLIST ID
  // changes (same "adjusting state when a prop changes" reset-during-render
  // pattern as `trackedMatchId` above), never on every render (which would
  // otherwise clobber in-progress typing on invalidation-driven refetches).
  const [trackedPlaylistId, setTrackedPlaylistId] = useState(selectedPlaylistId);
  const [renameDraft, setRenameDraft] = useState(selectedPlaylist?.name ?? '');
  if (selectedPlaylistId !== trackedPlaylistId) {
    setTrackedPlaylistId(selectedPlaylistId);
    setRenameDraft(selectedPlaylist?.name ?? '');
  }
  const [confirmingDeletePlaylist, setConfirmingDeletePlaylist] = useState(false);

  const filterOptions = useMemo(() => getVodManagerFilterOptions(vodMatches), [vodMatches]);
  const filtered = useMemo(() => {
    return sortByRecency(applyVodManagerFilters(vodMatches, filters), sort);
  }, [vodMatches, filters, sort]);

  // The list the panel actually renders: a playlist's matches (in playlist
  // order, soft-orphan skipped) when one is selected, else the normal
  // filter/sort pipeline's result.
  const displayedMatches = playlistMatches ?? filtered;

  // D-04 cold-open: once loaded, with nothing deep-linked/clicked yet and at
  // least one VOD match available, auto-select the most-recent one via a
  // replace navigation so the back button doesn't get stuck on an empty
  // intermediate URL.
  useEffect(() => {
    if (isLoading || selectedMatchId != null || displayedMatches.length === 0) {
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('match', displayedMatches[0]!.id);
        return next;
      },
      { replace: true },
    );
  }, [isLoading, selectedMatchId, displayedMatches, setSearchParams]);

  // T-01-04: an unknown/stale ?match= id resolves to null rather than
  // throwing — the right panel just falls back to the placeholder copy.
  const selectedMatch = displayedMatches.find((m) => m.id === selectedMatchId) ?? null;

  // Populated by VodPlayer once its live player instance exists; invoking
  // it is how TimestampList's row clicks reach the LIVE player (not a URL
  // reload — PITFALLS.md Pitfall 1).
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null);

  // Populated by VodPlayer once its live player instance exists; invoking it
  // is how NoteComposer's on-focus prefill reads the LIVE playback position
  // (a one-shot read, never polled — D-14 / CONTEXT.md's no-polling rule).
  const getCurrentTimeRef = useRef<(() => number) | null>(null);

  // LIST-04: single-use autoplay-intent flag (RESEARCH.md Open Question 2).
  // Set to `true` ONLY by handleEnded's cross-identity branch, immediately
  // before the setSearchParams call that triggers useVodPlayer's identity-
  // keyed remount — that remount reads this value (passed down as the
  // `autoplayOnConstruct` prop) via closure-capture at construction. Every
  // OTHER selection path (manual row click, Prev/Next, deep-link, cold-
  // open) leaves this `false`, so only an ENDED-triggered advance ever
  // autoplays. Reset back to `false` by the effect below, keyed on
  // selectedMatch identity, so a subsequent manual selection never
  // inherits a stale autoplay intent.
  const autoplayNextRef = useRef(false);

  const updateMatch = useUpdateMatch();

  // An entire event can be recorded as ONE video with each match's stored
  // vodUrl carrying its own `?t=` offset into it — switching between two
  // such matches shares the same video IDENTITY, so `useVodPlayer`
  // intentionally does NOT remount the underlying player (see its docs) and
  // therefore never re-applies `startSeconds` on its own. Reposition the
  // live player manually whenever the identity is unchanged; a genuine
  // identity change is already handled by the remount applying the new
  // match's `startSeconds` at construction time. Deliberately keyed on the
  // `selectedMatch` OBJECT (not `selectedMatchId`) — `filtered`/`selectedMatch`
  // stay referentially stable across unrelated re-renders (memoized in
  // `useFilteredMatches`/above), so this only fires on an actual match
  // switch OR the initial data-load transition from `null` to the
  // deep-linked match — never on incidental re-renders.
  const previousVodIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedMatch?.vodUrl) {
      previousVodIdentityRef.current = null;
      return;
    }
    const detected = detectVodProvider(selectedMatch.vodUrl);
    const identityKey =
      detected.provider != null ? `${detected.provider}:${detected.videoId}` : null;
    if (identityKey != null && identityKey === previousVodIdentityRef.current) {
      playerSeekRef.current?.(resolveMatchStartSeconds(selectedMatch));
    }
    previousVodIdentityRef.current = identityKey;
  }, [selectedMatch]);

  // Single-use reset for autoplayNextRef (see its declaration above).
  // Declared AFTER the VodPlayer/useVodPlayer usage in this component's
  // render (VodPlayer is mounted further down in the JSX below) so the
  // CHILD's construction effect — which reads autoplayOnConstruct via
  // closure-capture — always fires before this reset runs. React commits
  // child effects before parent effects on every render, so this ordering
  // holds regardless of textual position, but keeping it declared here
  // (after VodPlayer's own hook usage in the render this effect belongs
  // to) documents the invariant explicitly (RESEARCH.md Open Question 2).
  useEffect(() => {
    autoplayNextRef.current = false;
  }, [selectedMatch?.id]);

  function handleSelect(id: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('match', id);
      return next;
    });
  }

  // LIST-04 auto-advance: fires when the live player reports ENDED. Only
  // acts while a playlist is active; otherwise a no-op (Library view has
  // no "next match" concept). Two branches mirroring the existing
  // reposition mechanism (Pattern 4):
  //   - same video identity as the current match -> just select the next
  //     match id; previousVodIdentityRef's reposition effect (above) seeks
  //     the ALREADY-PLAYING player to the new match's start time, no
  //     remount, no autoplay flag needed (documented MVP limitation:
  //     mid-video segments only advance at true video end).
  //   - different video identity -> flag autoplay FIRST, then select the
  //     next match id; the identity change remounts useVodPlayer, which
  //     reads the flag as autoplayOnConstruct.
  function handleEnded() {
    if (!selectedPlaylist || !playlistMatches || !selectedMatch) {
      return;
    }
    const index = playlistMatches.findIndex((m) => m.id === selectedMatch.id);
    if (index === -1) {
      return;
    }
    const nextMatch = playlistMatches[index + 1];
    if (!nextMatch) {
      return;
    }
    const currentIdentity = videoIdentityOf(selectedMatch);
    const nextIdentity = videoIdentityOf(nextMatch);
    if (currentIdentity == null || currentIdentity !== nextIdentity) {
      autoplayNextRef.current = true;
    }
    handleSelect(nextMatch.id);
  }

  // Authoritative "the browser blocked our auto-advance attempt" signal
  // (onAutoplayBlocked / PLAYBACK_BLOCKED, T-04-08) — surfaces the native
  // play-button fallback hint (Task 3) rather than leaving the user stuck
  // mid-transition. Reset alongside autoplayBlocked's other reset above
  // whenever the selected match changes.
  function handleAutoplayBlocked() {
    setAutoplayBlocked(true);
  }

  // Manual Prev/Next playback navigation (Task 3) — deliberately does NOT
  // touch autoplayNextRef: only handleEnded's cross-identity branch may
  // request autoplay. Manual navigation (a row click, Prev, or Next) must
  // never surprise-autoplay (RESEARCH.md anti-pattern list).
  function handlePrevMatch() {
    if (!playlistMatches || playlistMatchIndex <= 0) {
      return;
    }
    const prevMatch = playlistMatches[playlistMatchIndex - 1];
    if (prevMatch) {
      handleSelect(prevMatch.id);
    }
  }

  function handleNextMatch() {
    if (!playlistMatches || playlistMatchIndex === -1) {
      return;
    }
    const nextMatch = playlistMatches[playlistMatchIndex + 1];
    if (nextMatch) {
      handleSelect(nextMatch.id);
    }
  }

  // Sibling-param update (see `selectedPlaylistId` doc comment above) — the
  // current `?match=` selection is preserved as-is; if it isn't in the newly
  // selected playlist, `selectedMatch` resolves to null (T-01-04's existing
  // stale-id fallback) and the panel shows the placeholder rather than
  // throwing.
  function handleSelectPlaylist(id: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id != null) {
        next.set('playlist', id);
      } else {
        next.delete('playlist');
      }
      return next;
    });
  }

  async function handleCreatePlaylist(name: string) {
    try {
      const playlist = await createPlaylist.mutateAsync({ name });
      handleSelectPlaylist(playlist.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast.error(t('vodManager.playlists.limitReached', { max: MAX_PLAYLISTS_PER_USER }));
      } else {
        console.error('Failed to create playlist', error);
      }
    }
  }

  // Reorder/remove arrays are computed from `playlistMatches` (the RESOLVED
  // present-only set, T-04-05's soft-orphan join) rather than the raw stored
  // matchIds — sending back the resolved ids prunes any soft-orphaned id
  // (deleted match, foreign id, stale cache) on save, per T-04-07's
  // mitigation. `updatePlaylist.isPending` is threaded into `VodMatchList`
  // as `reorderPending`, the race guard for rapid reorder clicks.
  async function handleMoveMatch(index: number, dir: 'up' | 'down') {
    if (!selectedPlaylist || !playlistMatches) {
      return;
    }
    const next = movePlaylistItem(
      playlistMatches.map((m) => m.id),
      index,
      dir,
    );
    try {
      await updatePlaylist.mutateAsync({ id: selectedPlaylist.id, input: { matchIds: next } });
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  async function handleRemoveFromPlaylist(matchId: string) {
    if (!selectedPlaylist || !playlistMatches) {
      return;
    }
    const next = playlistMatches.map((m) => m.id).filter((id) => id !== matchId);
    try {
      await updatePlaylist.mutateAsync({ id: selectedPlaylist.id, input: { matchIds: next } });
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  async function handleCommitRename() {
    if (!selectedPlaylist) {
      return;
    }
    const trimmed = renameDraft.trim();
    if (trimmed.length < 1 || trimmed.length > 40 || trimmed === selectedPlaylist.name) {
      setRenameDraft(selectedPlaylist.name);
      return;
    }
    try {
      await updatePlaylist.mutateAsync({ id: selectedPlaylist.id, input: { name: trimmed } });
    } catch {
      setRenameDraft(selectedPlaylist.name);
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }

  // Deleting a playlist never touches its member matches — only the
  // `playlists/{uid}/{playlistId}` node is removed. If the deleted playlist
  // was the active selection, fall back to Library (never leave `?playlist=`
  // pointing at a now-nonexistent id).
  async function handleConfirmDeletePlaylist() {
    if (!selectedPlaylist) {
      return;
    }
    try {
      await deletePlaylist.mutateAsync(selectedPlaylist.id);
      handleSelectPlaylist(null);
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    } finally {
      setConfirmingDeletePlaylist(false);
    }
  }

  function handleSeek(seconds: number) {
    playerSeekRef.current?.(seconds);
  }

  // Single PATCH mutation site for all note add/edit/delete flows — a
  // full-overwrite carry-through payload via buildUpdateInput, NEVER a
  // bespoke partial-update helper (RESEARCH.md "Don't Hand-Roll").
  async function handleUpdateTimestamps(next: VodTimestamp[]) {
    if (!selectedMatch) {
      return;
    }
    const input = buildUpdateInput(selectedMatch, {
      vodUrl: selectedMatch.vodUrl,
      vodTimestamps: next.length > 0 ? next : undefined,
    });
    try {
      await updateMatch.mutateAsync({ id: selectedMatch.id, input });
      toast.success(t('shared.vod.saved'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('vodManager.title')}</h1>

      {!isLoading && vodMatches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('vodManager.emptyState')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[360px_1fr]">
          <div className="flex flex-col gap-3">
            <PlaylistSelector
              playlists={playlists}
              selectedPlaylistId={selectedPlaylistId}
              onSelect={handleSelectPlaylist}
              onCreate={handleCreatePlaylist}
              creating={createPlaylist.isPending}
            />
            {selectedPlaylist && (
              <div className="flex items-center gap-2">
                <Input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleCommitRename}
                  placeholder={t('vodManager.playlists.renamePlaceholder')}
                  aria-label={t('vodManager.playlists.rename')}
                  maxLength={40}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('vodManager.playlists.delete')}
                  onClick={() => setConfirmingDeletePlaylist(true)}
                >
                  <Trash2 />
                  {t('vodManager.playlists.delete')}
                </Button>
                <AlertDialog
                  open={confirmingDeletePlaylist}
                  onOpenChange={setConfirmingDeletePlaylist}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t('vodManager.playlists.deleteConfirmTitle')}
                      </AlertDialogTitle>
                      <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleConfirmDeletePlaylist}>
                        {t('common.delete')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
            <VodMatchList
              matches={displayedMatches}
              filters={filters}
              filterOptions={filterOptions}
              onFiltersChange={setFilters}
              sort={sort}
              onSortChange={setSort}
              selectedId={selectedMatchId}
              onSelect={handleSelect}
              isPlaylistView={selectedPlaylist != null}
              onMoveMatch={handleMoveMatch}
              onRemoveFromPlaylist={handleRemoveFromPlaylist}
              reorderPending={updatePlaylist.isPending}
            />
          </div>

          <div className="flex flex-col gap-4">
            {selectedMatch?.vodUrl != null ? (
              <>
                <VodPlayer
                  vodUrl={selectedMatch.vodUrl}
                  startSeconds={resolveMatchStartSeconds(selectedMatch)}
                  seekRef={playerSeekRef}
                  getCurrentTimeRef={getCurrentTimeRef}
                  onEnded={handleEnded}
                  onAutoplayBlocked={handleAutoplayBlocked}
                  autoplayOnConstructRef={autoplayNextRef}
                />
                {autoplayBlocked && (
                  <p className="text-sm text-muted-foreground">
                    {t('vodManager.playback.autoplayBlocked')}
                  </p>
                )}
                {/* Playlist playback controls (LIST-04) — only while a
                    playlist is active; clicking Prev/Next never sets
                    autoplayNextRef (manual navigation must never
                    surprise-autoplay). */}
                {selectedPlaylist && playlistMatches && playlistMatches.length > 0 && (
                  <div className="flex items-center justify-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('vodManager.playback.prev')}
                      disabled={playlistMatchIndex <= 0}
                      onClick={handlePrevMatch}
                    >
                      <SkipBack />
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      {t('vodManager.playback.position', {
                        current: playlistMatchIndex + 1,
                        total: playlistMatches.length,
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('vodManager.playback.next')}
                      disabled={
                        playlistMatchIndex === -1 ||
                        playlistMatchIndex >= playlistMatches.length - 1
                      }
                      onClick={handleNextMatch}
                    >
                      <SkipForward />
                    </Button>
                  </div>
                )}
                <TimestampList
                  timestamps={selectedMatch.vodTimestamps ?? []}
                  selectedIndex={selectedTimestampIndex}
                  onSelect={setSelectedTimestampIndex}
                  onSeek={handleSeek}
                  getCurrentTimeRef={getCurrentTimeRef}
                  onUpdateTimestamps={handleUpdateTimestamps}
                  tagVocabulary={tagVocabulary}
                  editingIndex={editingIndex}
                  onEditingIndexChange={setEditingIndex}
                />
              </>
            ) : (
              <div className="aspect-video rounded-lg border bg-muted flex items-center justify-center text-sm text-muted-foreground">
                {t('vodManager.playerPlaceholder')}
              </div>
            )}

            {selectedMatch && (
              <SelectedMatchMeta
                match={selectedMatch}
                fighterSprites={fighterSprites}
                getCurrentTimeRef={getCurrentTimeRef}
                tagVocabulary={tagVocabulary}
                playlists={playlists}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
