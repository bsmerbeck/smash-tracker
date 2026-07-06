import { useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { Link } from 'react-router';
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
  const state = getSecurityState(user);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>
          {state === 'password' && 'Change the password you use to sign in.'}
          {state === 'reset-only' && 'Add password sign-in to your account.'}
          {state === 'no-email' && 'How your account signs in.'}
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
        message: `Reset email sent to ${email}. Follow the link to add password sign-in.`,
      });
    } catch (error) {
      setResult({ kind: 'error', message: getAuthErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        You currently sign in without a password. Sending a password reset email lets you set one
        up, so you can also sign in with your email and a password going forward.
      </p>
      <Button type="button" onClick={handleSend} disabled={submitting} className="self-start">
        {submitting ? 'Sending…' : 'Send password reset email'}
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
      Your account has no password or email — sign-in works through parry.gg profile verification.
      Manage that link from{' '}
      <Link to="/settings/integrations" className="underline underline-offset-4">
        Integrations
      </Link>
      .
    </p>
  );
}
