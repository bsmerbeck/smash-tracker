import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Plus, X } from 'lucide-react';
import type { ReviewSection, ReviewSectionKind } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { locateCitationSpans, removeCitationSpan } from '@/lib/citationSpans';
import { formatTimestamp } from '@/lib/vod';
import { CitationChip } from './CitationChip';
import { CitationTextarea } from './CitationTextarea';

/** The four suggested blocks (D-03) — always offered as adds when missing/hidden, in this fixed display order. */
const SUGGESTED_KINDS: ReviewSectionKind[] = ['summary', 'strengths', 'priorities', 'practicePlan'];
/** Optional SSBU-specific sections (12-CONTEXT.md) — offered as adds when missing/hidden. */
const OPTIONAL_KINDS: ReviewSectionKind[] = ['matchupNotes', 'stageNotes', 'drills', 'nextGoals'];

function sectionKindLabel(t: (key: string) => string, kind: ReviewSectionKind): string {
  return t(`coaching.reviews.composer.sections.kinds.${kind}`);
}

export interface ReviewSectionEditorProps {
  sections: ReviewSection[];
  onChangeBody: (sectionId: string, body: string) => void;
  /** Fires the `.../sections/:sectionId/hide` mutation (D-03). */
  onHide: (sectionId: string) => void;
  /** Fires the `.../sections/:sectionId/show` mutation — the Undo counterpart. */
  onShow: (sectionId: string) => void;
  /** Fires the `.../sections` add mutation (restores a hidden suggested block in place, or appends a new section). */
  onAdd: (kind: ReviewSectionKind) => void;
  /**
   * D-04: registers (or unregisters, on unmount/hide) each section's live
   * `<textarea>` element with the composer, keyed by section id — the
   * composer's `Cite` handler reads `document.activeElement` against this
   * map to decide "insert at the focused editor's cursor" vs. "ask which
   * section" (never silently choose). Optional so every existing caller/
   * test that doesn't need citation insertion is unaffected.
   */
  registerTextareaRef?: (sectionId: string, el: HTMLTextAreaElement | null) => void;
  /**
   * 260826-kio: fires when the coach clicks a section's citation chip (in
   * the strip below the textarea). Optional so every existing caller/test
   * that doesn't need chip activation is unaffected.
   */
  onActivateCitation?: (matchId: string, seconds: number) => void;
  /** Resolves a citation's `matchId` to a display source label — see `SafeMarkdownSource`/`safeMarkdown.tsx`'s identical prop for the multi-VOD rationale. */
  resolveCitationSource?: (matchId: string) => { label: string } | undefined;
}

/**
 * The ordered suggested-block editors (D-03): textarea-per-section (D-10 —
 * no rich-text/contentEditable framework), each with an overflow `⋯` menu
 * whose only action is `Hide section` (never an ×) — hiding preserves the
 * section's content (it stays in `sections`, just `hidden: true`) and shows
 * a real, focusable Undo button (D-17). `Add section` offers any missing or
 * currently-hidden suggested/optional block, plus General Notes (always
 * offered — a fresh `general-{uuid}` section every time, since coaches may
 * want more than one).
 */
export function ReviewSectionEditor({
  sections,
  onChangeBody,
  onHide,
  onShow,
  onAdd,
  registerTextareaRef,
  onActivateCitation,
  resolveCitationSource,
}: ReviewSectionEditorProps) {
  const { t } = useTranslation();

  const [lastHidden, setLastHidden] = useState<{ id: string; label: string } | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // The id of a section we're waiting to become visible again (Undo, or a
  // known-kind restore-via-Add) so its overflow menu button can receive
  // focus once it actually renders (D-17: "restoring returns focus to the
  // restored section's heading/menu").
  const pendingFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lastHidden) return;
    // Deferred one tick: radix's overflow-menu `FocusScope` (still tearing
    // itself down at the moment this effect fires) traps and redirects any
    // synchronous focus() call made while it's still active — a `setTimeout`
    // lets that teardown finish first, so our own focus move actually wins.
    const timer = window.setTimeout(() => {
      undoButtonRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [lastHidden]);

  useEffect(() => {
    const pendingId = pendingFocusIdRef.current;
    if (!pendingId) return;
    const restored = sections.find((section) => section.id === pendingId && !section.hidden);
    if (restored) {
      pendingFocusIdRef.current = null;
      const timer = window.setTimeout(() => {
        menuButtonRefs.current.get(pendingId)?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [sections]);

  function registerMenuRef(id: string) {
    return (el: HTMLButtonElement | null) => {
      if (el) {
        menuButtonRefs.current.set(id, el);
      } else {
        menuButtonRefs.current.delete(id);
      }
    };
  }

  function handleHide(section: ReviewSection) {
    onHide(section.id);
    setLastHidden({ id: section.id, label: sectionTitle(section) });
  }

  function handleUndo() {
    if (!lastHidden) return;
    pendingFocusIdRef.current = lastHidden.id;
    onShow(lastHidden.id);
    setLastHidden(null);
  }

  function sectionTitle(section: ReviewSection): string {
    if (section.kind === 'general') {
      return section.title?.trim() || t('coaching.reviews.composer.sections.kinds.general');
    }
    return sectionKindLabel(t, section.kind);
  }

  const visibleSections = sections.filter((section) => !section.hidden);

  // Anything not currently visible is offered as an add: a suggested/optional
  // kind that's either absent entirely or present-but-hidden. General Notes
  // is always offered (every click creates a fresh section).
  const presentVisibleKinds = new Set(visibleSections.map((section) => section.kind));
  const addableKinds = [...SUGGESTED_KINDS, ...OPTIONAL_KINDS].filter(
    (kind) => !presentVisibleKinds.has(kind),
  );

  function handleAdd(kind: ReviewSectionKind) {
    if (kind !== 'general') {
      pendingFocusIdRef.current = kind;
    }
    onAdd(kind);
  }

  return (
    <div className="flex flex-col gap-3">
      {visibleSections.map((section) => {
        // 260826-kio: computed fresh from the CURRENT body on every render —
        // never cached across renders, or the offsets go stale the moment
        // the coach types.
        const citationSpans = locateCitationSpans(section.body).filter(
          (span) => span.token != null,
        );
        return (
          <div key={section.id} className="rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b px-3.5 py-2">
              <h3 className="text-sm font-semibold">{sectionTitle(section)}</h3>
              <div className="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      ref={registerMenuRef(section.id)}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('coaching.reviews.composer.sections.sectionOptionsAria', {
                        section: sectionTitle(section),
                      })}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    // D-17: hiding moves focus to the Undo button ourselves —
                    // suppress radix's default "return focus to the trigger on
                    // close" so it doesn't fight our own focus management.
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    <DropdownMenuItem onSelect={() => handleHide(section)}>
                      {t('coaching.reviews.composer.sections.hideSection')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="px-3.5 py-3">
              <CitationTextarea
                value={section.body}
                onChange={(value) => onChangeBody(section.id, value)}
                ariaLabel={sectionTitle(section)}
                textareaRef={(el) => registerTextareaRef?.(section.id, el)}
                testId={`section-${section.id}`}
                className="min-h-24 border-none p-0 shadow-none focus-visible:ring-0"
              />
            </div>
            {citationSpans.length > 0 && (
              <ul
                aria-label={t('coaching.reviews.composer.citation.stripAria', {
                  section: sectionTitle(section),
                })}
                className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2"
              >
                {citationSpans.map((span) => {
                  const token = span.token!;
                  return (
                    <li key={`${span.start}-${span.end}`} className="flex items-center gap-1">
                      <span onMouseDown={(event) => event.preventDefault()}>
                        <CitationChip
                          matchId={token.sourceVodRef}
                          seconds={token.seconds}
                          label={token.label}
                          source={resolveCitationSource?.(token.sourceVodRef)?.label}
                          onActivate={(matchId, seconds) => onActivateCitation?.(matchId, seconds)}
                        />
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('coaching.reviews.composer.citation.removeAria', {
                          timestamp: formatTimestamp(token.seconds),
                        })}
                        // D-04/F8: a chip's × sits near the section textarea
                        // — preventing the mousedown's default focus move
                        // keeps `document.activeElement` on the textarea so
                        // cursor-insertion citing never silently breaks.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() =>
                          onChangeBody(section.id, removeCitationSpan(section.body, span))
                        }
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}

      {addableKinds.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-center gap-1.5 border-dashed text-muted-foreground"
            >
              <Plus className="size-4" />
              {t('coaching.reviews.composer.sections.addSection')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {addableKinds.map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => handleAdd(kind)}>
                {sectionKindLabel(t, kind)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => handleAdd('general')}>
              {t('coaching.reviews.composer.sections.addGeneralNotes')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {lastHidden && (
        <div className="sticky bottom-2 mx-auto flex items-center gap-2 rounded-md border bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-sm">
          <span>
            {t('coaching.reviews.composer.sections.undoBanner', { section: lastHidden.label })}
          </span>
          <Button
            ref={undoButtonRef}
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 font-semibold"
            onClick={handleUndo}
            aria-label={t('coaching.reviews.composer.sections.undoAria', {
              section: lastHidden.label,
            })}
          >
            {t('coaching.reviews.composer.sections.undo')}
          </Button>
        </div>
      )}
    </div>
  );
}
