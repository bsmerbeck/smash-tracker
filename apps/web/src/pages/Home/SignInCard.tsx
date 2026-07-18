import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { getStartggLoginUrl } from '@/lib/api';
import { getAuthErrorMessage } from '@/lib/firebaseErrors';
import { ParryggLoginDialog } from './ParryggLoginDialog';

/**
 * FB-02: Firebase v12's `signInWithPopup` rejection on popup-close is
 * delayed (~7-8s) or, under COOP, may never settle — so abandoning the
 * Google popup silently wedges all four sign-in buttons. This grace timer
 * is a defensive, focus-return-triggered fallback independent of the SDK
 * promise: if the window regains focus (the user closed/abandoned the
 * popup) and the promise is still unsettled after this window, we
 * re-enable the buttons ourselves. Value locked in the 1.5-2s band.
 */
export const POPUP_FOCUS_GRACE_MS = 1800;

const credentialsSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type CredentialsValues = z.infer<typeof credentialsSchema>;

type Mode = 'sign-in' | 'sign-up';

/**
 * Single sign-in/sign-up card with a mode toggle, replacing legacy's
 * separate UserSignIn / UserSignUp dialogs
 * (legacy/src/screens/User/UserSignIn, UserSignUp).
 */
export function SignInCard() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [submitting, setSubmitting] = useState(false);
  const [parryggOpen, setParryggOpen] = useState(false);
  const { signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();

  const form = useForm<CredentialsValues>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });

  // FB-02 stale-closure guard: the catch block below must read the LIVE
  // value at rejection time (which may arrive seconds after the grace timer
  // already fired), never the `submitting` state var from its own closure.
  const settledRef = useRef(false);
  const resetByGraceRef = useRef(false);
  const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupCleanupRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      popupCleanupRef.current?.();
    };
  }, []);

  const onSubmit = async (values: CredentialsValues) => {
    setSubmitting(true);
    try {
      if (mode === 'sign-in') {
        await signInWithEmail(values.email, values.password);
      } else {
        await signUpWithEmail(values.email, values.password);
      }
    } catch (error) {
      toast.error(getAuthErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setSubmitting(true);
    settledRef.current = false;
    resetByGraceRef.current = false;

    const startGraceTimer = () => {
      if (graceTimeoutRef.current) {
        return;
      }
      graceTimeoutRef.current = setTimeout(() => {
        graceTimeoutRef.current = null;
        if (!settledRef.current) {
          resetByGraceRef.current = true;
          if (isMountedRef.current) {
            setSubmitting(false);
          }
        }
      }, POPUP_FOCUS_GRACE_MS);
    };

    const handleFocusReturn = () => startGraceTimer();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startGraceTimer();
      }
    };

    const cleanup = () => {
      if (graceTimeoutRef.current) {
        clearTimeout(graceTimeoutRef.current);
        graceTimeoutRef.current = null;
      }
      window.removeEventListener('focus', handleFocusReturn);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      popupCleanupRef.current = null;
    };
    popupCleanupRef.current = cleanup;

    window.addEventListener('focus', handleFocusReturn);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    try {
      await signInWithGoogle();
      settledRef.current = true;
    } catch (error) {
      settledRef.current = true;
      // Suppress the confusing late toast when the buttons were already
      // silently re-enabled by the grace timer (e.g. popup-closed-by-user
      // arriving 7-8s after the user already retried or moved on).
      if (!resetByGraceRef.current && isMountedRef.current) {
        toast.error(getAuthErrorMessage(error));
      }
    } finally {
      if (isMountedRef.current) {
        setSubmitting(false);
      }
      cleanup();
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</CardTitle>
        <CardDescription>
          {mode === 'sign-in'
            ? 'Sign in to track your Smash matches.'
            : 'Sign up to start tracking your Smash matches.'}
        </CardDescription>
      </CardHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardContent className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="you@example.com"
                      autoComplete="email"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="Your password"
                      autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={submitting}>
              {mode === 'sign-in' ? 'Sign in' : 'Sign up'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={submitting}
              onClick={handleGoogleSignIn}
            >
              Continue with Google
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={submitting}
              onClick={() => window.location.assign(getStartggLoginUrl())}
            >
              Continue with start.gg
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={submitting}
              onClick={() => setParryggOpen(true)}
            >
              Continue with parry.gg
            </Button>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
            >
              {mode === 'sign-in'
                ? "Don't have an account? Sign up"
                : 'Already have an account? Sign in'}
            </button>
          </CardFooter>
        </form>
      </Form>
      <ParryggLoginDialog open={parryggOpen} onOpenChange={setParryggOpen} />
    </Card>
  );
}
