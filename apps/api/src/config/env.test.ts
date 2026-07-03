import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

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
});
