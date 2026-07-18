import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import type { Match, UpdateMatchInput, VodTimestamp } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import { useCreateNote, useDeleteNote } from '@/hooks/useVodNotes';
import { formatTimestamp, parseTimestamp, vodDeepLink } from '@/lib/vod';

const LOCAL_ID_PREFIX = 'local-';

/**
 * Builds the `UpdateMatchInput` PATCH payload for `match`'s vodUrl (and
 * optionally tags), carrying every other field through unchanged. Required
 * because `PATCH /api/matches/:id` is a full overwrite (see
 * `RtdbService.updateMatch`) — omitting a field here would clear it, not
 * leave it untouched.
 *
 * Phase 8: narrowed to `{ vodUrl, tags? }` — `vodTimestamps` is no longer a
 * parameter at all. Note writes (add/remove) go through the dedicated
 * `useCreateNote`/`useDeleteNote` endpoints instead (this dialog's own
 * `handleSave`, below), and the server preserves any existing note subtree
 * automatically on every match-fact PATCH that omits it, so there is nothing
 * left for this helper to carry through for notes.
 *
 * `tags` (TAG-01..05) defaults to carrying `match.tags` through unchanged —
 * every existing caller preserves match-level tags automatically without
 * having to know tags exist. Pass `overrides.tags` to override (e.g.
 * `SelectedMatchMeta`'s tag add/remove handlers); override wins when set,
 * even to `undefined` (clearing all tags) — that's why this is a distinct
 * key in `overrides` rather than folded into the `match.tags` fallback.
 */
export function buildUpdateInput(
  match: Match,
  overrides: {
    vodUrl: string | undefined;
    tags?: string[] | undefined;
  },
): UpdateMatchInput {
  return {
    fighter_id: match.fighter_id,
    opponent_id: match.opponent_id,
    map: match.map ?? { id: 0, name: 'no selection' },
    opponent: match.opponent ?? '',
    notes: match.notes ?? '',
    matchType: match.matchType ? match.matchType : 'none',
    win: match.win,
    ...(match.stocksLeft !== undefined ? { stocksLeft: match.stocksLeft } : {}),
    ...(match.eventName !== undefined ? { eventName: match.eventName } : {}),
    ...(match.tournamentName !== undefined ? { tournamentName: match.tournamentName } : {}),
    // gsp is carried through too — omitting it here used to wipe a
    // QuickLogger match's GSP the moment VOD notes were added.
    ...(match.gsp !== undefined ? { gsp: match.gsp } : {}),
    ...(overrides.vodUrl !== undefined ? { vodUrl: overrides.vodUrl } : {}),
    // 'tags' in overrides (not just overrides.tags !== undefined) is the
    // deliberate check here: a caller that explicitly passes `tags: undefined`
    // (SelectedMatchMeta clearing the last tag) means "omit tags from the
    // payload, don't fall back to match.tags" — that's how the last tag gets
    // dropped. A caller that never mentions `tags` at all (every other
    // existing call site) means "I don't know/care about tags, carry the
    // current value through unchanged."
    ...('tags' in overrides
      ? overrides.tags !== undefined
        ? { tags: overrides.tags }
        : {}
      : match.tags !== undefined
        ? { tags: match.tags }
        : {}),
  };
}

const MAX_TIMESTAMPS = 20;

/**
 * Dialog for attaching a VOD link and timestamped notes to a match (V7-E),
 * e.g. "2:41 — missed punish on shield". Opened from `SetTimeline` (per-set
 * VOD edit affordance) and `MatchTable` (per-row VOD icon button).
 *
 * Phase 8 re-point (resolved directive: re-point, do not retire): the UI is
 * unchanged, but persistence no longer rides one full-match PATCH. `Save`
 * diffs the local draft against the note ids that existed when the dialog
 * opened — new (`local-`-prefixed) entries go through `useCreateNote`,
 * removed existing ids go through `useDeleteNote` — and only PATCHes the
 * match (via the now-narrowed `buildUpdateInput`) for the `vodUrl` field.
 * There's no in-place edit affordance in this dialog (only add/remove), so
 * `useUpdateNote` is never needed here.
 */
export function VodNotesDialog({
  match,
  open,
  onOpenChange,
}: {
  match: Match;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const updateMatch = useUpdateMatch();
  const createNote = useCreateNote();
  const deleteNote = useDeleteNote();
  const [url, setUrl] = useState(match.vodUrl ?? '');
  const [timestamps, setTimestamps] = useState<VodTimestamp[]>(match.vodTimestamps ?? []);
  // The note ids that existed on the server when the dialog was opened —
  // the baseline `handleSave` diffs against to know which ids were removed.
  const [initialNoteIds, setInitialNoteIds] = useState<string[]>(
    (match.vodTimestamps ?? []).map((stamp) => stamp.id),
  );
  const [timeInput, setTimeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);
  const isSaving = updateMatch.isPending || createNote.isPending || deleteNote.isPending;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      setUrl(match.vodUrl ?? '');
      setTimestamps(match.vodTimestamps ?? []);
      setInitialNoteIds((match.vodTimestamps ?? []).map((stamp) => stamp.id));
      setTimeInput('');
      setNoteInput('');
      setTimeError(null);
    }
  }

  function handleAddTimestamp() {
    const seconds = parseTimestamp(timeInput);
    if (seconds == null) {
      setTimeError(t('shared.vod.timeFormatError'));
      return;
    }
    const note = noteInput.trim();
    if (!note) {
      setTimeError(t('shared.vod.noteRequired'));
      return;
    }
    if (timestamps.length >= MAX_TIMESTAMPS) {
      setTimeError(t('shared.vod.timestampLimit', { max: MAX_TIMESTAMPS }));
      return;
    }
    // `VodTimestamp` is id-bearing. This dialog edits a local draft array
    // and only persists on Save (below), so a freshly-added entry gets a
    // synthetic local id — never a real key — that `handleSave` recognizes
    // and creates via the dedicated note endpoint.
    setTimestamps((prev) =>
      [...prev, { id: `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`, seconds, note }].sort(
        (a, b) => a.seconds - b.seconds,
      ),
    );
    setTimeInput('');
    setNoteInput('');
    setTimeError(null);
  }

  function handleRemoveTimestamp(id: string) {
    setTimestamps((prev) => prev.filter((stamp) => stamp.id !== id));
  }

  async function handleSave() {
    const currentIds = new Set(
      timestamps.filter((stamp) => !stamp.id.startsWith(LOCAL_ID_PREFIX)).map((stamp) => stamp.id),
    );
    const removedIds = initialNoteIds.filter((id) => !currentIds.has(id));
    const newEntries = timestamps.filter((stamp) => stamp.id.startsWith(LOCAL_ID_PREFIX));

    try {
      // Deletes first, then creates — frees up the shared 20-note cap
      // before any new note attempts to claim a slot.
      await Promise.all(
        removedIds.map((noteId) => deleteNote.mutateAsync({ matchId: match.id, noteId })),
      );
      await Promise.all(
        newEntries.map((entry) =>
          createNote.mutateAsync({
            matchId: match.id,
            input: { seconds: entry.seconds, note: entry.note },
          }),
        ),
      );

      const trimmedUrl = url.trim();
      const input = buildUpdateInput(match, { vodUrl: trimmedUrl ? trimmedUrl : undefined });
      await updateMatch.mutateAsync({ id: match.id, input });

      toast.success(t('shared.vod.saved'));
      onOpenChange(false);
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('shared.vod.title')}</DialogTitle>
          <DialogDescription>{t('shared.vod.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vod-url">{t('shared.vod.url')}</Label>
            <Input
              id="vod-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('shared.vod.timestamps')}</Label>
            {timestamps.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('shared.vod.noTimestamps')}</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label={t('shared.vod.timestampsAria')}>
                {timestamps.map((stamp) => (
                  <li
                    key={stamp.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {url.trim() ? (
                        <a
                          href={vodDeepLink(url.trim(), stamp.seconds)}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 font-mono text-primary hover:underline"
                        >
                          {formatTimestamp(stamp.seconds)}
                        </a>
                      ) : (
                        <span className="shrink-0 font-mono">{formatTimestamp(stamp.seconds)}</span>
                      )}
                      <span className="truncate">{stamp.note}</span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('shared.vod.deleteTimestamp', {
                        time: formatTimestamp(stamp.seconds),
                      })}
                      onClick={() => handleRemoveTimestamp(stamp.id)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-1 flex flex-wrap items-start gap-2">
              <Input
                value={timeInput}
                onChange={(e) => {
                  setTimeInput(e.target.value);
                  setTimeError(null);
                }}
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
                placeholder={t('shared.vod.notePlaceholder')}
                aria-label={t('shared.vod.noteAria')}
                maxLength={200}
                className="min-w-[10rem] flex-1"
              />
              <Button type="button" variant="outline" size="icon-sm" onClick={handleAddTimestamp}>
                <Plus />
                <span className="sr-only">{t('shared.vod.addTimestamp')}</span>
              </Button>
            </div>
            {timeError && <p className="text-sm text-destructive">{timeError}</p>}
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
