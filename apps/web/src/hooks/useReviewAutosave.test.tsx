import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReviewDraft, ReviewSection } from '@smash-tracker/shared';
import { useReviewAutosave } from './useReviewAutosave';

const patchDraft = vi.fn();

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    readonly statusCode?: number;
    readonly details?: unknown;
    constructor(status: number, message: string, details?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.statusCode = status;
      this.details = details;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    coaching: {
      reviews: {
        patchDraft: (...args: unknown[]) => patchDraft(...args),
      },
    },
  },
  ApiError: MockApiError,
}));

function makeSection(body: string): ReviewSection {
  return { id: 'summary', kind: 'summary', hidden: false, title: null, body };
}

function makeDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    revision: 1,
    sections: [makeSection('server text')],
    coachPrivateNotes: null,
    lastAutosavedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function Probe({ initialBody, revision }: { initialBody: string; revision: number }) {
  const [body, setBody] = useState(initialBody);
  const autosave = useReviewAutosave(
    'tetra',
    'review-1',
    { sections: [makeSection(body)], coachPrivateNotes: null },
    revision,
  );
  return (
    <div>
      <div data-testid="status">{autosave.status}</div>
      <div data-testid="conflict">{autosave.conflictServerDraft ? 'yes' : 'no'}</div>
      <button onClick={() => setBody('edited text')}>edit</button>
      <button onClick={() => autosave.resolveKeepMine()}>keep-mine</button>
      <button onClick={() => autosave.resolveWithServerDraft()}>see-theirs</button>
    </div>
  );
}

function renderProbe(initialBody = 'initial text', revision = 0) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe initialBody={initialBody} revision={revision} />
    </QueryClientProvider>,
  );
}

describe('useReviewAutosave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not PATCH on mount (the just-fetched draft is already in sync)', async () => {
    renderProbe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(patchDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
  });

  it('debounces an edit, then PATCHes with the expected revision and advances it on success', async () => {
    patchDraft.mockResolvedValue(makeDraft({ revision: 1 }));
    renderProbe('initial text', 0);

    fireEvent.click(screen.getByText('edit'));

    // Not yet fired before the debounce window elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(patchDraft).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(patchDraft).toHaveBeenCalledWith('tetra', 'review-1', {
      expectedRevision: 0,
      sections: [makeSection('edited text')],
      coachPrivateNotes: null,
    });
    expect(screen.getByTestId('status')).toHaveTextContent('saved');
  });

  it('on a 409, stops the debounce loop and surfaces the conflict — never silently reapplies local changes', async () => {
    const serverDraft = makeDraft({
      revision: 5,
      sections: [makeSection('someone else typed this')],
    });
    patchDraft.mockRejectedValueOnce(new MockApiError(409, 'Stale revision', { serverDraft }));
    renderProbe('initial text', 0);

    fireEvent.click(screen.getByText('edit'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('conflict');
    expect(screen.getByTestId('conflict')).toHaveTextContent('yes');

    patchDraft.mockClear();
    // A further debounce tick (e.g. the caller re-rendering) must NOT fire
    // another PATCH while the conflict is unresolved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(patchDraft).not.toHaveBeenCalled();
  });

  it("resolveKeepMine re-PATCHes the coach's current buffer against the server's revision", async () => {
    const serverDraft = makeDraft({
      revision: 5,
      sections: [makeSection('someone else typed this')],
    });
    patchDraft.mockRejectedValueOnce(new MockApiError(409, 'Stale revision', { serverDraft }));
    renderProbe('initial text', 0);

    fireEvent.click(screen.getByText('edit'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('conflict');

    patchDraft.mockResolvedValueOnce(
      makeDraft({ revision: 6, sections: [makeSection('edited text')] }),
    );
    await act(async () => {
      fireEvent.click(screen.getByText('keep-mine'));
      await Promise.resolve();
    });

    expect(patchDraft).toHaveBeenLastCalledWith('tetra', 'review-1', {
      expectedRevision: 5,
      sections: [makeSection('edited text')],
      coachPrivateNotes: null,
    });
    expect(screen.getByTestId('status')).toHaveTextContent('saved');
    expect(screen.getByTestId('conflict')).toHaveTextContent('no');
  });

  it('resolveWithServerDraft clears the conflict and adopts the server draft without PATCHing', async () => {
    const serverDraft = makeDraft({
      revision: 5,
      sections: [makeSection('someone else typed this')],
    });
    patchDraft.mockRejectedValueOnce(new MockApiError(409, 'Stale revision', { serverDraft }));
    renderProbe('initial text', 0);

    fireEvent.click(screen.getByText('edit'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('conflict');

    patchDraft.mockClear();
    fireEvent.click(screen.getByText('see-theirs'));

    expect(patchDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('conflict')).toHaveTextContent('no');
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
  });
});
