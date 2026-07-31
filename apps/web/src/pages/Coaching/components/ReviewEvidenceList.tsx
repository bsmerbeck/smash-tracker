import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import type { CitationToken, ReviewSection, VodTimestamp } from '@smash-tracker/shared';
import { buildCitationInsertLabel, extractCitationTokens } from '@smash-tracker/shared';
import { formatTimestamp } from '@/lib/vod';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Whether ANY section body already carries a citation token pointing at `sourceMatchId`/`seconds` (D-04's "already-cited indicator"). */
function isAlreadyCited(
  sections: ReviewSection[],
  sourceMatchId: string,
  seconds: number,
): boolean {
  return sections.some((section) =>
    extractCitationTokens(section.body).some(
      (token) => token.sourceVodRef === sourceMatchId && token.seconds === seconds,
    ),
  );
}

export interface ReviewEvidenceListProps {
  /** The currently-selected source VOD's timestamped notes — the evidence rows. */
  timestamps: VodTimestamp[];
  /** The currently-selected source VOD's match id — every citation minted from this list carries it as `sourceVodRef`. `null` when no source is selected yet (every action is disabled). */
  sourceMatchId: string | null;
  /** The review's current section bodies — scanned for already-cited indicators (D-04). */
  sections: ReviewSection[];
  /** Populated by the left pane's `VodPlayer` with the live player's `getCurrentTime` — a one-shot read for "⏱ Cite current moment", never polled. */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Fires with a freshly-built (never-yet-inserted) citation token — the caller (`ReviewComposerPage`) owns cursor-or-ask-section insertion. */
  onCite: (token: CitationToken) => void;
}

/**
 * D-01/D-04: the left pane's Evidence list — the current source VOD's
 * timestamp notes, each with a `Cite` action (a snapshot of the note's
 * CURRENT `seconds`/text, never a live reference — Pattern 3,
 * 12-RESEARCH.md) and an already-cited indicator. A single `⏱ Cite current
 * moment` toolbar action (12-UX-MOCKUP.html's source-bar placement, not
 * per-row) captures the live playback position instead. Insertion
 * semantics (cursor-if-focused / ask-which-section-if-not) live entirely in
 * `ReviewComposerPage`'s `onCite` handler — this component only ever
 * constructs the token and hands it up.
 */
export function ReviewEvidenceList({
  timestamps,
  sourceMatchId,
  sections,
  getCurrentTimeRef,
  onCite,
}: ReviewEvidenceListProps) {
  const { t } = useTranslation();

  // 260731-b1: which evidence rows (by `VodTimestamp.id`) are currently
  // expanded to their full text — collapsed by default, independent per
  // row. Replaced immutably on toggle (never mutated in place).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleCiteCurrentMoment() {
    if (!sourceMatchId) return;
    const seconds = getCurrentTimeRef.current?.() ?? 0;
    onCite({ sourceVodRef: sourceMatchId, seconds, label: '' });
  }

  function handleCiteNote(note: VodTimestamp) {
    if (!sourceMatchId) return;
    // 260731-b1: the INSERTED label is shortened to
    // `CITATION_INSERT_LABEL_MAX_LENGTH` (~40 chars) via
    // `buildCitationInsertLabel` — the stored/parsed citation grammar itself
    // (`citationTokenSchema`'s 200-char `label` cap) is untouched; this is
    // the ONLY place the inserted label is shortened (see F2).
    onCite({
      sourceVodRef: sourceMatchId,
      seconds: note.seconds,
      label: buildCitationInsertLabel(note.note),
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t('coaching.reviews.composer.evidence.heading', { count: timestamps.length })}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!sourceMatchId}
          // Prevents the button from stealing focus away from a currently
          // focused section textarea — D-04's cursor-insertion semantics
          // depend on `document.activeElement` still being the textarea by
          // the time `onClick` fires (mirrors VodManagerPage's identical
          // Save/Cancel-button discipline for preserving input focus).
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleCiteCurrentMoment}
        >
          <Clock className="size-3.5" aria-hidden="true" />
          {t('coaching.reviews.composer.evidence.citeCurrentMoment')}
        </Button>
      </div>

      {timestamps.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('coaching.reviews.composer.evidence.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {timestamps.map((entry) => {
            const cited =
              sourceMatchId != null && isAlreadyCited(sections, sourceMatchId, entry.seconds);
            const isExpanded = expandedIds.has(entry.id);
            return (
              <li
                key={entry.id}
                className="flex items-start gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="shrink-0 font-mono text-foreground">
                  {formatTimestamp(entry.seconds)}
                </span>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded
                      ? t('coaching.reviews.composer.evidence.collapseNote')
                      : t('coaching.reviews.composer.evidence.expandNote')
                  }
                  // 260731-b1: without this, expanding a note steals focus
                  // away from a currently focused section textarea — the
                  // coach's very next Cite would then fall out of the
                  // cursor-insertion path into the ask-which-section dialog
                  // (same discipline as the sibling Cite/current-moment
                  // buttons below).
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggleExpanded(entry.id)}
                  className={cn(
                    'min-w-0 flex-1 text-left text-muted-foreground',
                    isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate',
                  )}
                >
                  {entry.note}
                </button>
                {cited && (
                  <span className="shrink-0 text-[10px] font-medium text-green-600 dark:text-green-400">
                    {t('coaching.reviews.composer.evidence.citedIndicator')}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-xs"
                  disabled={!sourceMatchId}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleCiteNote(entry)}
                >
                  {t('coaching.reviews.composer.evidence.cite')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
