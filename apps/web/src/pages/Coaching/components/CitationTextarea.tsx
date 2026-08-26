import { useRef } from 'react';
import type { UIEvent } from 'react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { splitCitationSegments, splitCitationSpanParts } from '@/lib/citationSpans';

/**
 * Metric-safety contract (260826-kio research finding F3): every class in
 * this constant must produce IDENTICAL glyph advance and line-box height on
 * BOTH the mirror div and the textarea layered on top of it. A per-citation
 * span's styling (below) may therefore differ ONLY in paint-level
 * properties — color, background-color, opacity, border-radius. It must
 * NEVER differ in font-family, font-size, font-weight, font-style,
 * letter-spacing, word-spacing, text-transform, padding, margin,
 * border-width, or line-height — any of those would desynchronize the two
 * layers and misalign the caret from the text it visually sits on.
 */
const MIRRORED_TEXT_CLASSES =
  'p-0 text-base leading-normal whitespace-pre-wrap break-words md:text-sm';

export interface CitationTextareaProps {
  /** The full, untransformed textarea value — the single source of truth (F1: never rewritten). */
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Registers (or unregisters, on unmount) the live `<textarea>` DOM node with a caller — mirrors `ReviewSectionEditor`'s `registerTextareaRef` convention. */
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  /** Base for this instance's `data-testid`s (`{testId}` on the textarea, `{testId}-mirror` on the backdrop). */
  testId: string;
  className?: string;
}

/**
 * A backdrop-mirror editor (260826-kio F2): a native `<textarea>` — the
 * SINGLE editing model, so caret, selection, undo/redo, IME, paste, and
 * spellcheck are all completely untouched — layered `text-transparent` on
 * top of an `aria-hidden` mirror div rendering the IDENTICAL string with
 * `{{cite:...}}` token spans tinted and their label sub-range emphasized by
 * color. The value never leaves the textarea; the mirror is purely a paint
 * layer behind it.
 */
export function CitationTextarea({
  value,
  onChange,
  ariaLabel,
  textareaRef,
  testId,
  className,
}: CitationTextareaProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const textareaElRef = useRef<HTMLTextAreaElement | null>(null);

  function setTextareaRef(el: HTMLTextAreaElement | null) {
    textareaElRef.current = el;
    textareaRef?.(el);
  }

  // F5: `field-sizing-content` means the textarea normally grows instead of
  // scrolling internally, so this is defensive belt-and-braces, not the
  // load-bearing part of the mirror-alignment story.
  function handleScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
      mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  const segments = splitCitationSegments(value);

  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden="true"
        data-testid={`${testId}-mirror`}
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden',
          MIRRORED_TEXT_CLASSES,
        )}
      >
        {segments.map((segment, index) => {
          if (segment.kind === 'text') {
            return <span key={`text-${index}`}>{segment.text}</span>;
          }
          const { span } = segment;
          const isValid = span.token != null;
          const parts = splitCitationSpanParts(span.raw);
          const emphasizeLabel = isValid && parts.label.length > 0;
          return (
            <span
              key={`citation-${index}`}
              data-citation-valid={isValid}
              className={cn('rounded-sm', isValid ? 'bg-primary/10' : 'bg-muted/40')}
            >
              <span className="text-muted-foreground/60">{parts.prefix}</span>
              <span className={emphasizeLabel ? 'text-foreground' : 'text-muted-foreground/60'}>
                {parts.label}
              </span>
              <span className="text-muted-foreground/60">{parts.suffix}</span>
            </span>
          );
        })}
        {/* Final-line-box guard: a body ending in a newline still paints its last (empty) line box. */}
        {'\n'}
      </div>
      <Textarea
        ref={setTextareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={handleScroll}
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(
          MIRRORED_TEXT_CLASSES,
          'relative bg-transparent text-transparent caret-foreground selection:bg-primary/30',
          className,
        )}
      />
    </div>
  );
}
