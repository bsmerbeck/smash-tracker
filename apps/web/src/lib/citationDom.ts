import type { CitationToken } from '@smash-tracker/shared';
import { locateCitationSpans, splitCitationSegments } from '@/lib/citationSpans';

/**
 * 260826-s46: the DOM<->string layer behind the review composer's inline
 * citation editor. The MODEL is still the stored string — this module only
 * translates that string into editable DOM and back.
 *
 * The one invariant everything else rests on: a citation's stored token text
 * is carried VERBATIM on its chip element (see {@link CITATION_CHIP_ATTR})
 * and re-emitted from that attribute, never reassembled from parsed fields.
 * Byte identity with `packages/shared`'s `serializeCitationToken` output is
 * therefore structural, not a discipline someone has to remember: this file
 * contains no citation serializer at all.
 *
 * Imports nothing from React, i18n, or any component — it is a plain DOM
 * utility so it can be unit-tested directly under the repo's jsdom
 * environment.
 */

/** Carries a citation's stored token text VERBATIM on its chip element. */
export const CITATION_CHIP_ATTR = 'data-citation-raw';
/** Retained from 260826-kio's convention so tests/queries can select chips. */
export const CITATION_CHIP_VALID_ATTR = 'data-citation-valid';
/** Marks the trailing line-box guard `<br>` (see {@link renderEditorDom}). */
export const CITATION_SENTINEL_ATTR = 'data-citation-sentinel';
/**
 * U+25B6 BLACK RIGHT-POINTING TRIANGLE — the text stand-in for the lucide
 * `Play` icon `CitationChip` uses. Chips here are built imperatively with DOM
 * APIs (React never owns the editing surface), so a chip cannot host an SVG
 * React component; a single glyph character is the closest visual equivalent
 * that survives serialization-free `textContent` assignment.
 */
export const CITATION_CHIP_GLYPH = '▶';

/** The visible text and accessible name for one citation chip. */
export interface CitationChipDescriptor {
  text: string;
  ariaLabel: string;
}

/**
 * Supplied by the caller so all i18n and source-label resolution stay in the
 * component layer — this module never touches translation.
 */
export type DescribeCitationChip = (token: CitationToken) => CitationChipDescriptor;

/**
 * Tags whose presence implies a line break when the browser (autocorrect, an
 * extension, an unexpected UA behavior) creates block structure inside the
 * host. The canonical DOM this module renders never contains any of them.
 */
const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'UL',
  'OL',
  'TR',
]);

/** Mirrors `CitationChip`'s pill visuals — paint only, no layout coupling. */
const CHIP_CLASS_NAME =
  'mx-0.5 inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 align-middle font-mono text-xs text-primary transition-colors hover:bg-primary/10';

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === 3;
}

// Deliberately NOT type predicates: narrowing `HTMLElement` to `HTMLElement`
// makes TypeScript infer `never` for the else-branch of every call site.
function isChipElement(element: Element): boolean {
  return element.hasAttribute(CITATION_CHIP_ATTR);
}

function isSentinelBr(element: Element): boolean {
  return element.tagName === 'BR' && element.hasAttribute(CITATION_SENTINEL_ATTR);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Renders `value` into `host` as the canonical editable DOM: text nodes for
 * prose, one atomic `contenteditable="false"` chip per VALID citation, and —
 * when `value` ends in a newline — a marked trailing sentinel `<br>` so the
 * final empty line box still paints and stays clickable.
 *
 * A located candidate whose shared validation failed renders as PLAIN TEXT,
 * exactly like `safeMarkdown.tsx`'s own fallback and the chip strip's
 * `token != null` filter: a broken token is text the coach should see and
 * fix, never a chip.
 *
 * Every node is built with `createElement`/`createTextNode`/`textContent`/
 * `setAttribute`. `innerHTML`, `insertAdjacentHTML` and `execCommand` are
 * forbidden here — pasted or stored content only ever reaches the DOM as a
 * text node's data or an attribute value.
 */
export function renderEditorDom(
  host: HTMLElement,
  value: string,
  describeChip: DescribeCitationChip,
): void {
  const doc = host.ownerDocument;
  host.replaceChildren();

  for (const segment of splitCitationSegments(value)) {
    if (segment.kind === 'text') {
      host.appendChild(doc.createTextNode(segment.text));
      continue;
    }

    const { span } = segment;
    if (span.token == null) {
      host.appendChild(doc.createTextNode(span.raw));
      continue;
    }

    const descriptor = describeChip(span.token);
    const chip = doc.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute(CITATION_CHIP_ATTR, span.raw);
    chip.setAttribute(CITATION_CHIP_VALID_ATTR, 'true');
    chip.setAttribute('role', 'button');
    // Deliberately out of the tab order: the chip strip below the editor is
    // the keyboard-accessible affordance; the inline chip is a pointer
    // convenience that must not add a tab stop per citation.
    chip.setAttribute('tabindex', '-1');
    chip.setAttribute('aria-label', descriptor.ariaLabel);
    chip.className = CHIP_CLASS_NAME;
    chip.textContent = descriptor.text;
    host.appendChild(chip);
  }

  if (value.endsWith('\n')) {
    const sentinel = doc.createElement('br');
    sentinel.setAttribute(CITATION_SENTINEL_ATTR, 'true');
    host.appendChild(sentinel);
  }
}

interface WalkTarget {
  container: Node;
  offset: number;
}

interface WalkState {
  text: string;
  targetOffset: number | null;
}

/**
 * The ONE traversal. Both {@link serializeEditorDom} and the caret-offset
 * mapping run through it, so the serialized-string coordinate system and the
 * DOM coordinate system can never diverge.
 */
function walkChildren(parent: Node, state: WalkState, target: WalkTarget | null): void {
  const children = parent.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    if (target && target.container === parent && target.offset === index) {
      state.targetOffset = state.text.length;
    }
    visitNode(children[index]!, state, target);
  }
  if (target && target.container === parent && target.offset >= children.length) {
    state.targetOffset = state.text.length;
  }
}

function visitNode(node: Node, state: WalkState, target: WalkTarget | null): void {
  if (isTextNode(node)) {
    // Deliberately NOT normalized: no non-breaking-space folding, no
    // whitespace collapsing. The host is `whitespace-pre-wrap`, a stored
    // body may legitimately contain either character, and normalizing here
    // would silently rewrite the coach's text and break round-trip identity.
    const { data } = node;
    if (target && target.container === node) {
      state.targetOffset = state.text.length + clamp(target.offset, 0, data.length);
    }
    state.text += data;
    return;
  }

  if (!isElement(node)) {
    // Comment nodes and friends contribute nothing.
    return;
  }

  if (isChipElement(node)) {
    const raw = node.getAttribute(CITATION_CHIP_ATTR) ?? '';
    if (target && target.container === node) {
      state.targetOffset = target.offset === 0 ? state.text.length : state.text.length + raw.length;
    }
    state.text += raw;
    // Never descend: the chip's visible text is presentation, the attribute
    // is the truth.
    return;
  }

  if (node.tagName === 'BR') {
    if (target && target.container === node) {
      state.targetOffset = state.text.length;
    }
    if (node.hasAttribute(CITATION_SENTINEL_ATTR)) {
      return;
    }
    state.text += '\n';
    return;
  }

  if (BLOCK_TAGS.has(node.tagName) && state.text.length > 0 && !state.text.endsWith('\n')) {
    state.text += '\n';
  }
  walkChildren(node, state, target);
}

/**
 * The inverse of {@link renderEditorDom}, tolerant of DOM a browser may have
 * created mid-edit. A chip contributes its verbatim stored token; a sentinel
 * `<br>` contributes nothing; any other `<br>` contributes a newline; a
 * block-level element contributes a leading newline (when one is not already
 * present) and then its children.
 */
export function serializeEditorDom(host: HTMLElement): string {
  const state: WalkState = { text: '', targetOffset: null };
  walkChildren(host, state, null);
  return state.text;
}

function containsNode(host: HTMLElement, node: Node | null): boolean {
  return node != null && (host === node || host.contains(node));
}

/**
 * Re-anchors a DOM position that lands inside a chip onto the chip itself, so
 * the traversal resolves it as a whole-atom boundary rather than descending
 * into presentation text that has no string coordinates.
 */
function normalizeTarget(host: HTMLElement, container: Node, offset: number): WalkTarget {
  const element = isElement(container) ? container : container.parentElement;
  const chip = element?.closest?.(`[${CITATION_CHIP_ATTR}]`) ?? null;
  if (chip && containsNode(host, chip)) {
    return { container: chip, offset };
  }
  return { container, offset };
}

function mapNodeOffset(host: HTMLElement, container: Node, offset: number): number | null {
  const state: WalkState = { text: '', targetOffset: null };
  walkChildren(host, state, normalizeTarget(host, container, offset));
  return state.targetOffset;
}

/**
 * The current selection expressed in serialized-string offsets, or `null`
 * when there is no selection or it lives outside `host`. Start/end come back
 * ordered.
 */
export function getEditorSelectionRange(host: HTMLElement): { start: number; end: number } | null {
  try {
    const view = host.ownerDocument.defaultView;
    const selection = view?.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!containsNode(host, range.startContainer) || !containsNode(host, range.endContainer)) {
      return null;
    }
    const start = mapNodeOffset(host, range.startContainer, range.startOffset);
    const end = mapNodeOffset(host, range.endContainer, range.endOffset);
    if (start == null || end == null) {
      return null;
    }
    return start <= end ? { start, end } : { start: end, end: start };
  } catch {
    return null;
  }
}

/**
 * The caret position in serialized-string space — the direct replacement for
 * the `<textarea>.selectionStart` read the composer's Cite handler used
 * before this editor existed, which is why it returns the range's START
 * rather than its end.
 */
export function getEditorCaretOffset(host: HTMLElement): number | null {
  return getEditorSelectionRange(host)?.start ?? null;
}

interface LeafEntry {
  kind: 'text' | 'chip' | 'br' | 'sentinel';
  node: Node;
  start: number;
  length: number;
}

function collectLeaves(host: HTMLElement): { leaves: LeafEntry[]; total: number } {
  const leaves: LeafEntry[] = [];
  const state: WalkState = { text: '', targetOffset: null };

  const visit = (node: Node): void => {
    if (isTextNode(node)) {
      leaves.push({ kind: 'text', node, start: state.text.length, length: node.data.length });
      state.text += node.data;
      return;
    }
    if (!isElement(node)) return;
    if (isChipElement(node)) {
      const raw = node.getAttribute(CITATION_CHIP_ATTR) ?? '';
      leaves.push({ kind: 'chip', node, start: state.text.length, length: raw.length });
      state.text += raw;
      return;
    }
    if (node.tagName === 'BR') {
      if (node.hasAttribute(CITATION_SENTINEL_ATTR)) {
        leaves.push({ kind: 'sentinel', node, start: state.text.length, length: 0 });
        return;
      }
      leaves.push({ kind: 'br', node, start: state.text.length, length: 1 });
      state.text += '\n';
      return;
    }
    if (BLOCK_TAGS.has(node.tagName) && state.text.length > 0 && !state.text.endsWith('\n')) {
      state.text += '\n';
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };

  for (const child of Array.from(host.childNodes)) visit(child);
  return { leaves, total: state.text.length };
}

/**
 * Collapses the selection at `offset` (serialized-string space). Resolution
 * order:
 *
 * 1. the FIRST text node whose accumulated range contains `offset` —
 *    deliberately preferred over an adjacent chip boundary so typing keeps
 *    happening in text;
 * 2. an offset strictly INSIDE a chip's token range resolves immediately
 *    AFTER that chip (a chip is one caret unit, never enterable);
 * 3. an offset exactly at a chip's leading/trailing boundary with no text
 *    node to host it (adjacent chips, a chip-only body) resolves before/after
 *    that chip;
 * 4. an offset at or past the end resolves at the end of the host, and an
 *    empty host resolves at host offset 0.
 *
 * Never throws — a detached node or a selection-less environment is a no-op.
 */
export function setEditorCaretOffset(host: HTMLElement, offset: number): void {
  try {
    const doc = host.ownerDocument;
    const selection = doc.defaultView?.getSelection();
    if (!selection) return;

    const { leaves, total } = collectLeaves(host);
    const target = clamp(offset, 0, total);
    const range = doc.createRange();
    let placed = false;

    for (const leaf of leaves) {
      if (leaf.kind === 'text' && target >= leaf.start && target <= leaf.start + leaf.length) {
        range.setStart(leaf.node, target - leaf.start);
        placed = true;
        break;
      }
    }

    if (!placed) {
      for (const leaf of leaves) {
        if (leaf.kind !== 'chip') continue;
        if (target > leaf.start && target < leaf.start + leaf.length) {
          range.setStartAfter(leaf.node);
          placed = true;
          break;
        }
        if (target === leaf.start) {
          range.setStartBefore(leaf.node);
          placed = true;
          break;
        }
        if (target === leaf.start + leaf.length) {
          range.setStartAfter(leaf.node);
          placed = true;
          break;
        }
      }
    }

    if (!placed) {
      range.selectNodeContents(host);
      range.collapse(false);
    }

    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Detached host, or an environment without a usable Selection — a caret
    // that cannot be placed must never break the edit that placed it.
  }
}

/**
 * The single mutation primitive for Enter, paste and cut: a pure string
 * splice with both bounds clamped and ordered. Chosen over a Range-based DOM
 * insertion because it is exactly testable and cannot produce an intermediate
 * DOM state the serializer would have to understand.
 */
export function spliceEditorValue(
  value: string,
  start: number,
  end: number,
  inserted: string,
): string {
  const from = clamp(Math.min(start, end), 0, value.length);
  const to = clamp(Math.max(start, end), 0, value.length);
  return `${value.slice(0, from)}${inserted}${value.slice(to)}`;
}

/**
 * Maps a caret offset from `oldValue`'s coordinate space into `newValue`'s,
 * using the common prefix/suffix of the two strings.
 *
 * Tie-break (load-bearing): when a caret sits at BOTH the prefix boundary and
 * the start of the common suffix — exactly what a pure insertion made AT the
 * caret looks like — the suffix branch wins, so the caret ends up AFTER the
 * inserted text. That is what makes a citation inserted at the caret leave
 * the caret past the new token instead of in front of it.
 */
export function mapCaretAcrossValueChange(
  oldValue: string,
  newValue: string,
  oldCaret: number,
): number {
  const shorter = Math.min(oldValue.length, newValue.length);

  let prefix = 0;
  while (prefix < shorter && oldValue[prefix] === newValue[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const delta = newValue.length - oldValue.length;
  const oldSuffixStart = oldValue.length - suffix;

  let next: number;
  if (oldCaret >= oldSuffixStart) {
    next = oldCaret + delta;
  } else if (oldCaret <= prefix) {
    next = oldCaret;
  } else {
    next = newValue.length - suffix;
  }

  return clamp(next, 0, newValue.length);
}

/**
 * True when `host`'s DOM must be rebuilt from `serialized`. Three divergences
 * matter:
 *
 * - the host contains an element that is neither a chip nor the sentinel
 *   `<br>` (a browser-created block, line break, or styling element);
 * - the ordered chip tokens do not match the ordered VALID spans located in
 *   `serialized` — this is the case that turns a pasted or typed-out raw
 *   token into a chip;
 * - the sentinel's presence disagrees with whether `serialized` ends in a
 *   newline.
 *
 * MUST be false immediately after {@link renderEditorDom} for the same
 * string: the normalization loop's termination depends on that idempotence.
 */
export function needsDomNormalization(host: HTMLElement, serialized: string): boolean {
  const expected = locateCitationSpans(serialized)
    .filter((span) => span.token != null)
    .map((span) => span.raw);

  const actual: string[] = [];
  let hasStrayElement = false;
  let sentinelCount = 0;

  const visit = (node: Node): void => {
    if (!isElement(node)) return;
    if (isChipElement(node)) {
      actual.push(node.getAttribute(CITATION_CHIP_ATTR) ?? '');
      return;
    }
    if (isSentinelBr(node)) {
      sentinelCount += 1;
      return;
    }
    hasStrayElement = true;
    for (const child of Array.from(node.childNodes)) visit(child);
  };

  for (const child of Array.from(host.childNodes)) visit(child);

  if (hasStrayElement) return true;
  if (actual.length !== expected.length) return true;
  if (actual.some((raw, index) => raw !== expected[index])) return true;
  return serialized.endsWith('\n') ? sentinelCount !== 1 : sentinelCount !== 0;
}
