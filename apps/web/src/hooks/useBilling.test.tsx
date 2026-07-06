import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCheckout, useCredits } from './useBilling';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
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

const billingCredits = vi.fn();
const billingCheckout = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    billing: {
      credits: (...args: unknown[]) => billingCredits(...args),
      checkout: (...args: unknown[]) => billingCheckout(...args),
    },
  },
}));

const CREDITS_STATUS = {
  freeAccess: false,
  balance: 4,
  packs: [
    { id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' },
    { id: 'pack15', credits: 15, amountCents: 2000, label: '15 reports' },
  ],
};

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function CreditsProbe() {
  const credits = useCredits();
  if (!credits.isSuccess) {
    return <div>loading</div>;
  }
  return (
    <div>
      balance: {credits.data.balance}, freeAccess: {String(credits.data.freeAccess)}, packs:{' '}
      {credits.data.packs.length}
    </div>
  );
}

function CheckoutProbe() {
  const checkout = useCheckout();
  return (
    <div>
      <button onClick={() => checkout.mutate('pack5')}>checkout</button>
      {checkout.isPending && <div>redirecting</div>}
    </div>
  );
}

describe('useBilling', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useCredits resolves the credits status response', async () => {
    billingCredits.mockResolvedValue(CREDITS_STATUS);

    render(
      <Wrapper>
        <CreditsProbe />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByText('balance: 4, freeAccess: false, packs: 2')).toBeInTheDocument(),
    );
  });

  it('useCheckout posts the packId and redirects the browser to the returned url', async () => {
    billingCheckout.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' });
    const assignSpy = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign: assignSpy });

    render(
      <Wrapper>
        <CheckoutProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('checkout'));

    await waitFor(() => expect(billingCheckout).toHaveBeenCalledWith('pack5'));
    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith('https://checkout.stripe.com/session/abc'),
    );
  });
});
