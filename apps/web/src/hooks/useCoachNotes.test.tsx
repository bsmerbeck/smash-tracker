import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  useCoachSession,
  useCreateCoachNote,
  useDeleteCoachNote,
  useUpdateCoachNote,
} from './useCoachNotes';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const baseSessionResponse = {
  createdAt: 1_700_000_000_000,
  permissions: 'edit',
  result: 'win',
  fighterId: 1,
  opponentFighterId: 10,
  matchDate: 1_700_000_000_000,
  vodUrl: 'https://youtube.com/watch?v=abc123',
  reviewedMomentsCount: 1,
  timestamps: [{ seconds: 10, note: 'First punish', id: 'note-1' }],
  redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
};

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: unknown;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? '',
    text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
  });
}

describe('useCoachNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  describe('useCoachSession', () => {
    it('GETs /api/vod-shares/:token/session with the caller sessionId as a query param (WR-02) and never attaches an auth header', async () => {
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: baseSessionResponse });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useCoachSession('tok123', SESSION_ID), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain(`/api/vod-shares/tok123/session?sessionId=${SESSION_ID}`);
      expect(init?.headers ?? {}).not.toHaveProperty('Authorization');
      expect(result.current.data?.permissions).toBe('edit');
    });
  });

  describe('useCreateCoachNote', () => {
    it('POSTs sessionId + displayName in the request BODY', async () => {
      const fetchMock = mockFetchOnce({
        ok: true,
        status: 201,
        body: {
          id: 'note-2',
          seconds: 42,
          note: 'nice read',
          coach: { sessionId: SESSION_ID, displayName: 'Coach Ken' },
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useCreateCoachNote('tok123'), { wrapper: Wrapper });

      await result.current.mutateAsync({
        sessionId: SESSION_ID,
        displayName: 'Coach Ken',
        seconds: 42,
        note: 'nice read',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe('http://localhost:3001/api/vod-shares/tok123/notes');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        sessionId: SESSION_ID,
        displayName: 'Coach Ken',
        seconds: 42,
        note: 'nice read',
      });
    });
  });

  describe('useUpdateCoachNote', () => {
    it('PATCHes sessionId in the request BODY, addressed by noteId', async () => {
      const fetchMock = mockFetchOnce({
        ok: true,
        status: 200,
        body: {
          id: 'note-1',
          seconds: 10,
          note: 'updated',
          coach: { sessionId: SESSION_ID, displayName: 'Coach Ken' },
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useUpdateCoachNote('tok123'), { wrapper: Wrapper });

      await result.current.mutateAsync({
        noteId: 'note-1',
        input: { sessionId: SESSION_ID, tags: ['punish'] },
      });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe('http://localhost:3001/api/vod-shares/tok123/notes/note-1');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init?.body as string)).toEqual({
        sessionId: SESSION_ID,
        tags: ['punish'],
      });
    });
  });

  describe('useDeleteCoachNote', () => {
    it('sends sessionId as a QUERY PARAM, never a DELETE body', async () => {
      const fetchMock = mockFetchOnce({ ok: true, status: 204 });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useDeleteCoachNote('tok123'), { wrapper: Wrapper });

      await result.current.mutateAsync({ noteId: 'note-1', sessionId: SESSION_ID });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(
        `http://localhost:3001/api/vod-shares/tok123/notes/note-1?sessionId=${SESSION_ID}`,
      );
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBeUndefined();
    });
  });

  // Review WR-03: coach writes must never fail silently — a revoked/expired
  // token mid-session, the 20-note cap 403, a rate-limit 429, or a
  // validation 400 all discard the coach's work; every one now toasts.
  describe('coach write failure toasts (WR-03)', () => {
    it('toasts the share-gone message when a create fails with 404 (revoked/expired mid-session)', async () => {
      const fetchMock = mockFetchOnce({
        ok: false,
        status: 404,
        body: {
          error: 'Not Found',
          message: 'This share is no longer available',
          statusCode: 404,
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useCreateCoachNote('tok123'), { wrapper: Wrapper });

      await expect(
        result.current.mutateAsync({
          sessionId: SESSION_ID,
          displayName: 'Coach Ken',
          seconds: 1,
          note: 'x',
        }),
      ).rejects.toThrow();

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "This coaching link is no longer available — your change wasn't saved.",
        ),
      );
    });

    it('toasts the generic save-failed message for a non-404 failure (e.g. the cap 403)', async () => {
      const fetchMock = mockFetchOnce({
        ok: false,
        status: 403,
        body: {
          error: 'Forbidden',
          message: 'This review already has the maximum number of notes',
          statusCode: 403,
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useCreateCoachNote('tok123'), { wrapper: Wrapper });

      await expect(
        result.current.mutateAsync({
          sessionId: SESSION_ID,
          displayName: 'Coach Ken',
          seconds: 1,
          note: 'x',
        }),
      ).rejects.toThrow();

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to save VOD notes. Please try again.'),
      );
    });

    it('toasts when an update fails', async () => {
      const fetchMock = mockFetchOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useUpdateCoachNote('tok123'), { wrapper: Wrapper });

      await expect(
        result.current.mutateAsync({ noteId: 'note-1', input: { sessionId: SESSION_ID } }),
      ).rejects.toThrow();

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('toasts when a delete fails', async () => {
      const fetchMock = mockFetchOnce({
        ok: false,
        status: 404,
        body: {
          error: 'Not Found',
          message: 'This share is no longer available',
          statusCode: 404,
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useDeleteCoachNote('tok123'), { wrapper: Wrapper });

      await expect(
        result.current.mutateAsync({ noteId: 'note-1', sessionId: SESSION_ID }),
      ).rejects.toThrow();

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "This coaching link is no longer available — your change wasn't saved.",
        ),
      );
    });
  });
});
