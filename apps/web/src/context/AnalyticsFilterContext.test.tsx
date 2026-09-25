import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
  analyticsFilterStorageKey,
} from './AnalyticsFilterContext';
import { AuthContext, type AuthContextValue } from './AuthContext';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { setActiveSubject } from '@/lib/subjectQueryKey';
import { makeMockUser } from '@/test/mockAuth';

function fakeAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    loading: false,
    signInWithEmail: async () => {},
    signUpWithEmail: async () => {},
    signInWithGoogle: async () => {},
    signInWithToken: async () => {},
    signOut: async () => {},
    getIdToken: async () => null,
    changePassword: async () => {},
    sendPasswordReset: async () => {},
    updateDisplayName: async () => {},
    ...overrides,
  };
}

function Probe() {
  const { source, range, setSource, setRange, resetFilters, subjectClientId } =
    useAnalyticsFilter();
  return (
    <div>
      <span data-testid="source">{source}</span>
      <span data-testid="range">{range}</span>
      <span data-testid="subject">{subjectClientId ?? 'personal'}</span>
      <button onClick={() => setSource('startgg')}>set-source</button>
      <button onClick={() => setRange('6m')}>set-range</button>
      <button onClick={() => setRange('3m')}>set-range-3m</button>
      <button onClick={() => setRange('12m')}>set-range-12m</button>
      <button
        onClick={() => {
          setSource('manual');
          setRange('3m');
        }}
      >
        set-both
      </button>
      <button onClick={resetFilters}>reset</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <AnalyticsFilterProvider>
      <Probe />
    </AnalyticsFilterProvider>,
  );
}

function renderProbeWithAuth(authValue: AuthContextValue) {
  return render(
    <AuthContext.Provider value={authValue}>
      <AnalyticsFilterProvider>
        <Probe />
      </AnalyticsFilterProvider>
    </AuthContext.Provider>,
  );
}

describe('AnalyticsFilterContext', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    setActiveSubject({ mode: 'personal', clientId: null });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    setActiveSubject({ mode: 'personal', clientId: null });
  });

  it('defaults to all/all when nothing is persisted', () => {
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('persists source and range changes under the subject-scoped key', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-source'));
    await user.click(screen.getByText('set-range'));

    expect(screen.getByTestId('source')).toHaveTextContent('startgg');
    expect(screen.getByTestId('range')).toHaveTextContent('6m');
    const stored = JSON.parse(
      window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null)) ?? '{}',
    );
    expect(stored).toEqual({ source: 'startgg', range: '6m' });
  });

  it('hydrates initial state from a previously persisted legacy value (one-time personal seed)', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'manual', range: '3m' }),
    );
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('manual');
    expect(screen.getByTestId('range')).toHaveTextContent('3m');
  });

  it('falls back to defaults for malformed JSON in localStorage', () => {
    window.localStorage.setItem(ANALYTICS_FILTER_STORAGE_KEY, '{not valid json');
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('falls back to defaults for a value with an invalid shape', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'not-a-real-source', range: 42 }),
    );
    renderProbe();
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('resetFilters restores defaults and persists them under the scoped key', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-source'));
    await user.click(screen.getByText('set-range'));
    await user.click(screen.getByText('reset'));

    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');
    const stored = JSON.parse(
      window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null)) ?? '{}',
    );
    expect(stored).toEqual({ source: 'all', range: 'all' });
  });

  it('D-08: the scoped key wins over a stored legacy value when both are present', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'manual', range: '3m' }),
    );
    window.localStorage.setItem(
      analyticsFilterStorageKey('anonymous', null),
      JSON.stringify({ source: 'startgg', range: '12m' }),
    );

    renderProbe();

    expect(screen.getByTestId('source')).toHaveTextContent('startgg');
    expect(screen.getByTestId('range')).toHaveTextContent('12m');
  });

  it('D-08: an explicit change does not modify the legacy key, which still holds its original bytes', async () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'manual', range: '3m' }),
    );
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByText('set-range'));

    expect(JSON.parse(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY)!)).toEqual({
      source: 'manual',
      range: '3m',
    });
    expect(
      JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null))!),
    ).toEqual({ source: 'manual', range: '6m' });
  });

  it('mounting twice in a row with the same storage state produces identical stored bytes', () => {
    window.localStorage.setItem(
      analyticsFilterStorageKey('anonymous', null),
      JSON.stringify({ source: 'manual', range: '3m' }),
    );
    const before = window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null));

    const { unmount } = renderProbe();
    unmount();
    renderProbe();

    const after = window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null));
    expect(after).toBe(before);
  });

  it('a setter invoked while the auth context reports loading updates rendered state but persists nothing', async () => {
    const user = userEvent.setup();
    renderProbeWithAuth(fakeAuthValue({ loading: true }));

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    await user.click(screen.getByText('set-range'));

    expect(screen.getByTestId('range')).toHaveTextContent('6m');
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('NEW3-L1: mounting under a subject with no stored record and making no change writes nothing', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderProbe();
    expect(setItemSpy.mock.calls.some((call) => String(call[0]).includes('analyticsFilter'))).toBe(
      false,
    );
    setItemSpy.mockRestore();
  });

  it('H-2: after switching subject, setting the range again lands under the new subject key, leaving the previous subject key untouched', async () => {
    const user = userEvent.setup();
    renderProbe();

    // Personal: set once.
    await user.click(screen.getByText('set-range-3m'));
    expect(
      JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null))!).range,
    ).toBe('3m');

    // Switch to client:c1 inside one act() — the pushState supplies the
    // VALUE the provider's pathname-derived reader picks up, the
    // setActiveSubject call supplies the change NOTIFICATION.
    act(() => {
      window.history.pushState({}, '', '/coach/c1/matchups');
      setActiveSubject({ mode: 'coaching', clientId: 'c1' });
    });
    expect(screen.getByTestId('subject')).toHaveTextContent('c1');

    // Client c1: set again.
    await user.click(screen.getByText('set-range-12m'));

    expect(
      JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('anonymous', 'c1'))!).range,
    ).toBe('12m');
    // The personal key still holds only the FIRST value.
    expect(
      JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null))!).range,
    ).toBe('3m');
  });

  it('settle-on-switch: by the end of the switching act(), the rendered range is the new subject stored value, not the previous one', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      analyticsFilterStorageKey('anonymous', 'c1'),
      JSON.stringify({ source: 'all', range: '12m' }),
    );
    renderProbe();

    await user.click(screen.getByText('set-range-3m'));
    expect(screen.getByTestId('range')).toHaveTextContent('3m');

    act(() => {
      window.history.pushState({}, '', '/coach/c1/matchups');
      setActiveSubject({ mode: 'coaching', clientId: 'c1' });
    });

    expect(screen.getByTestId('subject')).toHaveTextContent('c1');
    expect(screen.getByTestId('range')).toHaveTextContent('12m');
  });

  it('NEW-L1: two setters fired inside one act() both survive in rendered state and in stored bytes', async () => {
    renderProbe();

    await act(async () => {
      screen.getByText('set-both').click();
    });

    expect(screen.getByTestId('source')).toHaveTextContent('manual');
    expect(screen.getByTestId('range')).toHaveTextContent('3m');
    expect(
      JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('anonymous', null))!),
    ).toEqual({ source: 'manual', range: '3m' });
  });

  it('WR-01: a second, never-before-seen account on the same browser does not inherit the first account’s legacy-seeded filter', () => {
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'manual', range: '3m' }),
    );

    // Account A's first-ever personal-scope mount claims the legacy key as
    // its one-time seed.
    const mountA = renderProbeWithAuth(fakeAuthValue({ user: makeMockUser({ uid: 'uid-A' }) }));
    expect(screen.getByTestId('source')).toHaveTextContent('manual');
    expect(screen.getByTestId('range')).toHaveTextContent('3m');
    mountA.unmount();

    // Account B, on the same browser, has never touched analytics filters —
    // their own scoped key doesn't exist yet. Before the WR-01 fix this fell
    // through to the still-intact legacy key and inherited A's choice.
    renderProbeWithAuth(fakeAuthValue({ user: makeMockUser({ uid: 'uid-B' }) }));
    expect(screen.getByTestId('source')).toHaveTextContent('all');
    expect(screen.getByTestId('range')).toHaveTextContent('all');

    // The legacy key itself is untouched — the fix consumes it via a
    // separate claim marker, never by mutating the legacy bytes.
    expect(JSON.parse(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY)!)).toEqual({
      source: 'manual',
      range: '3m',
    });
  });
});
