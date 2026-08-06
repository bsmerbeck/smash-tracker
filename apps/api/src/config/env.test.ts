import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getClaimCodeConfig,
  getInternalJobsConfig,
  getPrepPaidConfig,
  loadEnv,
  parseCorsOrigins,
} from './env.js';

const base = {
  FIREBASE_DATABASE_URL: 'https://example-default-rtdb.firebaseio.com',
};

describe('API development startup', () => {
  it('loads the workspace-local env file before starting the watch entry point', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: { dev: string } };

    expect(packageJson.scripts.dev).toBe('tsx watch --env-file=.env src/index.ts');
  });
});

describe('loadEnv', () => {
  it('applies defaults for optional vars', () => {
    const env = loadEnv(base);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
  });

  it('coerces PORT to a number', () => {
    const env = loadEnv({ ...base, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('throws a readable error when FIREBASE_DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(/FIREBASE_DATABASE_URL/);
  });

  it('accepts emulator host configuration without credentials', () => {
    const env = loadEnv({
      ...base,
      FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000',
    });
    expect(env.FIREBASE_DATABASE_EMULATOR_HOST).toBe('127.0.0.1:9000');
  });

  it('does not require GOOGLE_APPLICATION_CREDENTIALS (Cloud Run uses ADC)', () => {
    const env = loadEnv(base);
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });
});

describe('parseCorsOrigins', () => {
  it('splits a comma-separated list into trimmed origins', () => {
    expect(
      parseCorsOrigins(
        'https://smash-tracker-f97b7.web.app, https://smash-tracker-f97b7.firebaseapp.com',
      ),
    ).toEqual([
      'https://smash-tracker-f97b7.web.app',
      'https://smash-tracker-f97b7.firebaseapp.com',
    ]);
  });

  it('returns a single-element array for a single origin', () => {
    expect(parseCorsOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('drops empty entries', () => {
    expect(parseCorsOrigins('http://localhost:5173,,')).toEqual(['http://localhost:5173']);
  });
});

describe('getInternalJobsConfig', () => {
  it('returns null when INTERNAL_JOBS_SECRET is unset', () => {
    const env = loadEnv(base);
    expect(getInternalJobsConfig(env)).toBeNull();
  });

  it('returns the secret when INTERNAL_JOBS_SECRET is set', () => {
    const env = loadEnv({ ...base, INTERNAL_JOBS_SECRET: 'shh-scheduler-secret' });
    expect(getInternalJobsConfig(env)).toEqual({ secret: 'shh-scheduler-secret' });
  });
});

describe('getClaimCodeConfig', () => {
  it('returns null when CLAIM_CODE_HMAC_SECRET is unset', () => {
    const env = loadEnv(base);
    expect(getClaimCodeConfig(env)).toBeNull();
  });

  it('returns the secret when CLAIM_CODE_HMAC_SECRET is set', () => {
    const env = loadEnv({ ...base, CLAIM_CODE_HMAC_SECRET: 'shh-claim-secret' });
    expect(getClaimCodeConfig(env)).toEqual({ hmacSecret: 'shh-claim-secret' });
  });
});

describe('getPrepPaidConfig (RPT-04, exact-string activation gate)', () => {
  it('returns null when PREP_PAID_REPORTS_ENABLED is unset', () => {
    const env = loadEnv(base);
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns null for the uppercase spelling "TRUE"', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: 'TRUE' });
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns null for "1"', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: '1' });
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns null for "yes"', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: 'yes' });
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns null for "on"', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: 'on' });
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns null for a whitespace-padded value (" true ")', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: ' true ' });
    expect(getPrepPaidConfig(env)).toBeNull();
  });

  it('returns a non-null config for the exact enabling value "true"', () => {
    const env = loadEnv({ ...base, PREP_PAID_REPORTS_ENABLED: 'true' });
    expect(getPrepPaidConfig(env)).toEqual({ enabled: true });
  });
});
