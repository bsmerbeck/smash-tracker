import { describe, expect, it } from 'vitest';
import { getInternalJobsConfig, loadEnv, parseCorsOrigins } from './env.js';

const base = {
  FIREBASE_DATABASE_URL: 'https://example-default-rtdb.firebaseio.com',
};

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
