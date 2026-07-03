import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, exchangeCode, signState, verifyState } from './oauth.js';

const SECRET = 'test-state-secret';
const CONFIG = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  stateSecret: SECRET,
};

describe('signState / verifyState', () => {
  it('round-trips a link state with uid', () => {
    const state = signState(SECRET, 'link', 'uid-1');
    const payload = verifyState(SECRET, state);
    expect(payload).toMatchObject({ m: 'link', u: 'uid-1' });
  });

  it('round-trips a login state without uid', () => {
    const state = signState(SECRET, 'login');
    const payload = verifyState(SECRET, state);
    expect(payload).toMatchObject({ m: 'login' });
    expect(payload?.u).toBeUndefined();
  });

  it('rejects a tampered payload', () => {
    const state = signState(SECRET, 'link', 'uid-1');
    const [encoded, signature] = state.split('.') as [string, string];
    const tampered = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { u: string };
    tampered.u = 'attacker-uid';
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;
    expect(verifyState(SECRET, forged)).toBeNull();
  });

  it('rejects a state signed with a different secret', () => {
    const state = signState('other-secret', 'login');
    expect(verifyState(SECRET, state)).toBeNull();
  });

  it('rejects an expired state', () => {
    const state = signState(SECRET, 'login', undefined, Date.now() - 11 * 60 * 1000);
    expect(verifyState(SECRET, state)).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(verifyState(SECRET, 'not-a-state')).toBeNull();
    expect(verifyState(SECRET, 'a.b')).toBeNull();
    expect(verifyState(SECRET, '')).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes client id, scopes, redirect uri, and state', () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, 'the-state'));
    expect(url.origin + url.pathname).toBe('https://start.gg/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('scope')).toBe('user.identity user.email');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBe('the-state');
  });
});

describe('exchangeCode', () => {
  it('POSTs the authorization code and parses tokens', async () => {
    const fetchMock = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://api.start.gg/oauth/access_token');
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.grant_type).toBe('authorization_code');
      expect(body.code).toBe('auth-code');
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }));
    };
    const tokens = await exchangeCode(CONFIG, 'auth-code', fetchMock as typeof fetch);
    expect(tokens.access_token).toBe('at');
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = async () => new Response('nope', { status: 400 });
    await expect(exchangeCode(CONFIG, 'bad', fetchMock as typeof fetch)).rejects.toThrow('400');
  });
});
