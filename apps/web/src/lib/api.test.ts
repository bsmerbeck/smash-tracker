import { afterEach, describe, expect, it, vi } from 'vitest';
import sourceIndexHtml from '../../index.html?raw';
import { getApiBaseUrl, getDirectApiBaseUrl } from './api';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getApiBaseUrl', () => {
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

describe('getDirectApiBaseUrl', () => {
  it('uses the local base in development even when a deployed direct URL is configured', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001/');
    vi.stubEnv('VITE_API_DIRECT_URL', 'https://deployed-api.example.com');

    expect(getDirectApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('uses and normalizes the configured direct URL outside development', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.stubEnv('VITE_API_DIRECT_URL', 'https://deployed-api.example.com///');

    expect(getDirectApiBaseUrl()).toBe('https://deployed-api.example.com');
  });

  it('falls back to the regular base when no usable direct URL is configured', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE_URL', 'https://fallback-api.example.com/');
    vi.stubEnv('VITE_API_DIRECT_URL', '   ');

    expect(getDirectApiBaseUrl()).toBe('https://fallback-api.example.com');
  });
});

describe('source Content Security Policy', () => {
  it('allows the exact local API loopback origin', () => {
    expect(sourceIndexHtml).toMatch(/connect-src[^;]*http:\/\/localhost:3001(?:[\s;"])/);
  });
});
