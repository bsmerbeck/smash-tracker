import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl } from './api';

describe('getApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the local dev API when VITE_API_BASE_URL is unset', () => {
    vi.stubEnv('VITE_API_BASE_URL', undefined);
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('returns an empty string for same-origin production (explicit empty value)', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(getApiBaseUrl()).toBe('');
  });

  it('strips a trailing slash so joined paths do not double up', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://example.com/');
    expect(getApiBaseUrl()).toBe('https://example.com');
  });

  it('returns a configured absolute base URL unchanged (no trailing slash)', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    expect(getApiBaseUrl()).toBe('https://api.example.com');
  });
});
