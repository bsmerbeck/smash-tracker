import { describe, expect, it } from 'vitest';
import type { UserInfo } from 'firebase/auth';
import i18n from '@/i18n';
import { describeSignInMethods, formatMemberSince, getSecurityState } from './accountInfo';

/** Minimal `UserInfo`-shaped provider entry for `providerData` arrays in tests. */
function provider(providerId: string): UserInfo {
  return {
    providerId,
    uid: 'provider-uid',
    displayName: null,
    email: null,
    phoneNumber: null,
    photoURL: null,
  };
}

describe('getSecurityState', () => {
  it('returns "password" when the user has a password provider', () => {
    expect(getSecurityState({ email: 'a@example.com', providerData: [provider('password')] })).toBe(
      'password',
    );
  });

  it('returns "reset-only" for an email account without a password provider (Google/start.gg)', () => {
    expect(
      getSecurityState({ email: 'a@example.com', providerData: [provider('google.com')] }),
    ).toBe('reset-only');
    expect(getSecurityState({ email: 'a@example.com', providerData: [] })).toBe('reset-only');
  });

  it('returns "no-email" for parry.gg accounts with no email and no providers', () => {
    expect(getSecurityState({ email: null, providerData: [] })).toBe('no-email');
  });
});

describe('describeSignInMethods', () => {
  it('maps password + google provider entries to friendly labels', () => {
    expect(
      describeSignInMethods(
        { providerData: [provider('password'), provider('google.com')] },
        { startggLinked: false, parryggLinked: false },
        i18n.t,
      ),
    ).toBe('Email & password, Google');
  });

  it('infers start.gg when providerData is empty but a start.gg account is linked', () => {
    expect(
      describeSignInMethods(
        { providerData: [] },
        { startggLinked: true, parryggLinked: false },
        i18n.t,
      ),
    ).toBe('start.gg');
  });

  it('infers parry.gg verification when providerData is empty but parry.gg is linked', () => {
    expect(
      describeSignInMethods(
        { providerData: [] },
        { startggLinked: false, parryggLinked: true },
        i18n.t,
      ),
    ).toBe('parry.gg verification');
  });

  it('falls back to "Custom sign-in" when nothing is known or linked', () => {
    expect(
      describeSignInMethods(
        { providerData: [] },
        { startggLinked: false, parryggLinked: false },
        i18n.t,
      ),
    ).toBe('Custom sign-in');
  });
});

describe('formatMemberSince', () => {
  it('formats a creationTime string as "Month Year"', () => {
    expect(formatMemberSince('Mon, 05 Jan 2026 00:00:00 GMT', 'en')).toBe('January 2026');
  });

  it('formats with the given locale', () => {
    expect(formatMemberSince('Mon, 05 Jan 2026 00:00:00 GMT', 'es')).toBe('enero de 2026');
  });

  it('returns null when creationTime is missing or unparseable', () => {
    expect(formatMemberSince(undefined, 'en')).toBeNull();
    expect(formatMemberSince('not a date', 'en')).toBeNull();
  });
});
