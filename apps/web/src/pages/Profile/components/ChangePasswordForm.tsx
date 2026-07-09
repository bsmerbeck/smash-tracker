import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';

/** A factory (not a module constant) so validation messages come out of the active locale — same pattern as `buildMatchFormSchema`. */
function buildChangePasswordSchema(t: TFunction) {
  return z
    .object({
      currentPassword: z.string().min(1, t('profile.password.currentRequired')),
      newPassword: z.string().min(6, t('profile.password.minLength')),
      confirmPassword: z.string().min(1, t('profile.password.confirmRequired')),
    })
    .refine((values) => values.newPassword === values.confirmPassword, {
      message: t('profile.password.mismatch'),
      path: ['confirmPassword'],
    });
}

type ChangePasswordValues = z.infer<ReturnType<typeof buildChangePasswordSchema>>;

/** Maps the Firebase Auth error codes this flow can hit to a friendly inline message. */
function describePasswordChangeError(error: unknown, t: TFunction): string {
  const code = hasCode(error) ? error.code : undefined;
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return t('profile.password.wrongCurrent');
    case 'auth/weak-password':
      return t('profile.password.weak');
    case 'auth/requires-recent-login':
      return t('profile.password.requiresRecentLogin');
    default:
      return error instanceof Error && error.message
        ? error.message
        : t('profile.password.genericError');
  }
}

function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

/**
 * Profile > Security "change password" form for accounts with the
 * `password` provider. Flow: reauthenticate with the current password (via
 * `AuthContext.changePassword`, which wraps `reauthenticateWithCredential` +
 * `updatePassword`), then reset the form on success.
 */
export function ChangePasswordForm() {
  const { t } = useTranslation();
  const { changePassword } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(buildChangePasswordSchema(t)),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = async (values: ChangePasswordValues) => {
    setFormError(null);
    setSubmitting(true);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      toast.success(t('profile.password.updated'));
      form.reset();
    } catch (error) {
      setFormError(describePasswordChangeError(error, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('profile.password.currentLabel')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('profile.password.newLabel')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('profile.password.confirmLabel')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? t('profile.password.updating') : t('profile.password.submit')}
        </Button>
      </form>
    </Form>
  );
}
