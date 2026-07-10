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
import { formatTimestamp, parseTimestamp, vodDeepLink } from '@/lib/vod';

/**
 * Builds the full `UpdateMatchInput` PATCH payload for `match`, carrying
 * every existing field through unchanged except `vodUrl`/`vodTimestamps`
 * (overridden by the caller). Required because `PATCH /api/matches/:id` is a
 * full overwrite (see `RtdbService.updateMatch`) — omitting a field here
 * would clear it, not leave it untouched.
 *
 * Exported so `MatchTable`'s "Remove VOD link" action (its VOD icon's
 * dropdown menu) can reuse the exact same full-overwrite-minus-VOD-fields
 * payload rather than re-deriving it.
 */
export function buildUpdateInput(
  match: Match,
  overrides: { vodUrl: string | undefined; vodTimestamps: VodTimestamp[] | undefined },
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
    ...(overrides.vodTimestamps !== undefined ? { vodTimestamps: overrides.vodTimestamps } : {}),
  };
}

const MAX_TIMESTAMPS = 20;

/**
 * Dialog for attaching a VOD link and timestamped notes to a match (V7-E),
 * e.g. "2:41 — missed punish on shield". Opened from `SetTimeline` (per-set
 * VOD edit affordance) and `MatchTable` (per-row VOD icon button). Saves via
 * `useUpdateMatch` — a full PATCH carrying every other field through
 * unchanged (see `buildUpdateInput`).
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
  const [url, setUrl] = useState(match.vodUrl ?? '');
  const [timestamps, setTimestamps] = useState<VodTimestamp[]>(match.vodTimestamps ?? []);
  const [timeInput, setTimeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      setUrl(match.vodUrl ?? '');
      setTimestamps(match.vodTimestamps ?? []);
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
    setTimestamps((prev) => [...prev, { seconds, note }].sort((a, b) => a.seconds - b.seconds));
    setTimeInput('');
    setNoteInput('');
    setTimeError(null);
  }

  function handleRemoveTimestamp(index: number) {
    setTimestamps((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    const trimmedUrl = url.trim();
    const input = buildUpdateInput(match, {
      vodUrl: trimmedUrl ? trimmedUrl : undefined,
      vodTimestamps: timestamps.length > 0 ? timestamps : undefined,
    });
    try {
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
                {timestamps.map((stamp, index) => (
                  <li
                    key={`${stamp.seconds}-${index}`}
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
                      onClick={() => handleRemoveTimestamp(index)}
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
          <Button type="button" onClick={handleSave} disabled={updateMatch.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
