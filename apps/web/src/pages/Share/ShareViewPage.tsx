import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';
import { ApiError } from '@/lib/api';
import { usePublicVodShare } from '@/hooks/useVodShares';
import {
  useCoachSession,
  useCreateCoachNote,
  useDeleteCoachNote,
  useUpdateCoachNote,
} from '@/hooks/useCoachNotes';
import { useVodPlayer } from '@/lib/useVodPlayer';
import { formatTimestamp, parseFlexibleTimestamp, MAX_TIMESTAMPS } from '@/lib/vod';
import {
  tagLabel,
  addTagToList,
  removeTagFromList,
  MAX_NOTE_TAGS,
  NOTE_PRESET_TAGS,
  PRESET_SLUGS,
} from '@/lib/tags';
import {
  contributorLabel,
  deriveContributorKeys,
  filterContributorIndices,
} from '@/lib/contributors';
import { cn } from '@/lib/utils';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import { logProductEvent } from '@/lib/firebase';
import * as shareReferral from '@/lib/shareReferral';
import { getOrCreateSessionId, getStoredDisplayName, setDisplayName } from '@/lib/coachSession';
import { readStoredQuickTags, persistQuickTags } from '@/pages/VodManager/lib/vodPrefs';
import { QuickTagPanel } from '@/pages/VodManager/components/QuickTagPanel';
import { TagAddCombobox } from '@/pages/VodManager/components/TagAddCombobox';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShareTimestampRow } from './components/ShareTimestampRow';
import { RecapView } from './components/RecapView';

/** One entry of the coach edit-session's `timestamps` array — the additive
 * `id`/`coach` fields (absent on a frozen view-tier snapshot) are populated
 * ONLY by the live `/session` recompute (08-03). */
type SessionTimestamp = NonNullable<PublicShareSnapshot['timestamps']>[number];

/**
 * Per-call mutation callbacks (FB-04) threaded through `withDisplayName` for
 * EVERY name-bearing create (review CR-01): the deferred FIRST write (the
 * moment the server actually accepts or rejects the just-submitted display
 * name) AND a write reusing a locally-stored name — that name is a GLOBAL
 * per-browser record (`coachSession.ts`) while the server's uniqueness check
 * is per-match, so a name accepted on some OTHER review can still 409 here.
 */
interface CoachWriteOptions {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

/** Best-effort hostname extraction for the "Watch on {host}" fallback link — mirrors `VodPlayer.tsx`'s `safeHostname`. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Sorted, deduped tag vocabulary across the coach edit-session's live note
 * list — fed into each own-note's add-combobox. A plain helper (not a hook):
 * derived AFTER this component's early returns, where hooks can't run.
 *
 * Also folds in `quickTags` (the page's Quick Tags panel state): a custom
 * tag the coach adds to their Quick Tags set reads as "already added" from
 * their perspective and must be offered in the add-combobox immediately —
 * not only once it happens to get captured onto a note first (mirrors
 * `deriveCustomTagVocabulary`'s `extraTags` fold-in on the owner page).
 * Presets already render via the combobox's `presets` prop, so only
 * non-preset quick tags are folded in here.
 */
function computeTagVocabulary(stamps: SessionTimestamp[], quickTags: string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const stamp of stamps) {
    for (const tag of stamp.tags ?? []) {
      if (!seen.has(tag.toLowerCase())) {
        seen.set(tag.toLowerCase(), tag);
      }
    }
  }
  for (const tag of quickTags) {
    if (!PRESET_SLUGS.has(tag) && !seen.has(tag.toLowerCase())) {
      seen.set(tag.toLowerCase(), tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Coach-facing "add a timestamp note" composer for an edit-tier share.
 * Mirrors `VodManager/components/NoteComposer.tsx`'s shape (live-position
 * time input via `getCurrentTimeRef`, optional note text, Enter-to-submit,
 * the shared `MAX_TIMESTAMPS` cap) — not the literal component, since the
 * coach's note list is `SessionTimestamp[]` (nullish `id`/`coach`), not the
 * owner-side `VodTimestamp[]` NoteComposer is typed against.
 */
function CoachComposer({
  noteCount,
  getCurrentTimeRef,
  onCreateNote,
}: {
  noteCount: number;
  getCurrentTimeRef: RefObject<(() => number) | null>;
  onCreateNote: (input: { seconds: number; note: string }) => void;
}) {
  const { t } = useTranslation();
  const [timeInput, setTimeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);

  function handleTimeFocus() {
    const current = getCurrentTimeRef.current?.();
    if (current != null) {
      setTimeInput(formatTimestamp(current));
    }
  }

  function handleAdd() {
    const seconds = parseFlexibleTimestamp(timeInput);
    if (seconds == null) {
      setTimeError(t('shared.vod.timeFormatError'));
      return;
    }
    if (noteCount >= MAX_TIMESTAMPS) {
      setTimeError(t('shared.vod.timestampLimit', { max: MAX_TIMESTAMPS }));
      return;
    }
    onCreateNote({ seconds, note: noteInput.trim() });
    setTimeInput('');
    setNoteInput('');
    setTimeError(null);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleAdd();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {t('vodManager.composer.title')}
      </span>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          value={timeInput}
          onFocus={handleTimeFocus}
          onChange={(e) => {
            setTimeInput(e.target.value);
            setTimeError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('shared.vod.timePlaceholder')}
          aria-label={t('shared.vod.timeAria')}
          className="w-24"
        />
        <Input
          value={noteInput}
          onChange={(e) => {
            setNoteInput(e.target.value);
            setTimeError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('shared.vod.notePlaceholder')}
          aria-label={t('shared.vod.noteAria')}
          maxLength={200}
          className="min-w-[10rem] flex-1"
        />
        <Button type="button" variant="outline" size="icon-sm" onClick={handleAdd}>
          <Plus />
          <span className="sr-only">{t('shared.vod.addTimestamp')}</span>
        </Button>
      </div>
      {timeError && <p className="text-sm text-destructive">{timeError}</p>}
    </div>
  );
}

/**
 * One coach edit-session timestamp row. Read-only for every note (click to
 * seek), plus edit/delete/tag affordances — and, per Phase 8's locked
 * capability matrix, ONLY when `isOwn` (the SERVER-computed `stamp.own`
 * flag, review WR-02 — checked by the caller). Coach-authored notes (own or
 * another session's) additionally render an attribution line. Mirrors
 * `VodManager/components/TimestampRow.tsx`'s edit-mode/view-mode idiom.
 */
function CoachTimestampRow({
  stamp,
  isOwn,
  isSelected,
  isEditing,
  onSeek,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onDelete,
  onAddTag,
  onRemoveTag,
  tagVocabulary,
}: {
  stamp: SessionTimestamp;
  isOwn: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onSeek: (seconds: number) => void;
  onSelect: (seconds: number) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onCommitEdit: (id: string, next: { seconds: number; note: string; tags?: string[] }) => void;
  onDelete: (id: string) => void;
  onAddTag: (id: string, tag: string) => void;
  onRemoveTag: (id: string, tag: string) => void;
  tagVocabulary: string[];
}) {
  const { t } = useTranslation();
  const tags = stamp.tags ?? [];
  const [timeInput, setTimeInput] = useState(() => formatTimestamp(stamp.seconds));
  const [noteInput, setNoteInput] = useState(stamp.note);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Re-seed the draft every time this row (re-)enters edit mode — mirrors
  // `TimestampRow`'s "adjust state during render" pattern (never an effect).
  const [trackedIsEditing, setTrackedIsEditing] = useState(isEditing);
  if (isEditing !== trackedIsEditing) {
    setTrackedIsEditing(isEditing);
    if (isEditing) {
      setTimeInput(formatTimestamp(stamp.seconds));
      setNoteInput(stamp.note);
      setError(null);
    }
  }

  function commit() {
    if (!stamp.id) return;
    const seconds = parseFlexibleTimestamp(timeInput);
    if (seconds == null) {
      setError(t('shared.vod.timeFormatError'));
      return;
    }
    onCommitEdit(stamp.id, {
      seconds,
      note: noteInput.trim(),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }

  function cancel() {
    setTimeInput(formatTimestamp(stamp.seconds));
    setNoteInput(stamp.note);
    setError(null);
    onCancelEdit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  function confirmDelete() {
    if (stamp.id) {
      onDelete(stamp.id);
    }
    setConfirmingDelete(false);
  }

  const tagRow = (tags.length > 0 || isOwn) && (
    <div className="flex flex-wrap items-center gap-2 pl-2">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1">
          {tagLabel(t, tag)}
          {isOwn && stamp.id && (
            <button
              type="button"
              aria-label={t('tags.removeAria', { tag: tagLabel(t, tag) })}
              onClick={() => onRemoveTag(stamp.id!, tag)}
              className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
            >
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {isOwn && stamp.id && (
        <TagAddCombobox
          presets={NOTE_PRESET_TAGS}
          existingTags={tags}
          vocabulary={tagVocabulary}
          onAdd={(tag) => onAddTag(stamp.id!, tag)}
          ariaLabel={t('tags.addAria')}
        />
      )}
    </div>
  );

  const attribution = stamp.coach && (
    <p className="pl-2 text-xs text-muted-foreground">
      {t('share.coach.attribution', { name: stamp.coach.displayName })}
    </p>
  );

  if (isOwn && isEditing) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={timeInput}
            onChange={(e) => {
              setTimeInput(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={t('vodManager.notes.editTimeAria')}
            className="w-24"
            autoFocus
          />
          <Input
            value={noteInput}
            onChange={(e) => {
              setNoteInput(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={t('vodManager.notes.editNoteAria')}
            maxLength={200}
            className="min-w-[10rem] flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.notes.saveEdit')}
            onClick={commit}
          >
            <Check />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.notes.cancelEdit')}
            onClick={cancel}
          >
            <X />
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {tagRow}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onSeek(stamp.seconds);
            onSelect(stamp.seconds);
          }}
          className={cn(
            'flex flex-1 items-center gap-2 rounded-md border p-2 text-left text-sm',
            isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
          )}
        >
          <span className="shrink-0 font-mono">{formatTimestamp(stamp.seconds)}</span>
          <span className="truncate">{stamp.note}</span>
        </button>
        {isOwn && stamp.id && (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('shared.vod.editTimestamp', { time: formatTimestamp(stamp.seconds) })}
              onClick={() => onStartEdit(stamp.id!)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('shared.vod.deleteTimestamp', { time: formatTimestamp(stamp.seconds) })}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 />
            </Button>
            <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('vodManager.notes.deleteConfirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={confirmDelete}>
                    {t('common.remove')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
      {attribution}
      {tagRow}
    </div>
  );
}

/**
 * Anonymous VOD review page (VIEW-01/02/03/04/05), served at `/s/:token` on
 * `PublicLayout` — no account, no `ProtectedRoute`. Hydrates client-side via
 * `usePublicVodShare` (a second fetch of the same redacted snapshot the
 * server-rendered `/s/:token` HTML shell already used for its OG meta, per
 * RESEARCH.md's architecture diagram: bots read the shell's meta and never
 * run this component). Deliberately bespoke — NOT the VOD Manager's
 * `VodMatchList`/`TimestampList`/chrome — reusing only `useVodPlayer`
 * (read-only usage: no `onUpdateTimestamps`-adjacent callbacks exist on that
 * hook to begin with) and `TimestampRow`'s highlight visual tokens via
 * `ShareTimestampRow`.
 *
 * Phase 8 (Coaching Edit Sessions): additionally fires `useCoachSession` in
 * parallel with the frozen `usePublicVodShare` read on EVERY visit — the
 * session endpoint 404s (silently, no page-level error) for a
 * view-tier/unknown/revoked/expired token, and resolves with
 * `permissions: 'edit'` only for a genuine coaching link. Its `timestamps`
 * (id/coach-bearing, LIVE-recomputed) become the rendered note list whenever
 * it resolves; view-tier rendering is otherwise byte-identical to pre-Phase-8
 * behavior.
 */
export function ShareViewPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const { data: snapshot, isPending, isError } = usePublicVodShare(token ?? '');
  // Phase 8: this browser's coach session id — generated (and persisted)
  // once per browser regardless of tier; harmless on a view-tier share. It
  // rides the session READ as a query param so the server computes each
  // note's `own` flag (review WR-02) — the response never carries any
  // coach's sessionId.
  const [mySessionId] = useState(() => getOrCreateSessionId());
  const { data: coachSession } = useCoachSession(token ?? '', mySessionId);
  const createCoachNote = useCreateCoachNote(token ?? '');
  const updateCoachNote = useUpdateCoachNote(token ?? '');
  const deleteCoachNote = useDeleteCoachNote(token ?? '');

  const deepLinkSeconds = useMemo(() => {
    const raw = searchParams.get('t');
    return raw ? parseFlexibleTimestamp(raw) : null;
  }, [searchParams]);

  const [selectedSeconds, setSelectedSeconds] = useState<number | null>(deepLinkSeconds);
  const appliedDeepLinkRef = useRef(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const { containerRef, isReady, error, seek, pause, pauseAtEnd, getCurrentTime } = useVodPlayer({
    vodUrl: snapshot?.vodUrl ?? '',
    startSeconds: deepLinkSeconds ?? snapshot?.vodStartSeconds ?? 0,
    onAutoplayBlocked: () => setAutoplayBlocked(true),
    // Twitch proactive end-guard (v1.0 retest fix-up #11): fires ~1.5s before
    // the video ends, while the player is still in a non-ended state — a
    // plain in-place pause here means the "Up Next" overlay never arms.
    // Never fires for YouTube (see useVodPlayer's doc comment).
    onEndGuard: () => pause(),
    // Backstop for a real ENDED (e.g. the guard missed, or YouTube): seek
    // back off the very end and pause, which exits the ended state before
    // any post-roll UI can hijack the iframe.
    onEnded: () => {
      pauseAtEnd();
    },
  });

  // Populated every render (mirrors `VodPlayer.tsx`'s own idiom) so the coach
  // composer/quick-tag panel can pull the LIVE playback position on demand
  // without polling.
  const getCurrentTimeRef = useRef<(() => number) | null>(null);
  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime;
  });

  // VIEW-03: seek to the `?t=` deep-link exactly once, the moment the live
  // player reports ready — never re-fires (guarded by a ref, not state, so
  // a later re-render/identity-stable rerun of this effect is a no-op).
  useEffect(() => {
    if (isReady && deepLinkSeconds != null && !appliedDeepLinkRef.current) {
      appliedDeepLinkRef.current = true;
      seek(deepLinkSeconds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, deepLinkSeconds]);

  // FUNNEL-01/02: fires `share_opened` and stamps the referral bridge
  // exactly once, the moment the snapshot resolves — guarded by a ref (not
  // just a `[snapshot]` dep) so a later refetch/rerender of the same share
  // never double-fires. The public snapshot never exposes a true `shareId`
  // (redaction-by-shape — see `publicShareSnapshotSchema`), so the stamped
  // value is the route TOKEN; the server resolves it to the durable shareId
  // (via `shareTokens/{token}`) at provisioning time and drops it silently
  // when it can't be resolved (see `RtdbService.upsertUser`).
  const hasFiredShareOpenedRef = useRef(false);
  useEffect(() => {
    if (!snapshot || hasFiredShareOpenedRef.current) {
      return;
    }
    hasFiredShareOpenedRef.current = true;
    logProductEvent('share_opened', { share_kind: snapshot.kind === 'recap' ? 'recap' : 'review' });
    if (token) {
      shareReferral.stamp(token);
    }
  }, [snapshot, token]);

  // MEAS-09: `share_view_loaded` is a DISTINCT signal from `share_opened`
  // above — it fires only once the live player reports `isReady` (a usable,
  // playable render), not merely once the snapshot fetch resolves. This is
  // the crawler-safe distinction from the server-side `share_resolved`
  // access count (any GET, bots included): a bot that only hits the API
  // never renders a player, so it never fires this event. Guarded by its
  // own ref so it fires exactly once per view, independent of the
  // share_opened effect's own guard.
  const hasFiredShareViewLoadedRef = useRef(false);
  useEffect(() => {
    if (!snapshot || !isReady || hasFiredShareViewLoadedRef.current) {
      return;
    }
    hasFiredShareViewLoadedRef.current = true;
    postCanonicalEvent('share_view_loaded', {
      share_kind: snapshot.kind === 'recap' ? 'recap' : 'review',
    });
  }, [snapshot, isReady]);

  const [quickTags, setQuickTags] = useState<string[]>(() => readStoredQuickTags());
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  // Single-select "Filter by contributor" chip row (mirrors the owner
  // page's note-tag filter pattern) — narrows the rendered notes by author
  // when 2+ distinct authors exist. `null` means no narrowing.
  const [contributorFilter, setContributorFilter] = useState<string | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [namePromptValue, setNamePromptValue] = useState('');
  // FB-04: the server rejected the coach's most recently SUBMITTED name with
  // a 409 (already taken on this review). Drives the name-taken message in
  // the prompt; the rejected name is never committed below.
  const [nameTaken, setNameTaken] = useState(false);
  // The coach's display name, held in COMPONENT STATE as the source of
  // truth (review WR-04): seeded from localStorage when available, updated
  // directly from the name prompt, and passed explicitly to every write.
  // localStorage persistence is best-effort only — `coachSession.ts`
  // deliberately swallows storage failures (Safari private mode / disabled
  // storage), so re-reading storage after a write would yield '' there and
  // 400 every coach write forever while re-opening the prompt each time.
  const [coachDisplayName, setCoachDisplayName] = useState<string>(
    () => getStoredDisplayName() ?? '',
  );
  // FB-04: the FIRST write (deferred behind the name prompt) is committed
  // to state/localStorage ONLY once the server accepts it — a per-call
  // `CoachWriteOptions` threaded through `withDisplayName` does that commit
  // on success and re-prompts on a 409, WITHOUT ever writing the rejected
  // name to state or storage. A write reusing a STORED name carries a 409
  // handler too (review CR-01): the stored name is per-browser while the
  // server's uniqueness check is per-match, so it can still collide on THIS
  // review — that handler demotes the stale name and re-enters the same
  // deferred re-prompt flow, so the coach's write is never silently lost.
  const pendingWriteRef = useRef<
    ((displayName: string, options?: CoachWriteOptions) => void) | null
  >(null);

  const unavailable = isError || (!isPending && !snapshot);

  useSeo({
    title: snapshot
      ? snapshot.kind === 'recap'
        ? `${snapshot.tournamentName} — Recap · grandfinals.gg`
        : `${getFighterById(snapshot.fighterId!)?.name ?? t('common.unknown')} vs ${
            getFighterById(snapshot.opponentFighterId!)?.name ?? t('common.unknown')
          } — VOD review · grandfinals.gg`
      : unavailable
        ? t('share.unavailableTitle')
        : t('share.loadingTitle'),
    noindex: true,
  });

  if (unavailable) {
    return (
      <PublicLayout>
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('share.unavailableTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('share.unavailableMessage')}</p>
          <Button asChild>
            <Link to="/">{t('share.unavailableHomeLink')}</Link>
          </Button>
        </div>
      </PublicLayout>
    );
  }

  if (isPending || !snapshot) {
    return (
      <PublicLayout>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
          <div className="h-8 w-64 animate-pulse rounded bg-muted" />
          <div className="aspect-video w-full animate-pulse rounded-lg bg-muted" />
        </div>
      </PublicLayout>
    );
  }

  // A recap snapshot has no vodUrl — the player branch below would break —
  // so the kind fork happens here, BEFORE any review-only field access,
  // matching the same after-the-unavailable/pending-guard placement the
  // unavailable page itself relies on (VIEW-05's no-oracle discipline: a
  // revoked/unknown recap token never reaches this branch either, since it
  // fails the `unavailable` check above first). Recap tokens are never
  // edit-tier (createShareInputSchema blocks it), so `coachSession` never
  // resolves here either.
  if (snapshot.kind === 'recap') {
    return <RecapView snapshot={snapshot} token={token ?? ''} />;
  }

  // Review-only path below: the schema refine guarantees these fields for a
  // non-recap snapshot (the flat+refine shape cannot express that in types).
  const fighter = getFighterById(snapshot.fighterId!);
  const opponentFighter = getFighterById(snapshot.opponentFighterId!);

  // Phase 8 (COACH-02/03/05): an edit-tier coach session resolved — the LIVE
  // recomputed note list (id/coach-bearing) replaces the frozen snapshot's
  // `timestamps` for rendering; every other displayed field stays the frozen
  // share-time copy (match facts don't change once shared, per Phase 5/6).
  const isEditTier = coachSession?.permissions === 'edit';
  const timestamps: SessionTimestamp[] = isEditTier
    ? (coachSession?.timestamps ?? [])
    : (snapshot.timestamps ?? []);
  const tagVocabulary = computeTagVocabulary(timestamps, quickTags);
  // Contributor filter (item 2) — distinct authors across the rendered note
  // list, and the visible subset narrowed by `contributorFilter`. Plain
  // consts (not hooks): derived AFTER the early returns above, same
  // position as `tagVocabulary`.
  const contributorKeys = deriveContributorKeys(timestamps);
  const ownerContributorLabel = snapshot.ownerDisplayName ?? t('share.notes.contributorOwner');
  const visibleTimestamps = filterContributorIndices(timestamps, contributorFilter).map(
    (i) => timestamps[i]!,
  );

  function handleSelectTimestamp(seconds: number) {
    seek(seconds);
    setSelectedSeconds(seconds);
  }

  function handleQuickTagsChange(next: string[]) {
    setQuickTags(next);
    persistQuickTags(next);
  }

  // Name-prompt gate (RESEARCH: fires on the FIRST WRITE attempt, never on
  // page load): if no display name is known yet, defer `action` behind the
  // one-field dialog; `action` fires — with the entered name passed
  // EXPLICITLY (review WR-04) plus per-call `CoachWriteOptions` (FB-04) —
  // once the coach submits. Every later write reuses the in-state name and
  // never opens the dialog up front — but it STILL carries a 409 handler
  // (review CR-01): the seeded name came from the GLOBAL per-browser
  // localStorage record and may have been accepted on a DIFFERENT review,
  // while the server's uniqueness check is per-match. On a 409 the stored
  // name is demoted and the write falls into the exact same deferred
  // re-prompt flow as a first write — never a silent drop (the generic
  // toast handler deliberately skips 409s, so this is the ONLY surface for
  // that failure). The name is never re-read from localStorage after the
  // prompt: persistence there is best-effort and may silently fail (Safari
  // private mode).
  function withDisplayName(action: (displayName: string, options?: CoachWriteOptions) => void) {
    if (coachDisplayName) {
      const storedName = coachDisplayName;
      action(storedName, {
        onError: (error: unknown) => {
          if (error instanceof ApiError && error.status === 409) {
            // Stored name is taken on THIS review — demote it and re-prompt
            // with the rejected candidate restored, keeping the write
            // pending exactly like the first-write path.
            setCoachDisplayName('');
            pendingWriteRef.current = action;
            setNamePromptValue(storedName);
            setNameTaken(true);
            setNameDialogOpen(true);
          }
        },
      });
      return;
    }
    pendingWriteRef.current = action;
    setNamePromptValue('');
    setNameTaken(false);
    setNameDialogOpen(true);
  }

  function handleNamePromptSubmit() {
    // Review WR-03: the prompt stays OPEN while the first write is in
    // flight (it closes only in onSuccess, FB-04) — without this guard a
    // double click or held-Enter key-repeat would POST the same note N
    // times (the same session never name-conflicts with itself, so every
    // duplicate succeeds and burns the shared 20-note cap).
    if (createCoachNote.isPending) {
      return;
    }
    const trimmed = namePromptValue.trim();
    if (!trimmed) {
      return;
    }
    const action = pendingWriteRef.current;
    if (!action) {
      return;
    }
    // Resubmitting clears any stale "name taken" message from a prior
    // rejection while this attempt is in flight.
    setNameTaken(false);
    action(trimmed, {
      onSuccess: () => {
        // Component state is the source of truth for every subsequent
        // write; localStorage persistence below is best-effort only
        // (WR-04). Committed ONLY now that the server has actually
        // accepted this name (FB-04) — never optimistically beforehand.
        setCoachDisplayName(trimmed);
        setDisplayName(trimmed);
        setNameTaken(false);
        setNameDialogOpen(false);
        pendingWriteRef.current = null;
      },
      onError: (error: unknown) => {
        if (error instanceof ApiError && error.status === 409) {
          // Name rejected by the server (already taken on this review) —
          // never persisted to state or localStorage. Re-open the prompt
          // with the rejected candidate restored so the coach can retry;
          // `pendingWriteRef` stays intact so the SAME write retries once a
          // name is accepted.
          setNameTaken(true);
          setNamePromptValue(trimmed);
          setNameDialogOpen(true);
          return;
        }
        // Any other failure: the shared `toastCoachWriteError` handler
        // (fired from `useCreateCoachNote`'s own onError) already surfaced
        // the generic save-failed toast — nothing else to do here.
        pendingWriteRef.current = null;
        setNameDialogOpen(false);
      },
    });
  }

  function handleCreateCoachNote(input: { seconds: number; note: string }) {
    withDisplayName((displayName, options) => {
      createCoachNote.mutate(
        {
          sessionId: mySessionId,
          displayName,
          seconds: input.seconds,
          note: input.note,
        },
        options,
      );
    });
  }

  function handleCommitCoachNote(
    id: string,
    next: { seconds: number; note: string; tags?: string[] },
  ) {
    updateCoachNote.mutate({ noteId: id, input: { sessionId: mySessionId, ...next } });
    setEditingNoteId(null);
  }

  function handleDeleteCoachNote(id: string) {
    if (editingNoteId === id) {
      setEditingNoteId(null);
    }
    deleteCoachNote.mutate({ noteId: id, sessionId: mySessionId });
  }

  function handleAddCoachTag(id: string, tag: string) {
    const target = timestamps.find((stamp) => stamp.id === id);
    const nextTags = addTagToList(target?.tags ?? [], tag, MAX_NOTE_TAGS);
    updateCoachNote.mutate({ noteId: id, input: { sessionId: mySessionId, tags: nextTags } });
  }

  function handleRemoveCoachTag(id: string, tag: string) {
    const target = timestamps.find((stamp) => stamp.id === id);
    const nextTags = removeTagFromList(target?.tags ?? [], tag);
    updateCoachNote.mutate({ noteId: id, input: { sessionId: mySessionId, tags: nextTags } });
  }

  // Ownership-filtered same-second quick-tag merge (RESEARCH Pitfall 4 /
  // T-08-21): only an existing note AT THIS SECOND authored by THIS session
  // is merged into — an owner's (or another coach's) note at the identical
  // second is NEVER touched; the fallback is always "create a new note".
  function handleCoachQuickTag(tagSlug: string) {
    const seconds = getCurrentTimeRef.current?.() ?? 0;
    pause();
    const ownAtSecond = timestamps.find((stamp) => stamp.seconds === seconds && stamp.own === true);
    if (ownAtSecond?.id) {
      const nextTags = addTagToList(ownAtSecond.tags ?? [], tagSlug, MAX_NOTE_TAGS);
      updateCoachNote.mutate({
        noteId: ownAtSecond.id,
        input: { sessionId: mySessionId, tags: nextTags },
      });
      return;
    }
    withDisplayName((displayName, options) => {
      createCoachNote.mutate(
        {
          sessionId: mySessionId,
          displayName,
          seconds,
          note: '',
          tags: [tagSlug],
        },
        options,
      );
    });
  }

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {fighter && (
              <img src={fighter.url} alt={fighter.name} className="size-10 shrink-0 rounded" />
            )}
            <span className="text-lg font-semibold">
              {fighter?.name ?? t('common.unknown')} vs.{' '}
              {opponentFighter?.name ?? t('common.unknown')}
            </span>
            {opponentFighter && (
              <img
                src={opponentFighter.url}
                alt={opponentFighter.name}
                className="size-10 shrink-0 rounded"
              />
            )}
            <Badge variant={snapshot.result === 'win' ? 'default' : 'secondary'}>
              {snapshot.result === 'win' ? t('share.resultWin') : t('share.resultLoss')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {snapshot.stage && snapshot.stage.id !== NO_SELECTION_STAGE.id && (
              <span>{snapshot.stage.name}</span>
            )}
            <span>{new Date(snapshot.matchDate!).toLocaleDateString()}</span>
            <span>{t('share.reviewedMoments', { count: snapshot.reviewedMomentsCount })}</span>
          </div>
          {snapshot.tags && snapshot.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {snapshot.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tagLabel(t, tag)}
                </Badge>
              ))}
            </div>
          )}
          {snapshot.ownerDisplayName && (
            <p className="text-sm text-muted-foreground">
              {t('share.sharedBy', { name: snapshot.ownerDisplayName })}
            </p>
          )}
        </div>

        {error === 'unsupported' ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4">
            <a
              href={snapshot.vodUrl!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
            >
              {t('share.watchOnHost', { host: safeHostname(snapshot.vodUrl!) })}
              <ExternalLink className="size-3.5" />
            </a>
            {timestamps.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {timestamps.map((stamp, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatTimestamp(stamp.seconds)}
                    </span>
                    <span>{stamp.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : error === 'unavailable' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border bg-muted p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('share.videoUnavailable')}</p>
          </div>
        ) : (
          <div className="relative aspect-video overflow-hidden rounded-lg border">
            <div ref={containerRef} className="absolute inset-0 size-full" />
            {!isReady && <div className="absolute inset-0 animate-pulse bg-muted" />}
          </div>
        )}
        {autoplayBlocked && (
          <p className="text-sm text-muted-foreground">
            {t('vodManager.playback.autoplayBlocked')}
          </p>
        )}

        {error === null && (
          <div className="flex flex-col gap-3">
            {isEditTier && (
              <>
                <CoachComposer
                  noteCount={timestamps.length}
                  getCurrentTimeRef={getCurrentTimeRef}
                  onCreateNote={handleCreateCoachNote}
                />
                <QuickTagPanel
                  quickTags={quickTags}
                  onQuickTag={handleCoachQuickTag}
                  onQuickTagsChange={handleQuickTagsChange}
                  tagVocabulary={tagVocabulary}
                />
              </>
            )}

            {contributorKeys.length >= 2 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('share.notes.filterByContributor')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {contributorKeys.map((key) => {
                    const label = contributorLabel(key, ownerContributorLabel);
                    const selected = contributorFilter === key;
                    return (
                      <Badge key={key} asChild variant={selected ? 'default' : 'outline'}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={t('share.notes.filterByContributorAria', { label })}
                          onClick={() =>
                            setContributorFilter(contributorFilter === key ? null : key)
                          }
                        >
                          {label}
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}
            {visibleTimestamps.length > 0 && (
              <div className="flex flex-col gap-2">
                {visibleTimestamps.map((stamp, i) =>
                  isEditTier ? (
                    <CoachTimestampRow
                      key={stamp.id ?? i}
                      stamp={stamp}
                      isOwn={stamp.own === true}
                      isSelected={selectedSeconds === stamp.seconds}
                      isEditing={stamp.id != null && editingNoteId === stamp.id}
                      onSeek={seek}
                      onSelect={handleSelectTimestamp}
                      onStartEdit={setEditingNoteId}
                      onCancelEdit={() => setEditingNoteId(null)}
                      onCommitEdit={handleCommitCoachNote}
                      onDelete={handleDeleteCoachNote}
                      onAddTag={handleAddCoachTag}
                      onRemoveTag={handleRemoveCoachTag}
                      tagVocabulary={tagVocabulary}
                    />
                  ) : (
                    <ShareTimestampRow
                      key={i}
                      stamp={stamp}
                      isSelected={selectedSeconds === stamp.seconds}
                      onSelect={handleSelectTimestamp}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border bg-muted/40 p-4 text-center">
          <p className="font-medium">{t('share.ctaTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('share.ctaBody')}</p>
          <Button asChild className="mt-3">
            <Link to="/">{t('share.ctaButton')}</Link>
          </Button>
        </div>
      </div>

      {/* Phase 8: the coach's one-time, first-write-deferred name prompt.
          FB-04: re-opens showing the name-taken message on a 409, without
          ever persisting the rejected name. */}
      <Dialog
        open={nameDialogOpen}
        onOpenChange={(open) => {
          setNameDialogOpen(open);
          if (!open) {
            setNameTaken(false);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('share.coach.namePromptTitle')}</DialogTitle>
            <DialogDescription>
              {nameTaken ? t('share.coach.nameTaken') : t('share.coach.namePromptDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="coach-display-name">{t('share.coach.nameLabel')}</Label>
            <Input
              id="coach-display-name"
              value={namePromptValue}
              onChange={(e) => setNamePromptValue(e.target.value)}
              onKeyDown={(e) => {
                // WR-03: key-repeat from a held Enter must not double-submit
                // while the first write is in flight.
                if (e.key === 'Enter' && !createCoachNote.isPending) {
                  e.preventDefault();
                  handleNamePromptSubmit();
                }
              }}
              maxLength={60}
              autoFocus
            />
          </div>
          <DialogFooter className="mt-2">
            <Button
              type="button"
              onClick={handleNamePromptSubmit}
              disabled={!namePromptValue.trim() || createCoachNote.isPending}
            >
              {t('share.coach.nameSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PublicLayout>
  );
}
