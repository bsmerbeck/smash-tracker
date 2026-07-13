import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { NOTE_PRESET_TAGS, addTagToList, removeTagFromList, tagLabel } from '@/lib/tags';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagAddCombobox } from './TagAddCombobox';

/** Generous cap on the quick-tag button set itself (distinct from
 * `MAX_TIMESTAMPS`, the per-match note cap, and `MAX_NOTE_TAGS`, the
 * per-note tag cap) — keeps the panel's own `addTagToList` call bounded
 * without inventing new i18n surface for an edge nobody is expected to hit. */
const MAX_QUICK_TAGS = 20;

export interface QuickTagPanelProps {
  /** The user's customized (or default) quick-tag button set, in display
   * order — persisted device-side via `vodPrefs.ts` by the caller. */
  quickTags: string[];
  /** Disables every capture button (e.g. no VOD selected/playable). */
  disabled?: boolean;
  /** Fires with the clicked button's tag slug — the caller (VodManagerPage)
   * owns the instant-capture PATCH via `handleUpdateTimestamps`. */
  onQuickTag: (tagSlug: string) => void;
  /** Fires with the FULL next quick-tag set once the user explicitly Saves
   * (or hits Done with no changes) — the caller owns persistence via
   * `persistQuickTags`. Never fires on every individual add/remove inside
   * customize mode; edits stay LOCAL until committed (see `draftTags`
   * below). */
  onQuickTagsChange: (next: string[]) => void;
  /** Custom tag vocabulary derived across all loaded VOD matches — offered
   * in the Customize add-combobox alongside the note presets. */
  tagVocabulary: string[];
}

/** Same-membership, order-INSENSITIVE comparison — the customize UI lets the
 * user add/remove tags but never reorder them, so this is a cheap-but-exact
 * way to answer "does the draft actually differ from what's persisted" for
 * the Done/Save button-label + Save/Cancel gate. */
function tagSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bSorted = [...b].sort();
  return [...a].sort().every((tag, i) => tag === bSorted[i]);
}

/**
 * A distinct "Quick tags" panel (Catapult-MatchTracker-inspired capture
 * ergonomics, revised 2026-07-13) mounted directly below the player: one
 * click on a button instantly captures a timestamp note at the current
 * playback time, pre-tagged with that tag, via the caller's existing
 * `handleUpdateTimestamps` PATCH site — never a parallel mutation. The
 * panel's own tag SET is customizable (presets AND freeform custom tags)
 * via the reused `TagAddCombobox`, and persists per device (`vodPrefs.ts`,
 * no server storage). Playlist-agnostic — renders whenever a VOD is
 * playable, in Library view or inside a playlist.
 *
 * Customize mode edits a LOCAL draft (`draftTags`), never the live
 * `quickTags` prop directly — entering customize snapshots the current set;
 * add/remove only mutate the draft. The primary button reads "Done" while
 * the draft is pristine (a plain exit, no PATCH-equivalent persistence
 * call); the moment it diverges it becomes "Save" with a sibling "Cancel"
 * that discards the draft and reverts to the pre-edit set. `onQuickTagsChange`
 * (the caller's persistence hook) fires ONLY from Save, or from Done when
 * there IS a pending draft to commit — never on every individual
 * add/remove, unlike the pre-fix-up behavior.
 */
export function QuickTagPanel({
  quickTags,
  disabled,
  onQuickTag,
  onQuickTagsChange,
  tagVocabulary,
}: QuickTagPanelProps) {
  const { t } = useTranslation();
  // `null` when NOT customizing — the sentinel this component uses to
  // decide which of the two render branches (buttons vs. removable chips)
  // to show, doubling as "is there an in-progress draft to persist".
  const [draftTags, setDraftTags] = useState<string[] | null>(null);
  const customizing = draftTags !== null;
  const isDirty = customizing && !tagSetsEqual(draftTags, quickTags);

  function handleEnterCustomize() {
    setDraftTags([...quickTags]);
  }

  function handleAddQuickTag(tag: string) {
    setDraftTags((current) => addTagToList(current ?? quickTags, tag, MAX_QUICK_TAGS));
  }

  function handleRemoveQuickTag(tag: string) {
    setDraftTags((current) => removeTagFromList(current ?? quickTags, tag));
  }

  // Done (pristine) or Save (dirty) — persists (Save only; Done has nothing
  // to persist) and exits customize mode either way.
  function handleDoneOrSave() {
    if (draftTags && isDirty) {
      onQuickTagsChange(draftTags);
    }
    setDraftTags(null);
  }

  // Cancel — discards the draft, reverting to the pre-edit set, WITHOUT
  // calling onQuickTagsChange.
  function handleCancel() {
    setDraftTags(null);
  }

  const displayedTags = draftTags ?? quickTags;

  return (
    <div
      role="region"
      aria-label={t('vodManager.capture.title')}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('vodManager.capture.title')}</span>
        <div className="flex items-center gap-2">
          {customizing && isDirty && (
            <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
              {t('common.cancel')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={customizing}
            aria-label={
              !customizing
                ? t('vodManager.capture.customizeAria')
                : isDirty
                  ? t('vodManager.capture.saveCustomizeAria')
                  : t('vodManager.capture.doneCustomizeAria')
            }
            onClick={customizing ? handleDoneOrSave : handleEnterCustomize}
          >
            {!customizing
              ? t('vodManager.capture.customize')
              : isDirty
                ? t('common.save')
                : t('vodManager.capture.done')}
          </Button>
        </div>
      </div>
      {!customizing && (
        <p className="text-xs text-muted-foreground">{t('vodManager.capture.quickTagHint')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {displayedTags.map((tagSlug) => {
          const label = tagLabel(t, tagSlug);
          if (customizing) {
            return (
              <Badge key={tagSlug} variant="secondary" className="gap-1">
                {label}
                <button
                  type="button"
                  aria-label={t('vodManager.capture.removeQuickTagAria', { label })}
                  onClick={() => handleRemoveQuickTag(tagSlug)}
                  className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          }
          return (
            <Button
              key={tagSlug}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={t('vodManager.capture.quickTagAria', { label })}
              onClick={() => onQuickTag(tagSlug)}
            >
              {label}
            </Button>
          );
        })}
        {customizing && (
          <TagAddCombobox
            presets={NOTE_PRESET_TAGS}
            existingTags={displayedTags}
            vocabulary={tagVocabulary}
            onAdd={handleAddQuickTag}
            ariaLabel={t('tags.addAria')}
          />
        )}
      </div>
    </div>
  );
}
