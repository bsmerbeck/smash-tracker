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

vi.mock('firebase/analytics', () => ({
  isSupported: () => isSupportedMock(),
  initializeAnalytics: (...args: unknown[]) => initializeAnalyticsMock(...args),
  logEvent: (...args: unknown[]) => logEventMock(...args),
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
