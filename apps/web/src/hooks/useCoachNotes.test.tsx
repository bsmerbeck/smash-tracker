import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useCoachSession,
  useCreateCoachNote,
  useDeleteCoachNote,
  useUpdateCoachNote,
} from './useCoachNotes';

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('useCoachSession', () => {
    it('GETs /api/vod-shares/:token/session and never attaches an auth header', async () => {
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: baseSessionResponse });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useCoachSession('tok123'), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/api/vod-shares/tok123/session');
      expect(init?.headers ?? {}).not.toHaveProperty('Authorization');
      expect(result.current.data?.permissions).toBe('edit');
    });
  });

  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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
});
