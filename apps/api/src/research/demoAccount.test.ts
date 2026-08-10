import { describe, expect, it } from 'vitest';
import { getDemoAccountConfig, type Env } from '../config/env.js';
import { isDemoAccountSubject } from './demoAccount.js';

/**
 * Phase 30.1 Plan 03 (RTEN-03 re-scope, review H4, Task 1): proves
 * `getDemoAccountConfig`'s config-null branches (mirroring
 * `getResearchConfig` exactly) and `isDemoAccountSubject`'s membership
 * logic, including the null-config ⇒ false branch (enforcement inactive).
 */

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    HOST: '0.0.0.0',
    FIREBASE_DATABASE_URL: 'https://example.firebaseio.com',
    CORS_ORIGIN: 'http://localhost:5173',
    WEB_BASE_URL: 'http://localhost:5173',
    ...overrides,
  } as Env;
}

describe('getDemoAccountConfig', () => {
  it('returns null when DEMO_ACCOUNT_UIDS is unset', () => {
    expect(getDemoAccountConfig(baseEnv())).toBeNull();
  });

  it('returns null when DEMO_ACCOUNT_UIDS is an empty string', () => {
    expect(getDemoAccountConfig(baseEnv({ DEMO_ACCOUNT_UIDS: '' }))).toBeNull();
  });

  it('returns null when DEMO_ACCOUNT_UIDS contains only separators/whitespace', () => {
    expect(getDemoAccountConfig(baseEnv({ DEMO_ACCOUNT_UIDS: ' , , ,  ' }))).toBeNull();
  });

  it('returns a DemoAccountConfig with trimmed, non-empty uids when set', () => {
    const config = getDemoAccountConfig(
      baseEnv({ DEMO_ACCOUNT_UIDS: 'uid-hbox, uid-mkleo ,uid-sparg0,,uid-izaw' }),
    );
    expect(config).not.toBeNull();
    expect(config!.demoUids).toEqual(new Set(['uid-hbox', 'uid-mkleo', 'uid-sparg0', 'uid-izaw']));
  });
});

describe('isDemoAccountSubject', () => {
  it('returns false when config is null (enforcement inactive)', () => {
    expect(isDemoAccountSubject(null, 'any-uid')).toBe(false);
  });

  it('returns true only for a uid present in the allowlist', () => {
    const config = getDemoAccountConfig(baseEnv({ DEMO_ACCOUNT_UIDS: 'uid-a,uid-b' }));
    expect(isDemoAccountSubject(config, 'uid-a')).toBe(true);
    expect(isDemoAccountSubject(config, 'uid-b')).toBe(true);
    expect(isDemoAccountSubject(config, 'uid-c')).toBe(false);
  });
});
