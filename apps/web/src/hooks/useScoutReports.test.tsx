import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useGenerateReport, useReportsConfig, useScoutReportsList } from './useScoutReports';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

import { AuthProvider } from '@/context/AuthContext';

const reportsConfig = vi.fn();
const reportsGenerate = vi.fn();
const reportsList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    reports: {
      config: (...args: unknown[]) => reportsConfig(...args),
      generate: (...args: unknown[]) => reportsGenerate(...args),
      list: (...args: unknown[]) => reportsList(...args),
    },
  },
}));

const RECORD = {
  id: 'r1',
  createdAt: 1_700_000_000_000,
  model: 'claude-opus-4-8',
  player: { id: 1802316, gamerTag: 'Pandem1c' },
  report: {
    overview: 'overview',
    gameplan: ['plan'],
    stageStrategy: { bans: [], picks: [], reasoning: 'reasoning' },
    headToHead: null,
    watchFor: [],
    confidenceNotes: 'notes',
  },
};

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ConfigProbe() {
  const config = useReportsConfig();
  if (!config.isSuccess) {
    return <div>loading</div>;
  }
  return <div>enabled: {String(config.data.enabled)}</div>;
}

function GenerateProbe() {
  const generate = useGenerateReport();
  return (
    <div>
      <button onClick={() => generate.mutate({ query: 'user/07dc2239' })}>generate</button>
      {generate.isPending && <div>pending</div>}
      {generate.isSuccess && <div>gamerTag: {generate.data.player.gamerTag}</div>}
    </div>
  );
}

function ListProbe() {
  const list = useScoutReportsList();
  if (!list.isSuccess) {
    return <div>loading</div>;
  }
  return <div>reports: {list.data.length}</div>;
}

describe('useScoutReports', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useReportsConfig resolves the config response', async () => {
    reportsConfig.mockResolvedValue({ enabled: true });

    render(
      <Wrapper>
        <ConfigProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('enabled: true')).toBeInTheDocument());
  });

  it('useGenerateReport posts the query and resolves the stored record', async () => {
    reportsGenerate.mockResolvedValue(RECORD);

    render(
      <Wrapper>
        <GenerateProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('generate'));

    await waitFor(() => expect(screen.getByText('gamerTag: Pandem1c')).toBeInTheDocument());
    expect(reportsGenerate).toHaveBeenCalledWith({ query: 'user/07dc2239' });
  });

  it('useScoutReportsList resolves the list response', async () => {
    reportsList.mockResolvedValue([RECORD]);

    render(
      <Wrapper>
        <ListProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('reports: 1')).toBeInTheDocument());
  });
});
