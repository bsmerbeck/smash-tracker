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
} from '@/lib/tags';
import { cn } from '@/lib/utils';
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
 */
function computeTagVocabulary(stamps: SessionTimestamp[]): string[] {
  const seen = new Set<string>();
  for (const stamp of stamps) {
    for (const tag of stamp.tags ?? []) {
      seen.add(tag);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
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

  const [quickTags, setQuickTags] = useState<string[]>(() => readStoredQuickTags());
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [namePromptValue, setNamePromptValue] = useState('');
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
  const pendingWriteRef = useRef<((displayName: string) => void) | null>(null);

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
  const tagVocabulary = computeTagVocabulary(timestamps);

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
  // EXPLICITLY (review WR-04) — once the coach submits. Every later write
  // reuses the in-state name and never opens the dialog. The name is never
  // re-read from localStorage after the prompt: persistence there is
  // best-effort and may silently fail (Safari private mode).
  function withDisplayName(action: (displayName: string) => void) {
    if (coachDisplayName) {
      action(coachDisplayName);
      return;
    }
    pendingWriteRef.current = action;
    setNamePromptValue('');
    setNameDialogOpen(true);
  }

  function handleNamePromptSubmit() {
    const trimmed = namePromptValue.trim();
    if (!trimmed) {
      return;
    }
    // Component state is the source of truth for every subsequent write;
    // localStorage persistence below is best-effort only (WR-04).
    setCoachDisplayName(trimmed);
    setDisplayName(trimmed);
    setNameDialogOpen(false);
    const action = pendingWriteRef.current;
    pendingWriteRef.current = null;
    action?.(trimmed);
  }

  function handleCreateCoachNote(input: { seconds: number; note: string }) {
    withDisplayName((displayName) => {
      createCoachNote.mutate({
        sessionId: mySessionId,
        displayName,
        seconds: input.seconds,
        note: input.note,
      });
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
    withDisplayName((displayName) => {
      createCoachNote.mutate({
        sessionId: mySessionId,
        displayName,
        seconds,
        note: '',
        tags: [tagSlug],
      });
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

            {timestamps.length > 0 && (
              <div className="flex flex-col gap-2">
                {timestamps.map((stamp, i) =>
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

      {/* Phase 8: the coach's one-time, first-write-deferred name prompt. */}
      <Dialog open={nameDialogOpen} onOpenChange={setNameDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('share.coach.namePromptTitle')}</DialogTitle>
            <DialogDescription>{t('share.coach.namePromptDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="coach-display-name">{t('share.coach.nameLabel')}</Label>
            <Input
              id="coach-display-name"
              value={namePromptValue}
              onChange={(e) => setNamePromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
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
              disabled={!namePromptValue.trim()}
            >
              {t('share.coach.nameSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PublicLayout>
  );
}
