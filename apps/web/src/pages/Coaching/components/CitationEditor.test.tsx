import { describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { CitationToken } from '@smash-tracker/shared';
import { serializeCitationToken } from '@smash-tracker/shared';
import { CITATION_CHIP_ATTR, setEditorCaretOffset } from '@/lib/citationDom';
import { CitationEditor } from './CitationEditor';

/**
 * jsdom does NOT implement contentEditable EDITING (research finding F7), so
 * no assertion here may rely on the browser mutating the DOM. Every case
 * mutates the host the way a browser would and then fires the corresponding
 * event — which is also a stricter test of the component's own rules than
 * `user-event` typing would be. `document.execCommand` is never used (jsdom
 * has no implementation), and no assertion depends on `user-event` typing
 * into the contentEditable host.
 */

function makeToken(overrides: Partial<CitationToken> = {}): string {
  return serializeCitationToken({
    sourceVodRef: 'm1',
    seconds: 32,
    label: 'edgeguard',
    ...overrides,
  });
}

function renderEditor(
  value: string,
  extra: {
    onChange?: (next: string) => void;
    onActivateCitation?: (matchId: string, seconds: number) => void;
    resolveCitationSource?: (matchId: string) => { label: string } | undefined;
  } = {},
) {
  const onChange = extra.onChange ?? vi.fn();
  const utils = render(
    <CitationEditor
      value={value}
      onChange={onChange}
      ariaLabel="Summary"
      testId="section-summary"
      onActivateCitation={extra.onActivateCitation}
      resolveCitationSource={extra.resolveCitationSource}
    />,
  );
  const host = screen.getByTestId('section-summary');
  return { ...utils, host, onChange };
}

function chipsIn(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`[${CITATION_CHIP_ATTR}]`));
}

/** An empty inline element — invisible to serialization, but a STRAY element, so a rebuild removes it. */
function insertMarker(host: HTMLElement): HTMLElement {
  const marker = document.createElement('i');
  marker.setAttribute('data-testid', 'rebuild-marker');
  host.appendChild(marker);
  return marker;
}

describe('CitationEditor rendering', () => {
  it('renders each citation as a chip showing the play glyph, mm:ss and the decoded label', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const t2 = makeToken({ seconds: 90, label: 'neutral win' });
    const { host } = renderEditor(`first ${t1} second ${t2} end`);

    const chips = chipsIn(host);
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toBe('▶ 0:32 — edgeguard');
    expect(chips[1]!.textContent).toBe('▶ 1:30 — neutral win');
  });

  it('THE owner acceptance: the edit surface shows no raw token text for a body whose citations are all valid', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host } = renderEditor(`first ${t1} end`);

    expect(host.textContent).not.toContain('{{cite:');
    expect(host.textContent).not.toContain('matchId=');
  });

  it('a citation with an empty label renders the timestamp only', () => {
    const { host } = renderEditor(`moment ${makeToken({ seconds: 45, label: '' })} here`);

    expect(chipsIn(host)[0]!.textContent).toBe('▶ 0:45');
  });

  it('exposes a single accessible multiline textbox host', () => {
    const { host } = renderEditor('body text');

    expect(host).toBe(screen.getByRole('textbox', { name: 'Summary' }));
    expect(host).toHaveAttribute('aria-multiline', 'true');
    expect(host).toHaveAttribute('contenteditable', 'true');
    expect(host).toHaveTextContent('body text');
  });

  it('a candidate that fails shared validation renders as plain text with no chip', () => {
    const invalid = `{{cite:matchId=m1;seconds=10;label=${encodeURIComponent('x'.repeat(210))}}}`;
    const { host } = renderEditor(`broken ${invalid} here`);

    expect(chipsIn(host)).toHaveLength(0);
    expect(host.textContent).toContain(invalid);
  });

  it('uses the source-qualified accessible name when the citation points at a different VOD', () => {
    const t1 = makeToken({ sourceVodRef: 'm2', seconds: 32, label: 'edgeguard' });
    const { host } = renderEditor(`a ${t1} b`, {
      resolveCitationSource: (matchId) => (matchId === 'm2' ? { label: 'vs Zain' } : undefined),
    });

    expect(chipsIn(host)[0]!.getAttribute('aria-label')).toBe('Jump to 0:32 in vs Zain: edgeguard');
  });
});

describe('CitationEditor editing rules', () => {
  it('TYPING: appending to the trailing text node emits the full serialized string with tokens intact', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, onChange } = renderEditor(`hi ${t1} there`);

    (host.lastChild as Text).data += '!';
    fireEvent.input(host);

    expect(onChange).toHaveBeenCalledWith(`hi ${t1} there!`);
  });

  it('ATOMIC DELETE: removing a chip element drops that citation token IN FULL, never a fragment', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, onChange } = renderEditor(`before ${t1} after`);

    chipsIn(host)[0]!.remove();
    fireEvent.input(host);

    // Exact equality — a half-token would fail this.
    expect(onChange).toHaveBeenCalledWith('before  after');
  });

  it('ENTER: is prevented, splices a newline at the caret, and leaves no block element behind', () => {
    const { host, onChange } = renderEditor('abcdef');
    setEditorCaretOffset(host, 3);

    const enter = createEvent.keyDown(host, { key: 'Enter' });
    fireEvent(host, enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith('abc\ndef');
    expect(host.querySelector('div, p, br:not([data-citation-sentinel])')).toBeNull();
  });

  it('PASTE of text containing a valid token splices it AND leaves a chip — never a raw token in the surface', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, onChange } = renderEditor('before after');
    setEditorCaretOffset(host, 7);

    const paste = createEvent.paste(host, {
      clipboardData: { getData: () => t1 },
    });
    fireEvent(host, paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith(`before ${t1}after`);
    expect(chipsIn(host)).toHaveLength(1);
    expect(host.textContent).not.toContain('{{cite:');
  });

  it('PASTE of ordinary prose splices the plain text and produces no chip', () => {
    const { host, onChange } = renderEditor('before after');
    setEditorCaretOffset(host, 7);

    fireEvent(host, createEvent.paste(host, { clipboardData: { getData: () => 'brave ' } }));

    expect(onChange).toHaveBeenCalledWith('before brave after');
    expect(chipsIn(host)).toHaveLength(0);
  });

  it('COPY writes the SERIALIZED selection (a chip yields its stored token) to the clipboard', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const value = `before ${t1} after`;
    const { host } = renderEditor(value);

    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEndAfter(chipsIn(host)[0]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const setData = vi.fn();
    const copy = createEvent.copy(host, { clipboardData: { setData } });
    fireEvent(host, copy);

    expect(copy.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', `before ${t1}`);
  });

  it('CUT writes the serialized selection and removes it from the value', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, onChange } = renderEditor(`before ${t1} after`);

    const range = document.createRange();
    range.setStart(host.firstChild!, 0);
    range.setEndAfter(chipsIn(host)[0]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const setData = vi.fn();
    fireEvent(host, createEvent.cut(host, { clipboardData: { setData } }));

    expect(setData).toHaveBeenCalledWith('text/plain', `before ${t1}`);
    expect(onChange).toHaveBeenCalledWith(' after');
    expect(chipsIn(host)).toHaveLength(0);
  });

  it('DROP is rejected outright', () => {
    const { host } = renderEditor('abc');

    const drop = createEvent.drop(host);
    fireEvent(host, drop);

    expect(drop.defaultPrevented).toBe(true);
  });

  it('COMPOSITION: no DOM rebuild happens between compositionstart and compositionend', () => {
    const { host, onChange } = renderEditor('abc');

    fireEvent.compositionStart(host);
    (host.firstChild as Text).data += 'X';
    const marker = insertMarker(host);
    fireEvent.input(host);

    // The value still flows out while composing — only the REBUILD waits.
    expect(onChange).toHaveBeenCalledWith('abcX');
    expect(host.contains(marker)).toBe(true);

    fireEvent.compositionEnd(host);

    // compositionend runs the normal path, which normalizes the stray node away.
    expect(host.contains(marker)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a raw token typed into a text node is converted to a chip by the input handler', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, onChange } = renderEditor('before ');

    (host.firstChild as Text).data += t1;
    fireEvent.input(host);

    expect(onChange).toHaveBeenCalledWith(`before ${t1}`);
    expect(chipsIn(host)).toHaveLength(1);
    expect(host.textContent).not.toContain('{{cite:');
  });
});

describe('CitationEditor value synchronization', () => {
  it('NO-OP GUARD: re-rendering with the current serialization does not rebuild the DOM', () => {
    const { host, rerender } = renderEditor('abc');
    const marker = insertMarker(host);

    rerender(
      <CitationEditor
        value="abc"
        onChange={vi.fn()}
        ariaLabel="Summary"
        testId="section-summary"
      />,
    );

    expect(host.contains(marker)).toBe(true);
  });

  it('EXTERNAL VALUE CHANGE: a token inserted upstream rebuilds the DOM into a chip', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host, rerender } = renderEditor('before after');
    expect(chipsIn(host)).toHaveLength(0);

    rerender(
      <CitationEditor
        value={`before ${t1} after`}
        onChange={vi.fn()}
        ariaLabel="Summary"
        testId="section-summary"
      />,
    );

    expect(chipsIn(host)).toHaveLength(1);
    expect(host.textContent).not.toContain('{{cite:');
  });

  it('does not touch the selection when the editor is unfocused', () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { rerender } = renderEditor('before after');

    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    rerender(
      <CitationEditor
        value={`before ${t1} after`}
        onChange={vi.fn()}
        ariaLabel="Summary"
        testId="section-summary"
      />,
    );

    expect(selection.anchorNode).toBe(outside.firstChild);
    outside.remove();
  });
});

describe('CitationEditor chip activation', () => {
  it('clicking a chip calls onActivateCitation with the token sourceVodRef and seconds', () => {
    const onActivateCitation = vi.fn();
    const t1 = makeToken({ sourceVodRef: 'm7', seconds: 32, label: 'edgeguard' });
    const { host } = renderEditor(`a ${t1} b`, { onActivateCitation });

    fireEvent.click(chipsIn(host)[0]!);

    expect(onActivateCitation).toHaveBeenCalledWith('m7', 32);
  });

  it("a chip's mousedown is default-prevented so focus stays on the editor (F8)", () => {
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host } = renderEditor(`a ${t1} b`);

    const mouseDown = createEvent.mouseDown(chipsIn(host)[0]!, { bubbles: true });
    fireEvent(chipsIn(host)[0]!, mouseDown);

    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it('never activates from an unvalidatable raw-token attribute', () => {
    const onActivateCitation = vi.fn();
    const t1 = makeToken({ seconds: 32, label: 'edgeguard' });
    const { host } = renderEditor(`a ${t1} b`, { onActivateCitation });

    chipsIn(host)[0]!.setAttribute(CITATION_CHIP_ATTR, 'not a token at all');
    fireEvent.click(host.querySelector(`[${CITATION_CHIP_ATTR}]`)!);

    expect(onActivateCitation).not.toHaveBeenCalled();
  });
});
