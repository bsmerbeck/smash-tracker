import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct unit tests for `logProductEvent` (Phase 7 share-loop analytics).
 * Every test re-imports the module fresh via `vi.resetModules()` because
 * `initAnalytics`'s memoized promise (`analyticsInit`) is a module-level
 * singleton — without a reset, the first test's resolved value (null or a
 * mocked analytics context) would leak into every later test in this file.
 */

const logEventMock = vi.fn();
const isSupportedMock = vi.fn().mockResolvedValue(true);
const initializeAnalyticsMock = vi.fn().mockReturnValue({});
const setAnalyticsCollectionEnabledMock = vi.fn();

vi.mock('firebase/analytics', () => ({
  isSupported: () => isSupportedMock(),
  initializeAnalytics: (...args: unknown[]) => initializeAnalyticsMock(...args),
  logEvent: (...args: unknown[]) => logEventMock(...args),
  setAnalyticsCollectionEnabled: (...args: unknown[]) => setAnalyticsCollectionEnabledMock(...args),
}));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn().mockReturnValue({}),
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(),
  GoogleAuthProvider: class GoogleAuthProvider {},
}));

const originalWebdriver = Object.getOwnPropertyDescriptor(window.navigator, 'webdriver');

function setWebdriver(value: boolean | undefined) {
  Object.defineProperty(window.navigator, 'webdriver', {
    value,
    configurable: true,
  });
}

describe('logProductEvent', () => {
  beforeEach(() => {
    vi.resetModules();
    logEventMock.mockClear();
    isSupportedMock.mockClear();
    isSupportedMock.mockResolvedValue(true);
    initializeAnalyticsMock.mockClear();
    setAnalyticsCollectionEnabledMock.mockClear();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'test.web.app');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
    vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app-id');
    // Deterministic regardless of test order / jsdom's default (undefined).
    setWebdriver(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalWebdriver) {
      Object.defineProperty(window.navigator, 'webdriver', originalWebdriver);
    }
  });

  it('exports logProductEvent', async () => {
    const mod = await import('./firebase');
    expect(typeof mod.logProductEvent).toBe('function');
  });

  it('resolves without throwing and never calls logEvent when analytics is unavailable (no measurementId configured)', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', undefined);
    const { logProductEvent } = await import('./firebase');

    expect(() => logProductEvent('vod_note_created')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('performs no logEvent call and does not throw under navigator.webdriver = true', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    setWebdriver(true);
    const { logProductEvent } = await import('./firebase');

    expect(() => logProductEvent('share_opened', { share_kind: 'review' })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('logs the event with its params when analytics is available and not under webdriver', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    setWebdriver(false);
    const { logProductEvent } = await import('./firebase');

    logProductEvent('share_opened', { share_kind: 'recap' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logEventMock).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'share_opened', {
      share_kind: 'recap',
    });
  });
});

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-04, D-06,
 * review finding 29-08 HIGH — the stop-ship analytics finding): direct unit
 * tests for `setAnalyticsCollectionEnabled` and its synchronous gating of
 * `logAnalyticsPageView`/`logProductEvent`. Same fresh-module-per-test
 * discipline as `logProductEvent` above (a new `describe` block rather than
 * a shared `beforeEach`, matching this file's existing structure).
 */
describe('setAnalyticsCollectionEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    logEventMock.mockClear();
    isSupportedMock.mockClear();
    isSupportedMock.mockResolvedValue(true);
    initializeAnalyticsMock.mockClear();
    setAnalyticsCollectionEnabledMock.mockClear();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'test.web.app');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
    vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app-id');
    setWebdriver(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalWebdriver) {
      Object.defineProperty(window.navigator, 'webdriver', originalWebdriver);
    }
  });

  it('disabling BEFORE any logger call performs ZERO calls to the analytics module initializer, and both loggers are no-ops (review finding 29-08 HIGH)', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    const { logAnalyticsPageView, logProductEvent, setAnalyticsCollectionEnabled } =
      await import('./firebase');

    setAnalyticsCollectionEnabled(false);
    expect(() => logAnalyticsPageView('/workspace/tenant-1/overview')).not.toThrow();
    expect(() => logProductEvent('vod_note_created')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // isSupportedMock is only reached AFTER initAnalytics' dynamic import
    // step — asserting it was never called proves initAnalytics' body never
    // ran at all, not merely that it bailed out partway through.
    expect(isSupportedMock).not.toHaveBeenCalled();
    expect(initializeAnalyticsMock).not.toHaveBeenCalled();
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('disabling when analytics has NOT yet initialized never calls through to the SDK collection setter (nothing to call through to)', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    const { setAnalyticsCollectionEnabled } = await import('./firebase');

    setAnalyticsCollectionEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setAnalyticsCollectionEnabledMock).not.toHaveBeenCalled();
  });

  it('disabling when analytics IS already initialized calls through to the SDK collection setter on the resolved instance, without re-initializing', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    const { logAnalyticsPageView, setAnalyticsCollectionEnabled } = await import('./firebase');

    // Starts the lazy initializer (collection defaults to enabled).
    logAnalyticsPageView('/dashboard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initializeAnalyticsMock).toHaveBeenCalledTimes(1);

    setAnalyticsCollectionEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setAnalyticsCollectionEnabledMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      false,
    );
    // Still only initialized once — the setter never re-triggers initAnalytics.
    expect(initializeAnalyticsMock).toHaveBeenCalledTimes(1);
  });

  it('re-enabling restores the loggers normal behavior, including lazily initializing on the next call if it never happened', async () => {
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    const { logProductEvent, setAnalyticsCollectionEnabled } = await import('./firebase');

    setAnalyticsCollectionEnabled(false);
    setAnalyticsCollectionEnabled(true);
    expect(initializeAnalyticsMock).not.toHaveBeenCalled();

    logProductEvent('vod_note_created');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(initializeAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'vod_note_created',
      undefined,
    );
  });

  it.each([
    ['no measurementId configured', () => vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', undefined)],
    [
      'navigator.webdriver = true',
      () => {
        vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
        setWebdriver(true);
      },
    ],
    [
      'analytics is unsupported',
      () => {
        vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
        isSupportedMock.mockResolvedValue(false);
      },
    ],
  ])('never throws when %s (fire-and-forget contract)', async (_label, setup) => {
    setup();
    const { logAnalyticsPageView, setAnalyticsCollectionEnabled } = await import('./firebase');

    // Starts the lazy initializer under this condition (resolves to null).
    logAnalyticsPageView('/dashboard');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(() => setAnalyticsCollectionEnabled(false)).not.toThrow();
    expect(() => setAnalyticsCollectionEnabled(true)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
