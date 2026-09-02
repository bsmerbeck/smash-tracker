import { useCallback, useLayoutEffect, useRef } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { parseCitationToken } from '@smash-tracker/shared';
import type { CitationToken } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/vod';
import {
  CITATION_CHIP_ATTR,
  CITATION_CHIP_GLYPH,
  getEditorCaretOffset,
  getEditorSelectionRange,
  mapCaretAcrossValueChange,
  needsDomNormalization,
  renderEditorDom,
  serializeEditorDom,
  setEditorCaretOffset,
  spliceEditorValue,
} from '@/lib/citationDom';
import type { CitationChipDescriptor } from '@/lib/citationDom';

export interface CitationEditorProps {
  /** The full, untransformed body — still the single source of truth. */
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** `data-testid` for the editor host. */
  testId: string;
  className?: string;
  /** Registers (or unregisters, on unmount) the live editor host with a caller — the composer's Cite handler matches it against `document.activeElement`. */
  editorRef?: (el: HTMLElement | null) => void;
  /** Fires when the coach clicks an INLINE chip (the strip below the editor has its own identical wiring). */
  onActivateCitation?: (matchId: string, seconds: number) => void;
  /** Resolves a citation's `matchId` to a display source label — see `SafeMarkdownSource`/`safeMarkdown.tsx`'s identical prop for the multi-VOD rationale. */
  resolveCitationSource?: (matchId: string) => { label: string } | undefined;
}

/**
 * 260826-s46: a minimal plain-text `contentEditable` editor whose model is
 * still the stored string. Every citation renders as an ATOMIC chip inside
 * the editable text — the `{{cite:...}}` grammar's raw token text is never
 * visible in the edit surface for a valid citation. This replaces the
 * backdrop-mirror `<textarea>` from 260826-kio, which the owner rejected
 * precisely because full tokens stayed on screen.
 *
 * React renders exactly ONE element here and NEVER owns its children
 * (research finding F4): if React managed children of a `contentEditable`
 * node while the browser also mutated them, React's next diff could operate
 * on a stale mapping and throw. Every child node is therefore built
 * imperatively by `renderEditorDom`, which also means chips are plain DOM
 * elements rather than `CitationChip` React components — hence the glyph
 * character instead of a lucide SVG.
 *
 * The external contract is unchanged from the component it replaces:
 * `value: string` in, `onChange(string)` out. Autosave, revisions, the
 * conflict dialog and publish are untouched.
 *
 * There is deliberately no `disabled`/`readOnly` prop: the section editor
 * never passed either, and an unused mode would be untested surface. That
 * omission was checked, not forgotten.
 *
 * Known limitation (recorded rather than worked around): a programmatic DOM
 * rebuild can disturb the browser's native undo stack, so Ctrl+Z after a
 * normalization is not guaranteed. Rebuilds are rare by design — they only
 * happen when the DOM's serialization diverges from the value, or when a
 * token/stray element appears.
 */
export function CitationEditor({
  value,
  onChange,
  ariaLabel,
  testId,
  className,
  editorRef,
  onActivateCitation,
  resolveCitationSource,
}: CitationEditorProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** What the host's DOM currently serializes to — the de-duplication key for `onChange`. */
  const lastSerializedRef = useRef('');
  /** True between `compositionstart` and `compositionend`; NO code path may rebuild the DOM while it is set. */
  const isComposingRef = useRef(false);

  const describeChip = useCallback(
    (token: CitationToken): CitationChipDescriptor => {
      const timestamp = formatTimestamp(token.seconds);
      const source = resolveCitationSource?.(token.sourceVodRef)?.label;
      const base = source
        ? t('coaching.reviews.composer.citation.jumpToSourceAria', { timestamp, source })
        : t('coaching.reviews.composer.citation.jumpAria', { timestamp });
      return {
        // Mirrors `CitationChip`'s own visible text (play affordance,
        // timestamp, then the label after a spaced em dash when present).
        text: `${CITATION_CHIP_GLYPH} ${timestamp}${token.label ? ` — ${token.label}` : ''}`,
        ariaLabel: token.label ? `${base}: ${token.label}` : base,
      };
    },
    [t, resolveCitationSource],
  );

  function setHostRef(el: HTMLDivElement | null) {
    hostRef.current = el;
    editorRef?.(el);
  }

  /**
   * The single path for every SYNTHETIC mutation (Enter, paste, cut): render
   * the new string, remember it, place the caret, emit. Because it re-renders
   * from the string it is about to emit, any valid token inside that string
   * becomes a chip in the SAME handler — a raw token is never left in the
   * edit surface, not even for one frame.
   */
  function commit(nextValue: string, caretOffset: number) {
    const host = hostRef.current;
    if (!host) return;
    renderEditorDom(host, nextValue, describeChip);
    lastSerializedRef.current = nextValue;
    setEditorCaretOffset(host, caretOffset);
    onChange(nextValue);
  }

  /** Serialize the live DOM, emit when it changed, then normalize when the DOM has diverged from its own serialization. */
  function syncFromDom() {
    const host = hostRef.current;
    if (!host) return;

    const serialized = serializeEditorDom(host);
    if (serialized !== lastSerializedRef.current) {
      lastSerializedRef.current = serialized;
      onChange(serialized);
    }

    if (isComposingRef.current) return;
    if (!needsDomNormalization(host, serialized)) return;

    const caret = getEditorCaretOffset(host);
    // Byte-neutral by construction — this re-renders the exact string it just
    // serialized, so it must NOT emit a second onChange.
    renderEditorDom(host, serialized, describeChip);
    lastSerializedRef.current = serialized;
    if (caret != null) {
      setEditorCaretOffset(host, caret);
    }
  }

  /** The selection in serialized-string space, falling back to a collapsed caret at the end. */
  function readRange(serialized: string): { start: number; end: number } {
    const host = hostRef.current;
    const range = host ? getEditorSelectionRange(host) : null;
    return range ?? { start: serialized.length, end: serialized.length };
  }

  function findChip(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(`[${CITATION_CHIP_ATTR}]`);
  }

  function handleCompositionStart() {
    isComposingRef.current = true;
  }

  function handleCompositionEnd() {
    isComposingRef.current = false;
    // Where a token typed through an IME finally becomes a chip.
    syncFromDom();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter') return;
    // Control/Meta/Alt+Enter mean something else (submit, newline-in-app
    // shortcuts) — leave those to whoever owns them.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    event.preventDefault();
    const host = hostRef.current;
    if (!host) return;

    // Splicing a newline into the STRING removes the browser's
    // <div>/<br>/bogus-<br> block-insertion ambiguity from the main path.
    const serialized = serializeEditorDom(host);
    const { start, end } = readRange(serialized);
    commit(spliceEditorValue(serialized, start, end, '\n'), start + 1);
  }

  function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const host = hostRef.current;
    if (!host) return;

    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length === 0) return;

    const serialized = serializeEditorDom(host);
    const { start, end } = readRange(serialized);
    commit(spliceEditorValue(serialized, start, end, pasted), start + pasted.length);
  }

  /** Writes the selected range's SERIALIZED substring to the clipboard, so copying a chip yields its stored token. */
  function writeSelectionToClipboard(
    event: ReactClipboardEvent<HTMLDivElement>,
  ): { serialized: string; start: number; end: number } | null {
    const host = hostRef.current;
    if (!host) return null;
    const range = getEditorSelectionRange(host);
    const { clipboardData } = event;
    if (!range || !clipboardData) return null;

    const serialized = serializeEditorDom(host);
    clipboardData.setData('text/plain', serialized.slice(range.start, range.end));
    return { serialized, start: range.start, end: range.end };
  }

  function handleCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    writeSelectionToClipboard(event);
  }

  function handleCut(event: ReactClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const written = writeSelectionToClipboard(event);
    if (!written) return;
    commit(spliceEditorValue(written.serialized, written.start, written.end, ''), written.start);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    // Rejected outright: computing a drop caret needs `caretRangeFromPoint`,
    // which the test environment does not implement — accepting the drop
    // would make this the one edit path with no automated coverage.
    event.preventDefault();
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    // F8: never let a click move the caret/focus into a non-editable atom —
    // cursor-position citing reads `document.activeElement`.
    if (findChip(event.target)) {
      event.preventDefault();
    }
  }

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const chip = findChip(event.target);
    if (!chip) return;
    // Never trust the attribute: a DOM-injected value must not drive a seek.
    const token = parseCitationToken(chip.getAttribute(CITATION_CHIP_ATTR) ?? '');
    if (!token) return;
    onActivateCitation?.(token.sourceVodRef, token.seconds);
  }

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || isComposingRef.current) return;

    const serialized = serializeEditorDom(host);
    if (serialized === value) {
      // The guard that keeps typing from being interrupted by a
      // caret-destroying rebuild on every keystroke's round trip through the
      // parent's state.
      lastSerializedRef.current = value;
      return;
    }

    const hadFocus = host.ownerDocument.activeElement === host;
    const caret = hadFocus ? getEditorCaretOffset(host) : null;

    renderEditorDom(host, value, describeChip);
    lastSerializedRef.current = value;

    if (hadFocus && caret != null) {
      setEditorCaretOffset(host, mapCaretAcrossValueChange(serialized, value, caret));
    }
  }, [value, describeChip]);

  return (
    <div
      ref={setHostRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-testid={testId}
      spellCheck
      className={cn(
        // Typography parity with the textarea this replaces. A
        // contentEditable host grows with its content natively, so the
        // caller's min-height is the only sizing carried over.
        'text-base leading-normal break-words whitespace-pre-wrap outline-none md:text-sm',
        className,
      )}
      onInput={syncFromDom}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onCopy={handleCopy}
      onCut={handleCut}
      onDrop={handleDrop}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    />
  );
}
