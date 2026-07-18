import { createRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { logProductEvent } from '@/lib/firebase';
import { NoteComposer } from './NoteComposer';

vi.mock('@/lib/firebase', () => ({
  logProductEvent: vi.fn(),
}));

function renderComposer(onCreateNote = vi.fn()) {
  const getCurrentTimeRef = createRef<(() => number) | null>();
  render(
    <NoteComposer
      timestamps={[]}
      getCurrentTimeRef={getCurrentTimeRef}
      onCreateNote={onCreateNote}
    />,
  );
  return { onCreateNote };
}

describe('NoteComposer', () => {
  beforeEach(() => {
    vi.mocked(logProductEvent).mockClear();
  });

  it('fires vod_note_created exactly once on a valid add (FUNNEL-01 note-creation site)', async () => {
    const user = userEvent.setup();
    const { onCreateNote } = renderComposer();

    await user.type(screen.getByLabelText('Timestamp time'), '1:23');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    // A single note's input — the composer never builds/sorts a next array
    // (the dedicated create endpoint + read normalizer own that now).
    expect(onCreateNote).toHaveBeenCalledExactlyOnceWith({ seconds: 83, note: '' });
    expect(logProductEvent).toHaveBeenCalledExactlyOnceWith('vod_note_created');
  });

  it('does not fire vod_note_created when the time input is invalid', async () => {
    const user = userEvent.setup();
    const { onCreateNote } = renderComposer();

    await user.type(screen.getByLabelText('Timestamp time'), 'not-a-time');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(onCreateNote).not.toHaveBeenCalled();
    expect(logProductEvent).not.toHaveBeenCalled();
  });

  it('does not fire vod_note_created when the timestamp cap blocks the add', async () => {
    const user = userEvent.setup();
    const timestamps = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      seconds: i,
      note: `note ${i}`,
    }));
    const onCreateNote = vi.fn();
    const getCurrentTimeRef = createRef<(() => number) | null>();
    render(
      <NoteComposer
        timestamps={timestamps}
        getCurrentTimeRef={getCurrentTimeRef}
        onCreateNote={onCreateNote}
      />,
    );

    await user.type(screen.getByLabelText('Timestamp time'), '1:23');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(onCreateNote).not.toHaveBeenCalled();
    expect(logProductEvent).not.toHaveBeenCalled();
  });
});
