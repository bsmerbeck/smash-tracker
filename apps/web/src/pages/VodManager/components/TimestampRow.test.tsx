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

function renderRow(stamp: VodTimestamp) {
  render(
    <TimestampRow
      stamp={stamp}
      isSelected={false}
      isEditing={false}
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
  it('renders a "Coach {name}" chip for a note carrying a coach sub-object', () => {
    renderRow(
      makeStamp({
        coach: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Mike' },
      }),
    );

    expect(screen.getByText('Coach Mike')).toBeInTheDocument();
  });

  it('renders no coach chip for an owner-authored note (no coach sub-object)', () => {
    renderRow(makeStamp());

    expect(screen.queryByText(/^Coach /)).not.toBeInTheDocument();
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
