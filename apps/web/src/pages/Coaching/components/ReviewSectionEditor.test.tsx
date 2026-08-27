import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewSection } from '@smash-tracker/shared';
import { serializeCitationToken } from '@smash-tracker/shared';
import { ReviewSectionEditor } from './ReviewSectionEditor';

function makeSection(overrides: Partial<ReviewSection> = {}): ReviewSection {
  return { id: 'summary', kind: 'summary', hidden: false, title: null, body: '', ...overrides };
}

const DEFAULT_SECTIONS: ReviewSection[] = [
  makeSection({ id: 'summary', kind: 'summary', body: 'summary text' }),
  makeSection({ id: 'strengths', kind: 'strengths', body: 'strengths text' }),
  makeSection({ id: 'priorities', kind: 'priorities', body: 'priorities text' }),
  makeSection({ id: 'practicePlan', kind: 'practicePlan', body: 'plan text' }),
];

function renderEditor(
  sections: ReviewSection[] = DEFAULT_SECTIONS,
  extraProps: {
    onActivateCitation?: (matchId: string, seconds: number) => void;
    resolveCitationSource?: (matchId: string) => { label: string } | undefined;
  } = {},
) {
  const onChangeBody = vi.fn();
  const onHide = vi.fn();
  const onShow = vi.fn();
  const onAdd = vi.fn();
  const utils = render(
    <ReviewSectionEditor
      sections={sections}
      onChangeBody={onChangeBody}
      onHide={onHide}
      onShow={onShow}
      onAdd={onAdd}
      onActivateCitation={extraProps.onActivateCitation}
      resolveCitationSource={extraProps.resolveCitationSource}
    />,
  );
  return { ...utils, onChangeBody, onHide, onShow, onAdd };
}

describe('ReviewSectionEditor', () => {
  it('renders the four suggested blocks as accessible textboxes, preserving body text', () => {
    renderEditor();

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveTextContent('summary text');
    expect(screen.getByRole('textbox', { name: 'Strengths' })).toHaveTextContent('strengths text');
    expect(screen.getByRole('textbox', { name: 'Priorities' })).toHaveTextContent(
      'priorities text',
    );
    expect(screen.getByRole('textbox', { name: 'Practice Plan' })).toHaveTextContent('plan text');
  });

  it('never renders an × for hiding — only an overflow "Hide section" action', () => {
    renderEditor();

    expect(screen.queryByText('×')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Section options: Summary' })).toBeInTheDocument();
  });

  it('excludes hidden sections from the visible list', () => {
    renderEditor([
      makeSection({ id: 'summary', kind: 'summary', hidden: true, body: 'hidden but kept' }),
      makeSection({ id: 'strengths', kind: 'strengths', body: 'visible text' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Strengths' })).toBeInTheDocument();
  });

  it('editing a section editor calls onChangeBody with the sectionId and new value', () => {
    const { onChangeBody } = renderEditor();

    // jsdom does not implement contentEditable EDITING (260826-s46 F7), so
    // the edit is driven the way a browser would drive it — mutate the DOM,
    // then fire the `input` the browser would have fired.
    const editor = screen.getByRole('textbox', { name: 'Strengths' });
    (editor.firstChild as Text).data += '!';
    fireEvent.input(editor);

    expect(onChangeBody).toHaveBeenCalledWith('strengths', 'strengths text!');
  });

  it('hiding a section fires onHide and shows a real, labeled, focusable Undo button (content-preserving)', async () => {
    const user = userEvent.setup();
    const { onHide } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Section options: Summary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide section' }));

    expect(onHide).toHaveBeenCalledWith('summary');
    const undoButton = await screen.findByRole('button', { name: 'Undo hide section Summary' });
    expect(undoButton.tagName).toBe('BUTTON');
    await waitFor(() => expect(undoButton).toHaveFocus());
    expect(screen.getByText('Section "Summary" hidden — content kept')).toBeInTheDocument();
  });

  it('clicking Undo fires onShow with the hidden section id', async () => {
    const user = userEvent.setup();
    const { onShow } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Section options: Summary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide section' }));
    const undoButton = await screen.findByRole('button', { name: 'Undo hide section Summary' });

    await user.click(undoButton);

    expect(onShow).toHaveBeenCalledWith('summary');
    expect(screen.queryByText('Section "Summary" hidden — content kept')).not.toBeInTheDocument();
  });

  it('Add section offers hidden suggested blocks, optional SSBU sections, and always offers General Notes', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderEditor([
      makeSection({ id: 'summary', kind: 'summary', hidden: true }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    await user.click(
      screen.getByRole('button', { name: 'Add section — restore hidden or add General Notes' }),
    );

    expect(await screen.findByRole('menuitem', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Matchup Notes' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'General Notes' })).toBeInTheDocument();
    // A currently-visible suggested block is not offered again as an add.
    expect(screen.queryByRole('menuitem', { name: 'Strengths' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Summary' }));
    expect(onAdd).toHaveBeenCalledWith('summary');
  });

  it('does not render the Add section control once all suggested and optional kinds are present', () => {
    renderEditor([
      ...DEFAULT_SECTIONS,
      makeSection({ id: 'matchupNotes', kind: 'matchupNotes' }),
      makeSection({ id: 'stageNotes', kind: 'stageNotes' }),
      makeSection({ id: 'drills', kind: 'drills' }),
      makeSection({ id: 'nextGoals', kind: 'nextGoals' }),
    ]);

    expect(
      screen.queryByRole('button', { name: 'Add section — restore hidden or add General Notes' }),
    ).not.toBeInTheDocument();
  });
});

/** The strip is a labelled list — scoped because the SAME citations now also render as inline chips inside the editable text (260826-s46). */
function summaryStrip(): HTMLElement {
  return screen.getByRole('list', { name: 'Citations in Summary' });
}

describe('ReviewSectionEditor citation chip strip (260826-kio)', () => {
  it('renders one chip per citation, showing timestamp + label', () => {
    const t1 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'edgeguard' });
    const t2 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 90, label: 'neutral win' });
    renderEditor([
      makeSection({ id: 'summary', kind: 'summary', body: `first ${t1} second ${t2} end` }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    expect(
      within(summaryStrip()).getByRole('button', { name: /0:32.*edgeguard/i }),
    ).toBeInTheDocument();
    expect(
      within(summaryStrip()).getByRole('button', { name: /1:30.*neutral win/i }),
    ).toBeInTheDocument();
  });

  it('a citation with an empty label renders a chip showing the timestamp only', () => {
    const t1 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 45, label: '' });
    renderEditor([
      makeSection({ id: 'summary', kind: 'summary', body: `moment ${t1} here` }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    expect(
      within(summaryStrip()).getByRole('button', { name: 'Jump to 0:45' }),
    ).toBeInTheDocument();
  });

  it('a candidate that failed shared validation gets no chip', () => {
    const overLongLabel = encodeURIComponent('x'.repeat(210));
    const invalidToken = `{{cite:matchId=m1;seconds=10;label=${overLongLabel}}}`;
    renderEditor([
      makeSection({ id: 'summary', kind: 'summary', body: `broken ${invalidToken} here` }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    expect(screen.queryByRole('button', { name: /Jump to/i })).not.toBeInTheDocument();
  });

  it('clicking a chip calls onActivateCitation with the token sourceVodRef and seconds', async () => {
    const user = userEvent.setup();
    const onActivateCitation = vi.fn();
    const t1 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'edgeguard' });
    renderEditor(
      [
        makeSection({ id: 'summary', kind: 'summary', body: `moment ${t1} here` }),
        makeSection({ id: 'strengths', kind: 'strengths' }),
        makeSection({ id: 'priorities', kind: 'priorities' }),
        makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
      ],
      { onActivateCitation },
    );

    await user.click(within(summaryStrip()).getByRole('button', { name: /edgeguard/i }));

    expect(onActivateCitation).toHaveBeenCalledWith('m1', 32);
  });

  it("clicking a chip's × calls onChangeBody once with the body minus that exact token, seam-collapsed", async () => {
    const user = userEvent.setup();
    const t1 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'edgeguard' });
    const { onChangeBody } = renderEditor([
      makeSection({ id: 'summary', kind: 'summary', body: `before ${t1} after` }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    await user.click(screen.getByRole('button', { name: 'Remove citation at 0:32' }));

    expect(onChangeBody).toHaveBeenCalledTimes(1);
    expect(onChangeBody).toHaveBeenCalledWith('summary', 'before after');
  });

  it('a section with no citations renders no strip at all', () => {
    renderEditor();

    expect(screen.queryByRole('button', { name: /Remove citation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jump to/i })).not.toBeInTheDocument();
  });
});

describe('ReviewSectionEditor inline citation chips (260826-s46)', () => {
  it('shows the citation as a chip inside the editable text, never as raw token text', () => {
    const t1 = serializeCitationToken({ sourceVodRef: 'm1', seconds: 32, label: 'edgeguard' });
    renderEditor([
      makeSection({ id: 'summary', kind: 'summary', body: `first ${t1} end` }),
      makeSection({ id: 'strengths', kind: 'strengths' }),
      makeSection({ id: 'priorities', kind: 'priorities' }),
      makeSection({ id: 'practicePlan', kind: 'practicePlan' }),
    ]);

    const editor = screen.getByRole('textbox', { name: 'Summary' });
    expect(editor.textContent).not.toContain('{{cite:');
    expect(
      within(editor).getByRole('button', { name: 'Jump to 0:32: edgeguard' }),
    ).toHaveTextContent('▶ 0:32 — edgeguard');
  });
});
