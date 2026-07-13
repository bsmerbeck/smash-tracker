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
  /** Fires with the FULL next quick-tag set whenever Customize adds/removes
   * a tag — the caller owns persistence via `persistQuickTags`. */
  onQuickTagsChange: (next: string[]) => void;
  /** Custom tag vocabulary derived across all loaded VOD matches — offered
   * in the Customize add-combobox alongside the note presets. */
  tagVocabulary: string[];
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
 */
export function QuickTagPanel({
  quickTags,
  disabled,
  onQuickTag,
  onQuickTagsChange,
  tagVocabulary,
}: QuickTagPanelProps) {
  const { t } = useTranslation();
  const [customizing, setCustomizing] = useState(false);

  function handleAddQuickTag(tag: string) {
    onQuickTagsChange(addTagToList(quickTags, tag, MAX_QUICK_TAGS));
  }

  function handleRemoveQuickTag(tag: string) {
    onQuickTagsChange(removeTagFromList(quickTags, tag));
  }

  return (
    <div
      role="region"
      aria-label={t('vodManager.capture.title')}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('vodManager.capture.title')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={customizing}
          aria-label={t('vodManager.capture.customizeAria')}
          onClick={() => setCustomizing((current) => !current)}
        >
          {t('vodManager.capture.customize')}
        </Button>
      </div>
      {!customizing && (
        <p className="text-xs text-muted-foreground">{t('vodManager.capture.quickTagHint')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {quickTags.map((tagSlug) => {
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
            existingTags={quickTags}
            vocabulary={tagVocabulary}
            onAdd={handleAddQuickTag}
            ariaLabel={t('tags.addAria')}
          />
        )}
      </div>
    </div>
  );
}
