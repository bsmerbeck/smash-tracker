import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';

/**
 * Landing point for "login with start.gg": the API redirects here with a
 * Firebase custom token in the URL fragment (fragments never reach servers
 * or logs). Signs in with it and heads to the dashboard.
 */
export function StartggAuthPage() {
  const { signInWithToken } = useAuth();
  const navigate = useNavigate();
  // Read the fragment once, at first render — no token means instant failure
  // state (derived, not set in an effect).
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  const [failed, setFailed] = useState(token == null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) {
      return;
    }
    attempted.current = true;

    // Clear the token from the address bar before doing anything else.
    window.history.replaceState(null, '', window.location.pathname);

    signInWithToken(token)
      .then(() => navigate('/dashboard', { replace: true }))
      .catch(() => setFailed(true));
  }, [token, signInWithToken, navigate]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">start.gg sign-in failed</h1>
        <p className="max-w-md text-muted-foreground">
          The sign-in link was missing or expired. Head back home and try again.
        </p>
        <Button asChild>
          <Link to="/">Back to Home</Link>
        </Button>
      </div>
    );
  }

  return <div className="py-16 text-center text-muted-foreground">Signing you in…</div>;
}
