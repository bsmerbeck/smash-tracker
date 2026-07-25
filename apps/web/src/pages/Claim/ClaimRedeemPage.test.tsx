import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatClaimCodeForDisplay } from '@/lib/claimCodeFormat';
import { ClaimRedeemPage } from './ClaimRedeemPage';

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}));

const claimsRedeem = vi.fn();

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    claims: {
      redeem: (...args: unknown[]) => claimsRedeem(...args),
    },
  },
  ApiError: MockApiError,
}));

const useMatchesMock = vi.fn();
vi.mock('@/hooks/useMatches', () => ({
  useMatches: () => useMatchesMock(),
}));

// First 26 significant characters of CLAIM_CODE_ALPHABET — a shape-valid code
// with no ambiguous glyphs to fold, so normalisation is a pure passthrough.
const VALID_CODE = '0123456789ABCDEFGHJKMNPQRS';
const VALID_CODE_DISPLAY = formatClaimCodeForDisplay(VALID_CODE);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/claim']}>
        <Routes>
          <Route path="/claim" element={<ClaimRedeemPage />} />
          <Route
            path="/workspace/:tenantId/overview"
            element={<div>Workspace overview page</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function enterCode(value: string) {
  fireEvent.change(screen.getByLabelText('Claim code'), { target: { value } });
}

async function goToConfirm(user: ReturnType<typeof userEvent.setup>) {
  enterCode(VALID_CODE);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Before you continue');
}

describe('ClaimRedeemPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMatchesMock.mockReturnValue({ data: [] });
  });

  it('Continue is disabled until the input holds 26 significant characters, enabled at exactly 26', () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    enterCode(VALID_CODE.slice(0, 25));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    enterCode(VALID_CODE);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('typing lowercase letters and separators renders the grouped uppercase form', () => {
    renderPage();

    enterCode('abcde-fghjk');
    expect(screen.getByLabelText('Claim code')).toHaveValue('ABCDE-FGHJK');
  });

  it('Continue moves to the confirmation step and issues no network request', async () => {
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);

    expect(screen.getByText('Nothing changes until you confirm.')).toBeInTheDocument();
    expect(claimsRedeem).not.toHaveBeenCalled();
  });

  it('with an empty personal library, no radio group renders and Confirm is enabled', async () => {
    useMatchesMock.mockReturnValue({ data: [] });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('with a non-empty personal library, a radio group renders with exactly two unselected options and Confirm is disabled', async () => {
    useMatchesMock.mockReturnValue({ data: [{ id: 'm1' }] });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('selecting the keep-both option enables Confirm; confirming calls redeem exactly once with the normalised code', async () => {
    useMatchesMock.mockReturnValue({ data: [{ id: 'm1' }] });
    claimsRedeem.mockResolvedValue({ tenantId: 'tenant-abc' });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('radio', { name: /Keep both/ }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(claimsRedeem).toHaveBeenCalledTimes(1));
    expect(claimsRedeem).toHaveBeenCalledWith(VALID_CODE);
  });

  it('selecting the not-now option and confirming issues NO request and leaves the page in a non-destructive state', async () => {
    useMatchesMock.mockReturnValue({ data: [{ id: 'm1' }] });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('radio', { name: /Not now/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByLabelText('Claim code')).toBeInTheDocument();
    expect(claimsRedeem).not.toHaveBeenCalled();
  });

  it('no control, label, or helper text anywhere on the page offers to fold libraries together', async () => {
    useMatchesMock.mockReturnValue({ data: [{ id: 'm1' }] });
    const user = userEvent.setup();
    const { container } = renderPage();

    await goToConfirm(user);

    expect(container.textContent?.toLowerCase() ?? '').not.toMatch(/merge|combine/);
  });

  it('a 200 response renders the success step with a what-changed callout, fires the success toast, and offers a link to the claimed workspace', async () => {
    claimsRedeem.mockResolvedValue({ tenantId: 'tenant-xyz' });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText("You're all set")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Workspace claimed!');

    await user.click(screen.getByRole('button', { name: 'Go to your workspace' }));
    expect(await screen.findByText('Workspace overview page')).toBeInTheDocument();
  });

  it('after a successful submit, window.location.search is empty and the browser URL never contains the code', async () => {
    claimsRedeem.mockResolvedValue({ tenantId: 'tenant-xyz' });
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await screen.findByText("You're all set");
    expect(window.location.search).toBe('');
  });

  it.each(['invalid_claim_code', 'code_expired', 'code_already_used', 'ownership_conflict'])(
    'a 400 body (message: %s) renders the same generic inline error and returns to the entry step with the typed code retained',
    async (message) => {
      claimsRedeem.mockRejectedValue(new MockApiError(400, message));
      const user = userEvent.setup();
      renderPage();

      await goToConfirm(user);
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(
        await screen.findByText("That code didn't work — check it with your coach."),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Claim code')).toHaveValue(VALID_CODE_DISPLAY);
    },
  );

  it('a 429 renders the distinct too-many-attempts message', async () => {
    claimsRedeem.mockRejectedValue(new MockApiError(429, 'Rate limit exceeded'));
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText('Too many attempts — please try again later.'),
    ).toBeInTheDocument();
  });

  it('a 503 renders the distinct unavailable message', async () => {
    claimsRedeem.mockRejectedValue(new MockApiError(503, 'Service Unavailable'));
    const user = userEvent.setup();
    renderPage();

    await goToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText("Claim codes aren't available right now — please try again later."),
    ).toBeInTheDocument();
  });
});
