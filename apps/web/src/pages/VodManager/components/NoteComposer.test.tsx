import { createRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { logProductEvent } from '@/lib/firebase';
import { MAX_TIMESTAMPS } from '@/lib/vod';
import { NoteComposer } from './NoteComposer';

const useResearchSubject = vi.fn();

vi.mock('@/lib/firebase', () => ({
  logProductEvent: vi.fn(),
}));

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
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
    useResearchSubject.mockReset();
    useResearchSubject.mockReturnValue({
      isResearch: false,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });
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
    const timestamps = Array.from({ length: MAX_TIMESTAMPS }, (_, i) => ({
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

  // ---------------------------------------------------------------------
  // Phase 29 (RTEN-04, D-06): research-subject gate — telemetry-only,
  // never a functional change to note creation.
  // ---------------------------------------------------------------------

  it('fires zero product-event calls for a research subject, but the note is still created', async () => {
    useResearchSubject.mockReturnValue({
      isResearch: true,
      isPending: false,
      isError: false,
      retry: vi.fn(),
    });
    const user = userEvent.setup();
    const { onCreateNote } = renderComposer();

    await user.type(screen.getByLabelText('Timestamp time'), '1:23');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(onCreateNote).toHaveBeenCalledExactlyOnceWith({ seconds: 83, note: '' });
    expect(logProductEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', { isResearch: false, isPending: true, isError: false }],
    ['errored', { isResearch: false, isPending: false, isError: true }],
  ])(
    'fires zero product-event calls while the kind lookup is %s (fail-closed), but the note is still created',
    async (_label, status) => {
      useResearchSubject.mockReturnValue({ ...status, retry: vi.fn() });
      const user = userEvent.setup();
      const { onCreateNote } = renderComposer();

      await user.type(screen.getByLabelText('Timestamp time'), '1:23');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      expect(onCreateNote).toHaveBeenCalledExactlyOnceWith({ seconds: 83, note: '' });
      expect(logProductEvent).not.toHaveBeenCalled();
    },
  );
});
