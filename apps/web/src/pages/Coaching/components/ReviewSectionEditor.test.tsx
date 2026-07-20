import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewSection } from '@smash-tracker/shared';
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

function renderEditor(sections: ReviewSection[] = DEFAULT_SECTIONS) {
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
    />,
  );
  return { ...utils, onChangeBody, onHide, onShow, onAdd };
}

describe('ReviewSectionEditor', () => {
  it('renders the four suggested blocks as textareas, preserving body text', () => {
    renderEditor();

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByLabelText('Summary')).toHaveValue('summary text');
    expect(screen.getByLabelText('Strengths')).toHaveValue('strengths text');
    expect(screen.getByLabelText('Priorities')).toHaveValue('priorities text');
    expect(screen.getByLabelText('Practice Plan')).toHaveValue('plan text');
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

  it('editing a textarea calls onChangeBody with the sectionId and new value', async () => {
    const user = userEvent.setup();
    const { onChangeBody } = renderEditor();

    await user.type(screen.getByLabelText('Strengths'), '!');

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
