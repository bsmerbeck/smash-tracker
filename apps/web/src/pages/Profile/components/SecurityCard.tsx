import { useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { getAuthErrorMessage } from '@/lib/firebaseErrors';
import { getSecurityState } from '../accountInfo';
import { ChangePasswordForm } from './ChangePasswordForm';

/**
 * Profile > Security: exactly one of three mutually-exclusive states,
 * detected by `getSecurityState` from `user.email` + `user.providerData`:
 *  - `password`  — email/password accounts get the full change-password form.
 *  - `reset-only` — Google and start.gg-provisioned accounts have an email
 *    but no `password` provider; offer a reset email instead (completing it
 *    adds password sign-in alongside their existing method).
 *  - `no-email`  — parry.gg accounts (`parrygg-{parryUserId}` uid) have no
 *    email and no providers at all; no password flow is possible.
 */
export function SecurityCard({ user }: { user: FirebaseUser }) {
  const { t } = useTranslation();
  const state = getSecurityState(user);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.security.title')}</CardTitle>
        <CardDescription>
          {state === 'password' && t('profile.security.descPassword')}
          {state === 'reset-only' && t('profile.security.descResetOnly')}
          {state === 'no-email' && t('profile.security.descNoEmail')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state === 'password' && <ChangePasswordForm />}
        {state === 'reset-only' && <ResetOnlySecurity email={user.email!} />}
        {state === 'no-email' && <NoEmailSecurity />}
      </CardContent>
    </Card>
  );
}

/** Google / start.gg-provisioned accounts: no `password` provider, so offer a reset email instead of a change form. */
function ResetOnlySecurity({ email }: { email: string }) {
  const { t } = useTranslation();
  const { sendPasswordReset } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  async function handleSend() {
    setSubmitting(true);
    setResult(null);
    try {
      await sendPasswordReset(email);
      setResult({
        kind: 'success',
        message: t('profile.security.resetSent', { email }),
      });
    } catch (error) {
      setResult({ kind: 'error', message: getAuthErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('profile.security.resetExplainer')}</p>
      <Button type="button" onClick={handleSend} disabled={submitting} className="self-start">
        {submitting ? t('profile.security.sending') : t('profile.security.sendReset')}
      </Button>
      {result && (
        <p className={`text-sm ${result.kind === 'error' ? 'text-destructive' : ''}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}

/** parry.gg accounts: no email, no providers — sign-in only happens through parry.gg bio verification. */
function NoEmailSecurity() {
  return (
    <p className="text-sm text-muted-foreground">
      <Trans
        i18nKey="profile.security.noEmailBody"
        components={{
          integrationsLink: (
            <Link to="/settings/integrations" className="underline underline-offset-4" />
          ),
        }}
      />
    </p>
  );
}
