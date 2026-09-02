import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeCitationToken } from '@smash-tracker/shared';
import type { CitationToken } from '@smash-tracker/shared';
import {
  CITATION_CHIP_ATTR,
  CITATION_SENTINEL_ATTR,
  getEditorCaretOffset,
  getEditorSelectionRange,
  mapCaretAcrossValueChange,
  needsDomNormalization,
  renderEditorDom,
  serializeEditorDom,
  setEditorCaretOffset,
  spliceEditorValue,
} from './citationDom';

/** A deliberately terse descriptor — the visible text is irrelevant to identity by design. */
function describeChip(token: CitationToken) {
  return { text: `chip ${token.seconds}`, ariaLabel: `jump ${token.seconds}` };
}

function makeToken(overrides: Partial<CitationToken> = {}): string {
  return serializeCitationToken({
    sourceVodRef: 'm1',
    seconds: 32,
    label: 'edgeguard',
    ...overrides,
  });
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  // Removed explicitly so a leftover Selection anchored into this host can
  // never leak into the next test.
  window.getSelection()?.removeAllRanges();
  host.remove();
});

function chips(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`[${CITATION_CHIP_ATTR}]`));
}

describe('renderEditorDom -> serializeEditorDom identity matrix', () => {
  // Generated programmatically rather than enumerated by hand so no
  // placement/label combination can be quietly forgotten. No property-testing
  // dependency is added — the matrix is a plain nested loop.
  const PROSE_FRAGMENTS: Record<string, string> = {
    empty: '',
    word: 'neutral',
    doubleSpaced: 'two  spaces',
    oneNewline: 'line one\nline two',
    twoNewlines: 'para one\n\npara two',
    onlyNewline: '\n',
  };

  const LABELS: Record<string, string> = {
    empty: '',
    plain: 'edgeguard',
    withSpaces: 'great edgeguard read',
    withEncodedSpace: 'literal %20 in the label',
    nonAscii: 'nöñ-ascii ünïcödé',
  };

  const PLACEMENTS: Record<string, (fragment: string, t1: string, t2: string) => string> = {
    none: (fragment) => fragment,
    atStart: (fragment, t1) => `${t1}${fragment}`,
    atEnd: (fragment, t1) => `${fragment}${t1}`,
    inMiddle: (fragment, t1) => `${fragment}${t1}${fragment}`,
    adjacent: (_fragment, t1, t2) => `${t1}${t2}`,
    newlineSeparated: (_fragment, t1, t2) => `${t1}\n${t2}`,
    followedByNewline: (fragment, t1) => `${t1}\n${fragment}`,
    precededByNewline: (fragment, t1) => `${fragment}\n${t1}`,
  };

  it('round-trips byte-for-byte for every prose/placement/label combination', () => {
    for (const [labelName, label] of Object.entries(LABELS)) {
      const t1 = makeToken({ seconds: 5, label });
      const t2 = makeToken({ sourceVodRef: 'm2', seconds: 3661, label });

      for (const [fragmentName, fragment] of Object.entries(PROSE_FRAGMENTS)) {
        for (const [placementName, build] of Object.entries(PLACEMENTS)) {
          const value = build(fragment, t1, t2);
          renderEditorDom(host, value, describeChip);
          const serialized = serializeEditorDom(host);
          expect(
            serialized,
            `label=${labelName} fragment=${fragmentName} placement=${placementName} value=${JSON.stringify(value)}`,
          ).toBe(value);
        }
      }
    }
  });

  it('round-trips a candidate that FAILS shared validation, leaving it as plain text with no chip', () => {
    const overLongLabel = encodeURIComponent('x'.repeat(210));
    const invalid = `{{cite:matchId=m1;seconds=10;label=${overLongLabel}}}`;
    const value = `broken ${invalid} here`;

    renderEditorDom(host, value, describeChip);

    expect(chips()).toHaveLength(0);
    expect(serializeEditorDom(host)).toBe(value);
  });

  it('produces exactly one chip per VALID span, in document order, each carrying its raw token verbatim', () => {
    const t1 = makeToken({ seconds: 5, label: 'first' });
    const t2 = makeToken({ seconds: 90, label: 'second' });
    const value = `before ${t1} middle ${t2} after`;

    renderEditorDom(host, value, describeChip);

    expect(chips().map((chip) => chip.getAttribute(CITATION_CHIP_ATTR))).toEqual([t1, t2]);
  });

  it('VERBATIM PROOF: a chip whose visible text was mangled still serializes its stored token exactly', () => {
    const t1 = makeToken({ seconds: 5, label: 'first' });
    renderEditorDom(host, `a ${t1} b`, describeChip);

    chips()[0]!.textContent = 'totally different visible text';

    expect(serializeEditorDom(host)).toBe(`a ${t1} b`);
  });
});

describe('serializeEditorDom sentinel and browser-DOM tolerance', () => {
  it('renders a marked sentinel <br> for a value ending in a newline and emits nothing for it', () => {
    renderEditorDom(host, 'trailing\n', describeChip);

    const last = host.lastChild as HTMLElement;
    expect(last.tagName).toBe('BR');
    expect(last.hasAttribute(CITATION_SENTINEL_ATTR)).toBe(true);
    expect(serializeEditorDom(host)).toBe('trailing\n');
  });

  it('emits a newline for a <br> that is NOT the sentinel', () => {
    host.replaceChildren(document.createTextNode('a'), document.createElement('br'));
    expect(serializeEditorDom(host)).toBe('a\n');
  });

  it('serializes a hand-built browser-shaped host per the documented block/br rules', () => {
    const block = document.createElement('div');
    block.textContent = 'abc';
    const inline = document.createElement('span');
    inline.textContent = 'xyz';
    host.replaceChildren(block, document.createElement('br'), inline);

    // A leading block with an empty accumulator contributes no newline; the
    // plain <br> contributes one; a nested inline element contributes only
    // its own text.
    expect(serializeEditorDom(host)).toBe('abc\nxyz');
  });

  it('contributes a leading newline for a block that follows existing text', () => {
    const block = document.createElement('div');
    block.textContent = 'def';
    host.replaceChildren(document.createTextNode('abc'), block);

    expect(serializeEditorDom(host)).toBe('abc\ndef');
  });

  it('is idempotent: re-rendering a browser-shaped serialization then serializing again is stable', () => {
    const block = document.createElement('div');
    block.textContent = 'abc';
    const inline = document.createElement('span');
    inline.textContent = 'xyz';
    host.replaceChildren(block, document.createElement('br'), inline);

    const first = serializeEditorDom(host);
    renderEditorDom(host, first, describeChip);

    expect(serializeEditorDom(host)).toBe(first);
  });
});

describe('caret mapping', () => {
  it('round-trips every offset that does not fall strictly inside a chip', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `before ${t1} after`;
    renderEditorDom(host, value, describeChip);

    const chipStart = value.indexOf(t1);
    const chipEnd = chipStart + t1.length;

    for (let offset = 0; offset <= value.length; offset += 1) {
      if (offset > chipStart && offset < chipEnd) continue;
      setEditorCaretOffset(host, offset);
      expect(getEditorCaretOffset(host), `offset=${offset}`).toBe(offset);
    }
  });

  it('round-trips a boundary between two ADJACENT chips (no text node to host the caret)', () => {
    const t1 = makeToken({ seconds: 5, label: 'first' });
    const t2 = makeToken({ seconds: 90, label: 'second' });
    renderEditorDom(host, `${t1}${t2}`, describeChip);

    setEditorCaretOffset(host, t1.length);
    expect(getEditorCaretOffset(host)).toBe(t1.length);
  });

  it('clamps an offset strictly inside a chip to the position immediately AFTER that chip', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `before ${t1} after`;
    renderEditorDom(host, value, describeChip);

    const chipStart = value.indexOf(t1);
    setEditorCaretOffset(host, chipStart + 4);

    expect(getEditorCaretOffset(host)).toBe(chipStart + t1.length);
  });

  it('clamps an offset past the end to the end of the host', () => {
    renderEditorDom(host, 'abc', describeChip);
    setEditorCaretOffset(host, 999);
    expect(getEditorCaretOffset(host)).toBe(3);
  });

  it('resolves to 0 in an empty host', () => {
    renderEditorDom(host, '', describeChip);
    setEditorCaretOffset(host, 5);
    expect(getEditorCaretOffset(host)).toBe(0);
  });

  it('getEditorSelectionRange returns null when the selection is outside the host', () => {
    renderEditorDom(host, 'abc', describeChip);
    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);

    const range = document.createRange();
    range.setStart(outside.firstChild!, 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(getEditorSelectionRange(host)).toBeNull();

    outside.remove();
  });

  it('getEditorSelectionRange returns ordered start/end offsets when the selection is inside the host', () => {
    renderEditorDom(host, 'abcdef', describeChip);

    const range = document.createRange();
    range.setStart(host.firstChild!, 2);
    range.setEnd(host.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(getEditorSelectionRange(host)).toEqual({ start: 2, end: 5 });
  });
});

describe('spliceEditorValue', () => {
  it('inserts at the start, at the end, and in the middle', () => {
    expect(spliceEditorValue('bcd', 0, 0, 'a')).toBe('abcd');
    expect(spliceEditorValue('abc', 3, 3, 'd')).toBe('abcd');
    expect(spliceEditorValue('ad', 1, 1, 'bc')).toBe('abcd');
  });

  it('replaces a range that spans a whole chip token', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `before ${t1} after`;
    const start = value.indexOf(t1);

    expect(spliceEditorValue(value, start, start + t1.length, 'X')).toBe('before X after');
  });

  it('deletes when the inserted text is empty, and clamps/orders its bounds', () => {
    expect(spliceEditorValue('abcdef', 1, 4, '')).toBe('aef');
    expect(spliceEditorValue('abcdef', 4, 1, '')).toBe('aef');
    expect(spliceEditorValue('abc', -5, 99, '')).toBe('');
  });
});

describe('mapCaretAcrossValueChange', () => {
  it('advances the caret past a pure insertion made AT the caret', () => {
    expect(mapCaretAcrossValueChange('ab', 'aXb', 1)).toBe(2);
  });

  it('advances the caret past a citation token inserted at the caret', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const oldValue = 'before after';
    const newValue = `before ${t1} after`;

    expect(mapCaretAcrossValueChange(oldValue, newValue, 7)).toBe(7 + t1.length + 1);
  });

  it('leaves a caret before the change point untouched', () => {
    expect(mapCaretAcrossValueChange('hello world', 'hello brave world', 2)).toBe(2);
  });

  it('clamps to the start of the common suffix for a deletion that swallowed the caret', () => {
    expect(mapCaretAcrossValueChange('abcdef', 'af', 3)).toBe(1);
  });

  it('never returns an offset outside the new value', () => {
    expect(mapCaretAcrossValueChange('abcdef', '', 4)).toBe(0);
    expect(mapCaretAcrossValueChange('', 'abc', 0)).toBe(3);
  });
});

describe('needsDomNormalization', () => {
  it('is false for a freshly rendered canonical host (idempotence — the normalization loop terminates)', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    for (const value of ['', 'plain prose', `a ${t1} b`, 'trailing\n', `${t1}\n`]) {
      renderEditorDom(host, value, describeChip);
      expect(needsDomNormalization(host, value), `value=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('is true when a valid raw token is sitting in a text node (the paste/type-out case)', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `a ${t1} b`;
    host.replaceChildren(document.createTextNode(value));

    expect(needsDomNormalization(host, value)).toBe(true);
  });

  it('is true when a stray non-chip element exists in the host', () => {
    renderEditorDom(host, 'abc', describeChip);
    host.appendChild(document.createElement('span'));

    expect(needsDomNormalization(host, 'abc')).toBe(true);
  });

  it('is true when the sentinel presence disagrees with the value', () => {
    renderEditorDom(host, 'abc', describeChip);
    expect(needsDomNormalization(host, 'abc\n')).toBe(true);

    renderEditorDom(host, 'abc\n', describeChip);
    expect(needsDomNormalization(host, 'abc')).toBe(true);
  });

  it('is true when the chip order diverges from the located spans', () => {
    const t1 = makeToken({ seconds: 5, label: 'first' });
    const t2 = makeToken({ seconds: 90, label: 'second' });
    renderEditorDom(host, `${t1} ${t2}`, describeChip);

    expect(needsDomNormalization(host, `${t2} ${t1}`)).toBe(true);
  });

  it('is false again after re-rendering from the diverged string', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `a ${t1} b`;
    host.replaceChildren(document.createTextNode(value));
    expect(needsDomNormalization(host, value)).toBe(true);

    renderEditorDom(host, value, describeChip);

    expect(needsDomNormalization(host, value)).toBe(false);
  });
});
