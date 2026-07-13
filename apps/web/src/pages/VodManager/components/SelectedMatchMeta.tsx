import type { RefObject } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import type { Fighter, Match, UpdateMatchInput } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { formatTimestamp } from '@/lib/vod';
import { MATCH_PRESET_TAGS, addTagToList, removeTagFromList, tagLabel } from '@/lib/tags';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import { buildUpdateInput } from '@/components/vod/VodNotesDialog';
import { tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagAddCombobox } from './TagAddCombobox';
import {
  MatchFormFields,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';
import { matchToFormValues } from '@/components/match-form/EditMatchForm';

const MAX_MATCH_TAGS = 10;

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
}: {
  match: Match;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  /** Populated by `VodPlayer` with the live player's `getCurrentTime` function once available. */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Custom tag vocabulary derived across ALL loaded VOD matches (03-02 locked decision) — fed into the match TagAddCombobox's "your existing custom tags" group. */
  tagVocabulary: string[];
}) {
  const { t } = useTranslation();
  const updateMatch = useUpdateMatch();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);

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
      <div className="flex items-center justify-between gap-2">
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
    </div>
  );
}
