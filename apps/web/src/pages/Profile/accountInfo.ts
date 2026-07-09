import type { User as FirebaseUser } from 'firebase/auth';
import type { TFunction } from 'i18next';

/** Which of the three mutually-exclusive Security card states applies to the signed-in user. */
export type SecurityState = 'password' | 'reset-only' | 'no-email';

/**
 * V9 Profile page: smash-tracker has four sign-in methods (email/password,
 * Google, start.gg custom-token, parry.gg bio-code) but only two shapes
 * matter for account security:
 *  - `password`: the user has a `password` provider entry and can change it
 *    directly (reauth + `updatePassword`).
 *  - `reset-only`: the user has an email (Google or start.gg-provisioned
 *    accounts) but no `password` provider — they can only request a reset
 *    email, which ADDS password sign-in.
 *  - `no-email`: parry.gg-created accounts (`parrygg-{parryUserId}` uid) have
 *    neither an email nor any provider; sign-in only happens through parry.gg
 *    bio verification, so no password UI is possible at all.
 */
export function getSecurityState(
  user: Pick<FirebaseUser, 'email' | 'providerData'>,
): SecurityState {
  if (!user.email) {
    return 'no-email';
  }
  const hasPasswordProvider = user.providerData.some((p) => p.providerId === 'password');
  return hasPasswordProvider ? 'password' : 'reset-only';
}

/**
 * Account card's "Sign-in methods" line. Prefers `providerData` (the
 * authoritative source once Firebase has populated it); when it's empty
 * (can happen right after a custom-token sign-in before Firebase backfills
 * provider info) falls back to inferring from which integrations are
 * linked, per the V9 spec.
 */
export function describeSignInMethods(
  user: Pick<FirebaseUser, 'providerData'>,
  links: { startggLinked: boolean; parryggLinked: boolean },
  t: TFunction,
): string {
  const known = user.providerData
    .map((p): string | null => {
      if (p.providerId === 'password') return t('profile.account.methodEmailPassword');
      if (p.providerId === 'google.com') return 'Google';
      return null;
    })
    .filter((label): label is string => label != null);

  if (known.length > 0) {
    return known.join(', ');
  }

  if (links.startggLinked) {
    return 'start.gg';
  }
  if (links.parryggLinked) {
    return t('profile.account.methodParrygg');
  }
  return t('profile.account.methodCustom');
}

/** "<Month year>" from Firebase's `metadata.creationTime` (a `Date`-parseable string), or null if absent. */
export function formatMemberSince(creationTime: string | undefined, locale: string): string | null {
  if (!creationTime) {
    return null;
  }
  const date = new Date(creationTime);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}
