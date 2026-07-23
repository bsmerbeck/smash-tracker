import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Match, UpdateMatchInput } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import { formatTimestamp, parseFlexibleTimestamp } from '@/lib/vod';
import { buildUpdateInput } from './VodNotesDialog';

/**
 * Lean "Attach VOD" dialog (SETFEAT-03): the Match History camera icon and
 * SetTimeline's VOD button both open this instead of the full
 * timestamped-notes editor (`VodNotesDialog`, whose notes UI now lives only
 * in the VOD Manager). Same prop signature as `VodNotesDialog` (`{ match,
 * open, onOpenChange }`) so it's a drop-in swap at both call sites — this
 * dialog only collects a VOD URL and its start-time offset.
 *
 * Reuses `VodNotesDialog`'s `buildUpdateInput` for every other field's
 * carry-through (full-overwrite PATCH safety), but overrides its
 * `vodStartSeconds` carry-through with this dialog's own start-time field:
 * present only when the URL is non-blank AND the typed offset parses,
 * otherwise omitted — same "clearing the link drops the start time too"
 * convention as `matchFormValuesToInput` (Phase 17's carry-through fix stays
 * intact for the untouched-save case).
 */
export function AttachVodDialog({
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
  const [startTimeInput, setStartTimeInput] = useState(
    match.vodStartSeconds !== undefined ? formatTimestamp(match.vodStartSeconds) : '',
  );
  const [urlError, setUrlError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const vodLinkPresent = url.trim() !== '';

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      setUrl(match.vodUrl ?? '');
      setStartTimeInput(
        match.vodStartSeconds !== undefined ? formatTimestamp(match.vodStartSeconds) : '',
      );
      setUrlError(null);
      setTimeError(null);
    }
  }

  async function handleSave() {
    const trimmedUrl = url.trim();
    const trimmedTime = startTimeInput.trim();

    const urlValid = trimmedUrl === '' || z.string().url().safeParse(trimmedUrl).success;
    if (!urlValid) {
      setUrlError(t('matchForm.validation.vodUrlInvalid'));
      return;
    }
    setUrlError(null);

    const parsedSeconds = trimmedTime === '' ? null : parseFlexibleTimestamp(trimmedTime);
    if (trimmedTime !== '' && parsedSeconds === null) {
      setTimeError(t('matchForm.validation.vodStartSecondsInvalid'));
      return;
    }
    setTimeError(null);

    // Carry every other field through unchanged, then override the
    // start-time carry-through with this dialog's own field: present only
    // when the URL is non-blank and the offset parses, `delete`d (never left
    // as an explicit `undefined`, which `toHaveProperty`/RTDB would still see
    // as present) otherwise — same "clear the link, clear the start time"
    // convention as `matchFormValuesToInput`.
    const input: UpdateMatchInput = {
      ...buildUpdateInput(match, { vodUrl: trimmedUrl ? trimmedUrl : undefined }),
    };
    if (trimmedUrl && parsedSeconds !== null) {
      input.vodStartSeconds = parsedSeconds;
    } else {
      delete input.vodStartSeconds;
    }

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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('shared.vod.attachTitle')}</DialogTitle>
          <DialogDescription>{t('shared.vod.attachDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attach-vod-url">{t('shared.vod.url')}</Label>
            <Input
              id="attach-vod-url"
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlError(null);
              }}
              placeholder={t('matchForm.vodUrlPlaceholder')}
            />
            {urlError && <p className="text-sm text-destructive">{urlError}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attach-vod-start-time">{t('matchForm.vodStartSeconds.label')}</Label>
            <Input
              id="attach-vod-start-time"
              type="text"
              value={startTimeInput}
              disabled={!vodLinkPresent}
              onChange={(e) => {
                setStartTimeInput(e.target.value);
                setTimeError(null);
              }}
              placeholder={t('matchForm.vodStartSeconds.placeholder')}
            />
            {timeError && <p className="text-sm text-destructive">{timeError}</p>}
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <PendingButton type="button" pending={updateMatch.isPending} onClick={handleSave}>
            {t('common.save')}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
