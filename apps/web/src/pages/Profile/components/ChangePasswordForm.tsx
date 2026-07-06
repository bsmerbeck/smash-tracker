import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
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

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(6, 'Password should be at least 6 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

/** Maps the Firebase Auth error codes this flow can hit to a friendly inline message. */
function describePasswordChangeError(error: unknown): string {
  const code = hasCode(error) ? error.code : undefined;
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Current password is incorrect.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/requires-recent-login':
      return 'For your security, please sign out and sign back in, then try again.';
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Please try again.';
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
  const { changePassword } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = async (values: ChangePasswordValues) => {
    setFormError(null);
    setSubmitting(true);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      toast.success('Password updated!');
      form.reset();
    } catch (error) {
      setFormError(describePasswordChangeError(error));
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
              <FormLabel>Current password</FormLabel>
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
              <FormLabel>New password</FormLabel>
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
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? 'Updating…' : 'Change password'}
        </Button>
      </form>
    </Form>
  );
}
