import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ResearchTelemetrySuppression } from './ResearchTelemetrySuppression';
import { RouteAnalytics } from './RouteAnalytics';

const useResearchSubject = vi.fn();
const setAnalyticsCollectionEnabled = vi.fn();
const logAnalyticsPageView = vi.fn();

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
}));

vi.mock('@/lib/firebase', () => ({
  setAnalyticsCollectionEnabled: (...args: unknown[]) => setAnalyticsCollectionEnabled(...args),
  logAnalyticsPageView: (...args: unknown[]) => logAnalyticsPageView(...args),
}));

function mockStatus(
  overrides: Partial<{ isResearch: boolean; isPending: boolean; isError: boolean }>,
) {
  useResearchSubject.mockReturnValue({
    isResearch: false,
    isPending: false,
    isError: false,
    retry: vi.fn(),
    ...overrides,
  });
}

function renderSuppression(initialEntry = '/coach/tetra/overview') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ResearchTelemetrySuppression />
    </MemoryRouter>,
  );
}

describe('ResearchTelemetrySuppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing', () => {
    mockStatus({});
    const { container } = renderSuppression();
    expect(container).toBeEmptyDOMElement();
  });

  it('disables collection when the active subject is a research tenant', () => {
    mockStatus({ isResearch: true });
    renderSuppression();
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('disables collection while the kind lookup is pending (fail-closed)', () => {
    mockStatus({ isPending: true });
    renderSuppression();
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('disables collection when the kind lookup errored (fail-closed)', () => {
    mockStatus({ isError: true });
    renderSuppression();
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('leaves collection enabled for an ordinary (non-research) workspace', () => {
    mockStatus({});
    renderSuppression();
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('re-enables collection when the session leaves the workspace (outside any client workspace route)', () => {
    mockStatus({});
    renderSuppression('/dashboard');
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('a personal route does not issue a toggle call on every render (no churn across multiple re-renders with unchanged status)', () => {
    mockStatus({});
    const { rerender } = renderSuppression('/dashboard');
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ResearchTelemetrySuppression />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ResearchTelemetrySuppression />
      </MemoryRouter>,
    );

    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledTimes(1);
  });

  it('toggles again when the resolved status transitions from research to ordinary', () => {
    mockStatus({ isResearch: true });
    const { rerender } = renderSuppression();
    expect(setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(false);

    mockStatus({ isResearch: false });
    rerender(
      <MemoryRouter initialEntries={['/coach/tetra/overview']}>
        <ResearchTelemetrySuppression />
      </MemoryRouter>,
    );

    expect(setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(true);
    expect(setAnalyticsCollectionEnabled).toHaveBeenCalledTimes(2);
  });

  /**
   * Review finding 29-08 HIGH: "mount alongside" does not define the
   * required ordering. This test proves the ordering BEHAVIORALLY — by
   * rendering the two router-root components in AppRouter.tsx's actual
   * JSX order (suppression BEFORE RouteAnalytics) and asserting the
   * suppression effect's side effect was recorded before the page-view
   * effect's side effect, rather than asserting against source line numbers
   * alone.
   */
  it('mount-order: the suppression effect runs before the page-view reporter effect on the initial commit', () => {
    mockStatus({});
    const callOrder: string[] = [];
    setAnalyticsCollectionEnabled.mockImplementation(() => {
      callOrder.push('suppression');
    });
    logAnalyticsPageView.mockImplementation(() => {
      callOrder.push('page-view');
    });

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        {/* Mirrors AppRouter.tsx's literal mount order: suppression
            immediately before RouteAnalytics. */}
        <ResearchTelemetrySuppression />
        <RouteAnalytics />
      </MemoryRouter>,
    );

    expect(callOrder).toEqual(['suppression', 'page-view']);
  });
});
