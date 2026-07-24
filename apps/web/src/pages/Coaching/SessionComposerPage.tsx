import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Lock, Plus, X } from 'lucide-react';
import type { HomeworkItem } from '@smash-tracker/shared';
import {
  HOMEWORK_ITEM_TEXT_MAX_LENGTH,
  MAX_SESSION_CHARACTER_TAGS,
  MAX_SESSION_HOMEWORK_ITEMS,
  MAX_SESSION_LINKED_MATCH_IDS,
  SpriteList,
} from '@smash-tracker/shared';
import {
  useCoachingSession,
  useCreateSessionDelivery,
  useToggleHomeworkItem,
  useUpdateCoachingSession,
} from '@/hooks/useCoachingSessions';
import { useMatches } from '@/hooks/useMatches';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DeliveryVodPicker } from './components/DeliveryVodPicker';

/** Matches `useReviewAutosave.ts`'s own debounce delay (12-06-PLAN.md's precedent: no new package for a fast-changing edit buffer). */
const AUTOSAVE_DEBOUNCE_MS = 1200;

/** Copied verbatim from `useReviewAutosave.ts`'s `useDebouncedValue` — a plain debounce, no revision/conflict machinery (a session has no draft/publish lifecycle to protect). */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function dateToInputValue(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

interface SessionEditBuffer {
  date: string;
  characterTags: number[];
  summary: string;
  homework: HomeworkItem[];
  linkedMatchIds: string[];
  coachPrivateNotes: string | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  const { t } = useTranslation();
  if (status === 'saving') {
    return (
      <span className="text-xs text-muted-foreground">
        {t('coaching.sessions.composer.save.saving')}
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        {t('coaching.sessions.composer.save.saved')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs text-destructive">{t('coaching.sessions.composer.save.error')}</span>
    );
  }
  return null;
}

/**
 * SESS-01: `/coach/:clientId/sessions/:sessionId` — a single-pane form (NOT
 * the two-pane review composer; a session has no player/evidence/citation
 * UI). Fields: date, character tags (cap `MAX_SESSION_CHARACTER_TAGS`),
 * free-text summary, a flat homework checklist (add/edit/toggle/remove, cap
 * `MAX_SESSION_HOMEWORK_ITEMS`), and a coach-private notes pane mirroring
 * `ReviewPrivateNotesPane` (amber, coach-only — structurally never reaches
 * the delivery snapshot, see `clientVisibleSessionSchema`). Edits are
 * debounced into `useUpdateCoachingSession` (mirrors
 * `useReviewAutosave.ts`'s debounce, minus its revision-conflict machinery —
 * a session is a mutable log with no draft/publish lifecycle to protect).
 * Homework toggles go through the dedicated `useToggleHomeworkItem` mutation
 * instead of the general debounce, since it addresses one item in place.
 */
export function SessionComposerPage() {
  const { t } = useTranslation();
  const { clientId = '', sessionId = '' } = useParams<{ clientId: string; sessionId: string }>();
  const sessionQuery = useCoachingSession(clientId, sessionId);
  const updateSession = useUpdateCoachingSession(clientId, sessionId);
  const toggleHomework = useToggleHomeworkItem(clientId, sessionId);
  const createDelivery = useCreateSessionDelivery(clientId, sessionId);
  const fighterName = useFighterNameResolver();
  // Phase 21 (DLVX-04): the Deliver picker's candidate list — every
  // VOD-bearing match in the client's library, same `useMatches()` +
  // `vodUrl != null` filter every other VOD-picking surface in this app
  // uses (`ReviewComposerPage.tsx`, `DeliveryVodPicker`'s own caller in
  // `ReviewsListPage.tsx`).
  const { data: matchesData } = useMatches();
  const vods = useMemo(
    () => (matchesData ?? []).filter((match) => match.vodUrl != null),
    [matchesData],
  );

  const [buffer, setBuffer] = useState<SessionEditBuffer>(() => ({
    date: dateToInputValue(Date.now()),
    characterTags: [],
    summary: '',
    homework: [],
    linkedMatchIds: [],
    coachPrivateNotes: null,
  }));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasInitializedRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null);

  // Seed the local edit buffer from the fetched session exactly ONCE — a
  // background refetch (e.g. window refocus) must never clobber in-progress
  // local edits. Mirrors `ReviewComposerPage.tsx`'s own `hasInitializedRef`.
  useEffect(() => {
    if (sessionQuery.data && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      const seeded: SessionEditBuffer = {
        date: dateToInputValue(sessionQuery.data.date),
        characterTags: sessionQuery.data.characterTags,
        summary: sessionQuery.data.summary,
        homework: sessionQuery.data.homework,
        linkedMatchIds: sessionQuery.data.linkedMatchIds ?? [],
        coachPrivateNotes: sessionQuery.data.coachPrivateNotes,
      };
      setBuffer(seeded);
      lastSavedRef.current = JSON.stringify(seeded);
    }
  }, [sessionQuery.data]);

  const debouncedBuffer = useDebouncedValue(buffer, AUTOSAVE_DEBOUNCE_MS);

  useEffect(() => {
    if (!hasInitializedRef.current) {
      return;
    }
    const serialized = JSON.stringify(debouncedBuffer);
    if (serialized === lastSavedRef.current) {
      return;
    }
    setStatus('saving');
    updateSession.mutate(
      {
        date: new Date(debouncedBuffer.date).getTime(),
        characterTags: debouncedBuffer.characterTags,
        summary: debouncedBuffer.summary,
        homework: debouncedBuffer.homework,
        linkedMatchIds: debouncedBuffer.linkedMatchIds,
        coachPrivateNotes: debouncedBuffer.coachPrivateNotes,
      },
      {
        onSuccess: () => {
          lastSavedRef.current = serialized;
          setStatus('saved');
        },
        onError: () => setStatus('error'),
      },
    );
    // Only the debounced buffer should re-trigger a save — `updateSession` is
    // a fresh mutation object every render (mirrors `useReviewAutosave.ts`'s
    // own effect dependency discipline).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedBuffer]);

  const homeworkCapReached = buffer.homework.length >= MAX_SESSION_HOMEWORK_ITEMS;
  const tagsCapReached = buffer.characterTags.length >= MAX_SESSION_CHARACTER_TAGS;
  const linkedVodsCapReached = buffer.linkedMatchIds.length >= MAX_SESSION_LINKED_MATCH_IDS;

  function handleAddHomeworkItem() {
    if (homeworkCapReached) {
      return;
    }
    setBuffer((prev) => ({
      ...prev,
      homework: [...prev.homework, { id: crypto.randomUUID(), text: '', done: false }],
    }));
  }

  function handleChangeHomeworkText(itemId: string, text: string) {
    setBuffer((prev) => ({
      ...prev,
      homework: prev.homework.map((item) => (item.id === itemId ? { ...item, text } : item)),
    }));
  }

  function handleRemoveHomeworkItem(itemId: string) {
    setBuffer((prev) => ({
      ...prev,
      homework: prev.homework.filter((item) => item.id !== itemId),
    }));
  }

  function handleToggleHomeworkItem(itemId: string, done: boolean) {
    setBuffer((prev) => ({
      ...prev,
      homework: prev.homework.map((item) => (item.id === itemId ? { ...item, done } : item)),
    }));
    toggleHomework.mutate({ itemId, done });
  }

  function handleAddTag(fighterId: number) {
    if (tagsCapReached || buffer.characterTags.includes(fighterId)) {
      return;
    }
    setBuffer((prev) => ({ ...prev, characterTags: [...prev.characterTags, fighterId] }));
  }

  function handleRemoveTag(fighterId: number) {
    setBuffer((prev) => ({
      ...prev,
      characterTags: prev.characterTags.filter((id) => id !== fighterId),
    }));
  }

  function handleAddLinkedVod(matchId: string) {
    if (linkedVodsCapReached || buffer.linkedMatchIds.includes(matchId)) {
      return;
    }
    setBuffer((prev) => ({ ...prev, linkedMatchIds: [...prev.linkedMatchIds, matchId] }));
  }

  function handleRemoveLinkedVod(matchId: string) {
    setBuffer((prev) => ({
      ...prev,
      linkedMatchIds: prev.linkedMatchIds.filter((id) => id !== matchId),
    }));
  }

  function handleDeliver() {
    setPickerOpen(true);
  }

  async function handleConfirmDeliver(selectedMatchIds: string[]) {
    try {
      const result = await createDelivery.mutateAsync({ includedVods: selectedMatchIds });
      setPickerOpen(false);
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(result.url);
        } catch {
          // Clipboard permission denied — the success toast still fires.
        }
      }
      toast.success(t('coaching.sessions.composer.copiedToast'));
    } catch {
      toast.error(t('coaching.sessions.composer.deliverError'));
    }
  }

  if (sessionQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        {t('chrome.loading')}
      </div>
    );
  }

  if (sessionQuery.isError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        {t('coaching.sessions.composer.loadError')}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('coaching.sessions.composer.title')}
        </h1>
        <div className="flex items-center gap-3">
          <SaveStatusIndicator status={status} />
          <PendingButton type="button" onClick={handleDeliver} pending={createDelivery.isPending}>
            {t('coaching.sessions.composer.deliver')}
          </PendingButton>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="session-date">{t('coaching.sessions.composer.dateLabel')}</Label>
        <Input
          id="session-date"
          type="date"
          value={buffer.date}
          onChange={(event) => setBuffer((prev) => ({ ...prev, date: event.target.value }))}
          className="max-w-48"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">{t('coaching.sessions.composer.tagsLabel')}</p>
        {buffer.characterTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {buffer.characterTags.map((fighterId) => (
              <Badge key={fighterId} variant="outline" className="gap-1">
                {fighterName(fighterId)}
                <button
                  type="button"
                  onClick={() => handleRemoveTag(fighterId)}
                  aria-label={t('coaching.sessions.composer.tagRemoveAria', {
                    fighter: fighterName(fighterId),
                  })}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <select
          aria-label={t('coaching.sessions.composer.tagsLabel')}
          value=""
          disabled={tagsCapReached}
          onChange={(event) => {
            const fighterId = Number(event.target.value);
            if (fighterId) {
              handleAddTag(fighterId);
            }
          }}
          className="h-9 w-fit rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">{t('coaching.sessions.composer.tagsAddPlaceholder')}</option>
          {SpriteList.filter((fighter) => !buffer.characterTags.includes(fighter.id)).map(
            (fighter) => (
              <option key={fighter.id} value={fighter.id}>
                {fighterName(fighter.id)}
              </option>
            ),
          )}
        </select>
        {tagsCapReached && (
          <p className="text-xs text-muted-foreground">
            {t('coaching.sessions.composer.tagsCapReached', { max: MAX_SESSION_CHARACTER_TAGS })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="session-summary">{t('coaching.sessions.composer.summaryLabel')}</Label>
        <Textarea
          id="session-summary"
          value={buffer.summary}
          onChange={(event) => setBuffer((prev) => ({ ...prev, summary: event.target.value }))}
          placeholder={t('coaching.sessions.composer.summaryPlaceholder')}
          className="min-h-32"
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('coaching.sessions.composer.homework.heading')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddHomeworkItem}
            disabled={homeworkCapReached}
          >
            <Plus className="size-4" />
            {t('coaching.sessions.composer.homework.add')}
          </Button>
        </div>
        {buffer.homework.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('coaching.sessions.composer.homework.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {buffer.homework.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(event) => handleToggleHomeworkItem(item.id, event.target.checked)}
                  aria-label={t('coaching.sessions.composer.homework.toggleAria', {
                    item: item.text || t('coaching.sessions.composer.homework.itemPlaceholder'),
                  })}
                />
                <Input
                  value={item.text}
                  maxLength={HOMEWORK_ITEM_TEXT_MAX_LENGTH}
                  placeholder={t('coaching.sessions.composer.homework.itemPlaceholder')}
                  onChange={(event) => handleChangeHomeworkText(item.id, event.target.value)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleRemoveHomeworkItem(item.id)}
                  aria-label={t('coaching.sessions.composer.homework.remove')}
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {homeworkCapReached && (
          <p className="text-xs text-muted-foreground">
            {t('coaching.sessions.composer.homework.capReached', {
              max: MAX_SESSION_HOMEWORK_ITEMS,
            })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">{t('coaching.sessions.composer.linkedVods.label')}</p>
        {buffer.linkedMatchIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {buffer.linkedMatchIds.map((matchId) => {
              const match = vods.find((candidate) => candidate.id === matchId);
              const label = match
                ? `${fighterName(match.fighter_id)} ${t('matchups.vs')} ${fighterName(match.opponent_id)}`
                : matchId;
              return (
                <Badge key={matchId} variant="outline" className="gap-1">
                  {label}
                  <button
                    type="button"
                    onClick={() => handleRemoveLinkedVod(matchId)}
                    aria-label={t('coaching.sessions.composer.linkedVods.removeAria', {
                      vod: label,
                    })}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
        {vods.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('coaching.sessions.composer.linkedVods.empty')}
          </p>
        ) : (
          <select
            aria-label={t('coaching.sessions.composer.linkedVods.label')}
            value=""
            disabled={linkedVodsCapReached}
            onChange={(event) => {
              const matchId = event.target.value;
              if (matchId) {
                handleAddLinkedVod(matchId);
              }
            }}
            className="h-9 w-fit rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">{t('coaching.sessions.composer.linkedVods.addPlaceholder')}</option>
            {vods
              .filter((match) => !buffer.linkedMatchIds.includes(match.id))
              .map((match) => (
                <option key={match.id} value={match.id}>
                  {fighterName(match.fighter_id)} {t('matchups.vs')}{' '}
                  {fighterName(match.opponent_id)}
                </option>
              ))}
          </select>
        )}
        {linkedVodsCapReached && (
          <p className="text-xs text-muted-foreground">
            {t('coaching.sessions.composer.linkedVods.capReached', {
              max: MAX_SESSION_LINKED_MATCH_IDS,
            })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <Lock className="size-4 shrink-0" />
          <span>{t('coaching.sessions.composer.privateNotes.label')}</span>
        </div>
        <Textarea
          value={buffer.coachPrivateNotes ?? ''}
          onChange={(event) =>
            setBuffer((prev) => ({ ...prev, coachPrivateNotes: event.target.value }))
          }
          aria-label={t('coaching.sessions.composer.privateNotes.textareaAria')}
          placeholder={t('coaching.sessions.composer.privateNotes.placeholder')}
          className="min-h-32 border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/40"
        />
        <p className="text-xs text-muted-foreground">
          {t('coaching.sessions.composer.privateNotes.helper')}
        </p>
      </div>

      <DeliveryVodPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        vods={vods}
        defaultSelectedMatchIds={buffer.linkedMatchIds}
        onConfirm={handleConfirmDeliver}
        isPending={createDelivery.isPending}
      />
    </div>
  );
}
