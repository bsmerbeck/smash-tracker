import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { VodTimestamp } from '@smash-tracker/shared';
import { TimestampRow } from './TimestampRow';

function makeStamp(overrides: Partial<VodTimestamp> = {}): VodTimestamp {
  return {
    id: 'n1',
    seconds: 83,
    note: 'A note',
    ...overrides,
  };
}

function renderRow(stamp: VodTimestamp, overrides: { isEditing?: boolean } = {}) {
  render(
    <TimestampRow
      stamp={stamp}
      isSelected={false}
      isEditing={overrides.isEditing ?? false}
      onSeek={vi.fn()}
      onSelect={vi.fn()}
      onStartEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onCommitEdit={vi.fn()}
      onDelete={vi.fn()}
      onUpdateTags={vi.fn()}
      tagVocabulary={[]}
    />,
  );
}

describe('TimestampRow coach attribution (COACH-05)', () => {
  it('renders a plain-name chip for a note carrying a coach sub-object (FB-04: no "Coach" prefix — the chip styling alone marks it distinct)', () => {
    renderRow(
      makeStamp({
        coach: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Mike' },
      }),
    );

    expect(screen.getByText('Mike')).toBeInTheDocument();
  });

  it('renders no coach chip for an owner-authored note (no coach sub-object)', () => {
    renderRow(makeStamp());

    expect(screen.queryByText('Mike')).not.toBeInTheDocument();
  });

  it('still renders owner edit/delete controls on a coach-authored note (owner moderation, no authorship gating)', () => {
    renderRow(
      makeStamp({
        coach: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Mike' },
      }),
    );

    expect(screen.getByLabelText(/Edit timestamp/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Delete timestamp/)).toBeInTheDocument();
  });
});

describe('TimestampRow edit-mode note field (260725-Q2)', () => {
  it('renders a multi-line textarea seeded with the existing note text when entering edit mode', () => {
    renderRow(makeStamp({ note: 'A longer note that used to feel cramped in a single line' }), {
      isEditing: true,
    });

    const noteField = screen.getByLabelText('Edit timestamp note');
    expect(noteField.tagName).toBe('TEXTAREA');
    expect(noteField).toHaveValue('A longer note that used to feel cramped in a single line');
  });
});
